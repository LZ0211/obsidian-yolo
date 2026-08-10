import { Platform, requestUrl } from 'obsidian'

import type { BotPlatformQqOfficialConfig } from '../../../../settings/schema/setting.types'
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
  private heartbeat: number | null = null
  private sequence: number | undefined

  async start(config: BotPlatformQqOfficialConfig): Promise<void> {
    if (Platform.isMobile)
      throw new Error('The QQ bot platform is desktop-only.')
    if (!config.appId || !config.appSecret)
      throw new Error('QQ App ID and App Secret are required.')
    this.config = config
    const gateway = await requestUrl({
      url: `${API}/gateway/bot`,
      headers: this.headers(),
    })
    const url = gateway.json?.url
    if (typeof url !== 'string')
      throw new Error('QQ Gateway URL is unavailable.')
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onmessage = (event) =>
      this.handleGatewayPayload(
        JSON.parse(String(event.data)) as GatewayPayload,
      )
    ws.onerror = () =>
      this.fail(new Error('QQ Gateway connection error.'), {
        operation: 'receive',
        retryable: true,
      })
    ws.onclose = () => {
      if (this.status === 'running') this.status = 'degraded'
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat)
    this.heartbeat = null
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
    const body: Record<string, unknown> = {
      content: text,
      msg_type: 0,
      msg_seq: Math.floor(Math.random() * 10_000) + 1,
    }
    if (content.replyToMessageId) body.msg_id = content.replyToMessageId
    const response = await requestUrl({
      url: `${API}${endpoint}`,
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const id = String(response.json?.id ?? Date.now())
    return [{ platformMessageId: id, sessionKey, timestamp: Date.now() }]
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
      if (interval > 0)
        this.heartbeat = window.setInterval(
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
  private intents(): number {
    const c = this.config
    return (
      (c?.enableGuild ? 1 << 9 : 0) |
      (c?.enableC2c ? 1 << 25 : 0) |
      (c?.enableGroup ? 1 << 25 : 0)
    )
  }
  private sendGateway(payload: GatewayPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(payload))
  }
  private handleDispatch(type: string, data: Record<string, unknown>): void {
    const c2c = type === 'C2C_MESSAGE_CREATE'
    const group = type === 'GROUP_AT_MESSAGE_CREATE'
    const guild =
      type === 'AT_MESSAGE_CREATE' || type === 'DIRECT_MESSAGE_CREATE'
    if (!c2c && !group && !guild) return
    const chatId = stringValue(
      c2c
        ? data.author?.['user_openid' as never]
        : group
          ? data.group_openid
          : (data.channel_id ?? data.guild_id ?? ''),
    )
    if (!chatId) return
    const content = stringValue(data.content)
      .replace(/<@!?[^>]+>/g, '')
      .trim()
    const author = (data.author ?? {}) as Record<string, unknown>
    const event: PlatformMessageEvent = {
      platformName: 'qq_official',
      messageId: stringValue(data.id),
      sessionKey: encodeSessionKey(
        'qq_official',
        c2c ? 'private' : 'group',
        chatId,
      ),
      chatType: c2c ? 'private' : 'group',
      senderId: stringValue(
        author.user_openid ?? author.member_openid ?? author.id ?? 'unknown',
      ),
      senderName: stringValue(
        author.username ?? author.user_nick ?? 'QQ user',
        'QQ user',
      ),
      mentionedBotId: group || guild ? 'qq_official' : undefined,
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
