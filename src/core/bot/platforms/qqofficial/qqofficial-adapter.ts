import { Platform, requestUrl } from 'obsidian'

import type { BotPlatformQqOfficialConfig } from '../../../../settings/schema/setting.types'
import { splitTextAtBoundaries } from '../../text-chunking'
import {
  type DownloadedFile,
  type ErrorHandler,
  type MessageComponent,
  type MessageHandler,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformErrorContext,
  type PlatformMessageEvent,
  type PlatformMetadata,
  type ReplyContent,
  type SentMessageRef,
  type StreamReplyHandle,
  decodeSessionKey,
  encodeSessionKey,
} from '../../types'

type GatewayPayload = {
  op: number
  d?: Record<string, unknown>
  s?: number
  t?: string
}
const API = 'https://api.sgroup.qq.com'

const RECONNECT_BASE_DELAY_MS = 10_000
const RECONNECT_MAX_DELAY_MS = 300_000
const STABLE_CONNECTION_MS = 300_000

const errorOf = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value))

const stringValue = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return String(value)
  return fallback
}

export class QQOfficialAdapter implements PlatformAdapter {
  readonly meta: PlatformMetadata = {
    name: 'qq_official',
    displayName: 'QQ Bot',
    description: 'QQ Gateway adapter.',
    version: '1.0.0',
  }
  readonly capabilities: PlatformCapabilities = {
    markdownMode: 'basic',
    supportsImage: false,
    supportsFile: false,
    supportsStreaming: false,
    maxMessageLength: 2000,
    maxImageSize: 0,
    maxFileSize: 0,
  }
  private ws: WebSocket | null = null
  private status: 'running' | 'stopped' | 'degraded' | 'failed' = 'stopped'
  private readonly messageHandlers: MessageHandler[] = []
  private readonly errorHandlers: ErrorHandler[] = []
  private config: BotPlatformQqOfficialConfig | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private sequence: number | undefined
  private stopping = false
  private gatewayUrl: string | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Monotonically increasing message sequence (B5): QQ uses msg_seq for
   * message dedup, so a random value can collide and silently drop a reply.
   * Per-adapter-instance counter, incremented on every sent message.
   */
  private msgSeq = 0

  async start(config: BotPlatformQqOfficialConfig): Promise<void> {
    if (Platform.isMobile)
      throw new Error('The QQ bot platform is desktop-only.')
    if (!config.appId || !config.appSecret)
      throw new Error('QQ App ID and App Secret are required.')
    this.config = config
    this.stopping = false
    this.reconnectAttempt = 0
    const gateway = await requestUrl({
      url: `${API}/gateway/bot`,
      headers: this.headers(),
    })
    // B2: a stop() that landed while the gateway fetch was in flight must not
    // open a socket that resurrects the adapter (same guard as Feishu's
    // handshake path).
    if (this.stopping) return
    const url = gateway.json?.url
    if (typeof url !== 'string')
      throw new Error('QQ Gateway URL is unavailable.')
    this.gatewayUrl = url
    this.openConnection(url)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearStableTimer()
    this.ws?.close()
    this.ws = null
    this.status = 'stopped'
  }
  health() {
    return this.status
  }

  async sendMessage(
    sessionKey: string,
    content: ReplyContent,
  ): Promise<SentMessageRef[]> {
    const { chatType, chatId } = decodeSessionKey(sessionKey)
    const text = content.text?.trim()
    if (!text) return []
    const endpoint =
      chatType === 'private'
        ? `/v2/users/${encodeURIComponent(chatId)}/messages`
        : `/v2/groups/${encodeURIComponent(chatId)}/messages`
    const refs: SentMessageRef[] = []
    // B4: chunk long replies to the platform cap (2000) — the QQ API rejects
    // oversized message bodies instead of truncating.
    for (const chunk of splitTextAtBoundaries(
      text,
      this.capabilities.maxMessageLength,
    )) {
      // B5: msg_seq is monotonic per adapter instance (message dedup on the
      // QQ side) — random values could collide and drop a reply.
      this.msgSeq += 1
      const body: Record<string, unknown> = {
        content: chunk,
        msg_type: 0,
        msg_seq: this.msgSeq,
      }
      if (content.replyToMessageId) body.msg_id = content.replyToMessageId
      const response = await requestUrl({
        url: `${API}${endpoint}`,
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      refs.push({
        platformMessageId: String(response.json?.id ?? Date.now()),
        sessionKey,
        timestamp: Date.now(),
      })
    }
    return refs
  }

  sendStreamingMessage(_sessionKey: string): StreamReplyHandle {
    throw new Error('QQ bot streaming is not supported.')
  }
  async downloadFile(_component: MessageComponent): Promise<DownloadedFile> {
    throw new Error('QQ bot file downloads are not supported.')
  }
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler)
    return () => {
      const index = this.messageHandlers.indexOf(handler)
      if (index >= 0) this.messageHandlers.splice(index, 1)
    }
  }
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.push(handler)
    return () => {
      const index = this.errorHandlers.indexOf(handler)
      if (index >= 0) this.errorHandlers.splice(index, 1)
    }
  }

  private headers(): Record<string, string> {
    const config = this.config
    if (!config) return {}
    return { Authorization: `QQBot ${config.appId}.${config.appSecret}` }
  }
  private handleGatewayPayload(payload: GatewayPayload): void {
    if (payload.s !== undefined) this.sequence = payload.s
    if (payload.op === 10) {
      const interval = Number(payload.d?.heartbeat_interval ?? 0)
      this.sendGateway({
        op: 2,
        d: {
          token: this.headers().Authorization,
          intents: this.intents(),
          shard: [0, 1],
        },
      })
      // The hello handshake is the "connection open" moment: the session is
      // live and identified, so the adapter is running and the reconnect
      // backoff resets after a stable period (same policy as Feishu/DingTalk).
      this.status = 'running'
      this.reconnectAttempt = 0
      this.clearStableTimer()
      this.stableTimer = setTimeout(() => {
        this.reconnectAttempt = 0
      }, STABLE_CONNECTION_MS)
      if (interval > 0)
        this.heartbeat = setInterval(
          () =>
            this.sendGateway({
              op: 1,
              d:
                this.sequence === undefined
                  ? undefined
                  : { sequence: this.sequence },
            }),
          interval,
        )
      return
    }
    if (payload.op === 0 && payload.d && payload.t)
      this.handleDispatch(payload.t, payload.d)
    if (payload.op === 9)
      this.fail(new Error('QQ Gateway invalid session.'), {
        operation: 'receive',
        retryable: false,
      })
  }

  private openConnection(url: string): void {
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onmessage = (event) => {
      try {
        this.handleGatewayPayload(
          JSON.parse(String(event.data)) as GatewayPayload,
        )
      } catch (error) {
        this.fail(errorOf(error), {
          operation: 'receive',
          retryable: true,
          raw: event.data,
        })
      }
    }
    ws.onerror = () =>
      this.fail(new Error('QQ Gateway connection error.'), {
        operation: 'receive',
        retryable: true,
      })
    ws.onclose = () => this.handleClose()
  }

  private handleClose(): void {
    this.ws = null
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.clearStableTimer()
    if (this.stopping) {
      this.status = 'stopped'
      return
    }
    this.status = 'degraded'
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer || !this.gatewayUrl) return
    this.reconnectAttempt += 1
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS,
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openConnection(this.gatewayUrl!)
    }, delay)
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
  }
  /**
   * QQ Gateway intent bits (B1, fix-round-1). Official bit table (QQ open
   * platform docs, cross-checked against tencent-connect/bot-node-sdk):
   * GUILD_MESSAGES = 1<<9 (channel @-messages, `AT_MESSAGE_CREATE`),
   * DIRECT_MESSAGE = 1<<12 (channel private messages,
   * `DIRECT_MESSAGE_CREATE`), GROUP_AND_C2C_EVENT = 1<<25 (group @-messages
   * AND C2C messages — a single bit, so enableC2c/enableGroup cannot be set
   * independently at the intent level; the per-channel enable switches gate
   * dispatch handling in handleDispatch instead). The old code mapped
   * enableGuild to 1<<9 under the mistaken name GUILDS — that bit IS
   * GUILD_MESSAGES, so channel @-messages worked before; the fix keeps
   * 1<<9 and adds 1<<12 for channel private messages (1<<13 has no
   * corresponding event in the official bit table).
   */
  private intents(): number {
    const c = this.config
    return (
      (c?.enableGuild ? (1 << 9) | (1 << 12) : 0) | // GUILD_MESSAGES | DIRECT_MESSAGE
      (c?.enableC2c || c?.enableGroup ? 1 << 25 : 0) // GROUP_AND_C2C_EVENT
    )
  }
  private sendGateway(payload: GatewayPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(payload))
  }
  private handleDispatch(type: string, data: Record<string, unknown>): void {
    const c2c = type === 'C2C_MESSAGE_CREATE'
    const groupAt = type === 'GROUP_AT_MESSAGE_CREATE'
    const guildAt = type === 'AT_MESSAGE_CREATE'
    const guildDm = type === 'DIRECT_MESSAGE_CREATE'
    if (!c2c && !groupAt && !guildAt && !guildDm) return
    // B1: per-channel enable gates. GROUP_AND_C2C_EVENT (1<<25) is one intent
    // bit covering both C2C and group@ traffic, so a subscription cannot
    // select one without the other — the individual switches are enforced
    // here at dispatch time instead.
    if (c2c && !this.config?.enableC2c) return
    if (groupAt && !this.config?.enableGroup) return
    if ((guildAt || guildDm) && !this.config?.enableGuild) return
    const chatId = stringValue(
      c2c
        ? data.author?.['user_openid' as never]
        : groupAt
          ? data.group_openid
          : (data.channel_id ?? data.guild_id ?? ''),
    )
    if (!chatId) return
    const rawContent = stringValue(data.content)
    const content = rawContent.replace(/<@!?[^>]+>/g, '').trim()
    const author = (data.author ?? {}) as Record<string, unknown>
    const chatType = c2c || guildDm ? 'private' : 'group'
    // Group/guild at-message events also fire for a bare "@everyone" — a
    // wake signal requires a specific `<@...>` mention tag (the bot's own
    // openid tag, or alongside other users' tags) so @everyone-only traffic
    // does not wake the bot.
    const hasSpecificMention =
      /<@!?[^>]+>/.test(rawContent) && !/<@!?everyone>/i.test(rawContent)
    const event: PlatformMessageEvent = {
      platformName: 'qq_official',
      messageId: stringValue(data.id),
      sessionKey: encodeSessionKey('qq_official', chatType, chatId),
      chatType,
      senderId: stringValue(
        author.user_openid ?? author.member_openid ?? author.id ?? 'unknown',
      ),
      senderName: stringValue(
        author.username ?? author.user_nick ?? 'QQ user',
        'QQ user',
      ),
      mentionedBotId:
        (groupAt || guildAt) && hasSpecificMention ? 'qq_official' : undefined,
      message: {
        components: [{ type: 'text', text: content }],
        plainText: content,
        rawMessage: data,
        timestamp: Date.now(),
      },
    }
    for (const handler of this.messageHandlers)
      Promise.resolve(handler(event)).catch((error) =>
        this.fail(errorOf(error), {
          operation: 'receive',
          sessionKey: event.sessionKey,
          messageId: event.messageId,
        }),
      )
  }
  private fail(error: Error, context?: PlatformErrorContext): void {
    this.status = context?.retryable ? 'degraded' : 'failed'
    for (const handler of this.errorHandlers) handler(error, this, context)
  }
}
