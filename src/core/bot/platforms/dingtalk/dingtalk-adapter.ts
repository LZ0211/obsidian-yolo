/**
 * DingTalkAdapter — `PlatformAdapter` implementation for the DingTalk (钉钉)
 * enterprise robot, Stream Mode only (see `botPlatformDingtalkSchema.streamMode`
 * — webhook-push mode would need a public HTTPS callback, out of scope).
 *
 * Protocol facts below were confirmed by reading the official
 * `dingtalk-stream-sdk-java` source (authoritative over the Python
 * `dingtalk_stream` package used by third-party references):
 *
 * - Connection handshake: `POST /v1.0/gateway/connections/open` →
 *   `{endpoint, ticket}`. The WebSocket URL keeps only `endpoint`'s
 *   scheme/host/port (any path is discarded) + `/connect?ticket=...`.
 * - Frame envelope (server→client): `{type: 'SYSTEM'|'EVENT'|'CALLBACK',
 *   headers: {topic, messageId, ...}, data: <JSON string>}`. Client→server ack
 *   mirrors the same shape with `{code, message, headers, data}`.
 * - `SYSTEM` topic `ping` → echo `data` back unchanged in a 200/OK ack.
 *   `disconnect` → server is closing the socket; just log, let `onclose`
 *   drive reconnection.
 * - `CALLBACK` (topic `/v1.0/im/bot/messages/get`, the chatbot message push)
 *   must be ack'd immediately (`data: '{}'`) regardless of downstream
 *   processing — the ack is pure protocol receipt, not the reply.
 * - Every incoming message carries a short-lived `sessionWebhook` — replying
 *   is a plain `POST {sessionWebhook} {msgtype:'text', text:{content}}`, no
 *   OAuth/robotCode/staffId needed. Since agent replies can take a long time
 *   (up to `maxAutoIterations`), this can't be relied on alone: once
 *   `sessionWebhookExpiredTime` has passed (or for image/file replies, which
 *   always need a `media_id`), fall back to the OAuth2-authenticated REST
 *   group/private send APIs.
 * - Reconnect backoff: `10 * 2^(retry-1)`s capped at 300s; the counter resets
 *   after 300s of stable (uninterrupted) connection.
 *
 * Desktop-only, matching the Telegram adapter (not WeChat): `downloadFile`
 * writes to a Node temp file (`DownloadedFile.tempPath`), which needs
 * `fs`/`os`/`path` and is gated behind `Platform.isMobile`. No new npm
 * dependency is needed — native `WebSocket` is a global in the Obsidian/
 * Electron renderer, and multipart bodies for media upload are hand-built
 * since there's no `FormData` precedent in this repo.
 */
import { App, FileSystemAdapter, Platform, requestUrl } from 'obsidian'

import type { BotPlatformDingtalkConfig } from '../../../../settings/schema/setting.types'
import { validateOutgoingAttachmentSize } from '../../attachment-security'
import { BoundedTtlMap } from '../../bounded-ttl-map'
import { splitTextAtBoundaries } from '../../text-chunking'
import {
  type DownloadedFile,
  type ErrorHandler,
  type FileRef,
  type ImageRef,
  type MessageComponent,
  type MessageHandler,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformConfig,
  type PlatformErrorContext,
  type PlatformMessageEvent,
  type PlatformMetadata,
  type ReplyContent,
  type SentMessageRef,
  type StreamReplyHandle,
  encodeSessionKey,
} from '../../types'

const CONNECTION_OPEN_URL =
  'https://api.dingtalk.com/v1.0/gateway/connections/open'
const OAUTH_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
const PRIVATE_SEND_URL =
  'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'
const FILE_DOWNLOAD_URL =
  'https://api.dingtalk.com/v1.0/robot/messageFiles/download'
const MEDIA_UPLOAD_URL = 'https://oapi.dingtalk.com/media/upload'
const CALLBACK_TOPIC = '/v1.0/im/bot/messages/get'

const TOKEN_SAFETY_BUFFER_MS = 5 * 60_000
const DEFAULT_TOKEN_TTL_S = 7200
const RECONNECT_BASE_DELAY_MS = 10_000
const RECONNECT_MAX_DELAY_MS = 300_000
const STABLE_CONNECTION_MS = 300_000
const SESSION_BINDING_CAPACITY = 5000
const SESSION_BINDING_TTL_MS = 24 * 60 * 60_000

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : JSON.stringify(error))
}

function getComponentDownloadCode(
  component: MessageComponent,
): string | undefined {
  switch (component.type) {
    case 'image':
    case 'file':
    case 'audio':
    case 'video':
      return component.fileId
    default:
      return undefined
  }
}

function getComponentMimeType(component: MessageComponent): string {
  switch (component.type) {
    case 'image':
      return component.mimeType ?? 'image/jpeg'
    case 'file':
    case 'audio':
    case 'video':
      return component.mimeType
    default:
      return 'application/octet-stream'
  }
}

type DingTalkFrameHeaders = {
  topic?: string
  messageId: string
  contentType?: string
  time?: string | number
  appId?: string
  connectionId?: string
}

type DingTalkFrame = {
  specVersion?: string
  type: 'SYSTEM' | 'EVENT' | 'CALLBACK'
  headers: DingTalkFrameHeaders
  data: string
}

type DingTalkAtUser = {
  dingtalkId: string
  staffId?: string
}

type DingTalkRichTextItem = {
  text?: string
  type?: string
  downloadCode?: string
}

type DingTalkMessageContent = {
  content?: string
  downloadCode?: string
  pictureDownloadCode?: string
  fileName?: string
  richText?: DingTalkRichTextItem[]
}

type DingTalkChatbotMessage = {
  conversationId: string
  conversationType: '1' | '2'
  senderId: string
  senderStaffId?: string
  senderNick: string
  msgId: string
  createAt: number
  msgtype: string
  text?: { content: string }
  content?: DingTalkMessageContent
  atUsers?: DingTalkAtUser[]
  /**
   * Whether the sender @'d the robot in this message (documented optional
   * field of the robot message callback; absent on some versions/tenants).
   */
  isInAtList?: boolean
  sessionWebhook: string
  sessionWebhookExpiredTime: number
}

type SessionBinding = {
  sessionWebhook: string
  sessionWebhookExpiredTime: number
  conversationId: string
  conversationType: '1' | '2'
  senderStaffId?: string
}

export class DingTalkAdapter implements PlatformAdapter {
  readonly meta: PlatformMetadata = {
    name: 'dingtalk',
    displayName: 'DingTalk',
    description:
      'DingTalk (钉钉) enterprise robot adapter (Stream Mode; text/image/file, final-only replies).',
    version: '1.0.0',
  }

  readonly capabilities: PlatformCapabilities = {
    markdownMode: 'none',
    supportsImage: true,
    supportsFile: true,
    supportsStreaming: false,
    maxMessageLength: 20_000,
    maxImageSize: 20 * 1024 * 1024,
    maxFileSize: 100 * 1024 * 1024,
  }

  private readonly app: App
  private config: BotPlatformDingtalkConfig | null = null
  private ws: WebSocket | null = null
  private status: 'stopped' | 'running' | 'degraded' | 'failed' = 'stopped'
  private stopping = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private accessToken: { token: string; expiresAt: number } | null = null
  private readonly sessionBindings = new BoundedTtlMap<string, SessionBinding>({
    capacity: SESSION_BINDING_CAPACITY,
    ttlMs: SESSION_BINDING_TTL_MS,
  })
  private readonly messageHandlers: MessageHandler[] = []
  private readonly errorHandlers: ErrorHandler[] = []

  constructor(app: App) {
    this.app = app
  }

  async start(config: PlatformConfig): Promise<void> {
    if (Platform.isMobile) {
      throw new Error('The DingTalk bot platform is desktop-only.')
    }
    const dingtalkConfig = config as unknown as BotPlatformDingtalkConfig
    if (dingtalkConfig.streamMode === false) {
      throw new Error(
        'The DingTalk adapter only supports Stream Mode (streamMode: false is not supported).',
      )
    }
    this.config = dingtalkConfig
    this.stopping = false
    this.reconnectAttempt = 0
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.status = 'stopped'
    this.clearStableTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close(1000)
      } catch (error) {
        this.emitError(toError(error), { operation: 'stop', raw: error })
      }
    }
  }

  health(): 'running' | 'stopped' | 'degraded' | 'failed' {
    return this.status
  }

  async sendMessage(
    sessionKey: string,
    content: ReplyContent,
    options?: { progress?: (percent: number) => void },
  ): Promise<SentMessageRef[]> {
    const config = this.config
    if (!config) throw new Error('DingTalk adapter is not started.')

    const binding = this.sessionBindings.get(sessionKey)
    if (!binding) {
      throw new Error(
        `No DingTalk session binding found for sessionKey "${sessionKey}" — the bot must have received a message from this chat first.`,
      )
    }

    const hasMedia =
      (content.images?.length ?? 0) > 0 || (content.files?.length ?? 0) > 0
    const webhookValid = Date.now() < binding.sessionWebhookExpiredTime

    try {
      if (!hasMedia && webhookValid && content.text) {
        // B4: chunk long replies to the platform cap (20000) — the webhook
        // API errors on oversized text payloads.
        const refs: SentMessageRef[] = []
        for (const chunk of splitTextAtBoundaries(
          content.text,
          this.capabilities.maxMessageLength,
        )) {
          await this.sendViaWebhook(binding.sessionWebhook, chunk)
          refs.push({
            platformMessageId: `${sessionKey}-${Date.now()}`,
            sessionKey,
            timestamp: Date.now(),
          })
        }
        options?.progress?.(100)
        return refs
      }
      return await this.sendViaRest(
        config,
        binding,
        sessionKey,
        content,
        options,
      )
    } catch (error) {
      const err = toError(error)
      this.emitError(err, { operation: 'send', sessionKey, raw: error })
      throw err
    }
  }

  sendStreamingMessage(_sessionKey: string): StreamReplyHandle {
    throw new Error(
      'Streaming replies are not supported by the DingTalk adapter (capabilities.supportsStreaming = false).',
    )
  }

  async downloadFile(component: MessageComponent): Promise<DownloadedFile> {
    const config = this.config
    if (!config) throw new Error('DingTalk adapter is not started.')

    const downloadCode = getComponentDownloadCode(component)
    if (!downloadCode) {
      throw new Error(
        `Cannot download a "${component.type}" component: no downloadCode present.`,
      )
    }

    try {
      const token = await this.getAccessToken(config)
      const resolveResponse = await requestUrl({
        url: FILE_DOWNLOAD_URL,
        method: 'POST',
        contentType: 'application/json',
        headers: { 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify({ downloadCode, robotCode: config.robotCode }),
      })
      const { downloadUrl } = resolveResponse.json as { downloadUrl: string }
      const fileResponse = await requestUrl({ url: downloadUrl })

      const os = await import('node:os')

      const path = await import('node:path')

      const fs = await import('node:fs/promises')
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-dingtalk-'))
      const fileName =
        component.type === 'file'
          ? component.name
          : (path.basename(downloadUrl.split('?')[0]) ?? 'file')
      const filePath = path.join(tempDir, fileName)
      await fs.writeFile(filePath, Buffer.from(fileResponse.arrayBuffer))
      const stat = await fs.stat(filePath)
      return {
        fileName,
        mimeType: getComponentMimeType(component),
        size: stat.size,
        tempPath: filePath,
      }
    } catch (error) {
      const err = toError(error)
      this.emitError(err, { operation: 'receive', raw: error })
      throw err
    }
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

  private emitError(error: Error, context?: PlatformErrorContext): void {
    for (const handler of this.errorHandlers) {
      handler(error, this, context)
    }
  }

  // ─────────────────────────── Connection lifecycle ───────────────────────────

  private async connect(): Promise<void> {
    const config = this.config
    if (!config) return

    let endpoint: string
    let ticket: string
    try {
      const response = await requestUrl({
        url: CONNECTION_OPEN_URL,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          ua: 'yolo-obsidian',
          subscriptions: [{ type: 'CALLBACK', topic: CALLBACK_TOPIC }],
          localIp: '127.0.0.1',
        }),
      })
      const body = response.json as { endpoint: string; ticket: string }
      endpoint = body.endpoint
      ticket = body.ticket
    } catch (error) {
      const err = toError(error)
      this.status = 'degraded'
      this.emitError(err, { operation: 'start', retryable: true, raw: error })
      this.scheduleReconnect()
      return
    }

    // B2: a stop() that landed while the connection-open handshake was in
    // flight must not create a socket that resurrects the adapter — stop()
    // already cleared the timers and nulled `ws` (same guard as Feishu's
    // handshake path).
    if (this.stopping) return

    const endpointUrl = new URL(endpoint)
    const wsUrl = new URL(
      `${endpointUrl.protocol}//${endpointUrl.host}/connect`,
    )
    wsUrl.searchParams.set('ticket', ticket)

    const ws = new WebSocket(wsUrl.toString())
    ws.onopen = () => this.handleOpen()
    ws.onmessage = (event) => this.handleMessage(event)
    ws.onclose = () => this.handleClose()
    ws.onerror = (event) => this.handleSocketError(event)
    this.ws = ws
  }

  private handleOpen(): void {
    this.status = 'running'
    this.reconnectAttempt = 0
    this.clearStableTimer()
    this.stableTimer = setTimeout(() => {
      this.reconnectAttempt = 0
    }, STABLE_CONNECTION_MS)
  }

  private handleClose(): void {
    this.ws = null
    this.clearStableTimer()
    if (this.stopping) {
      this.status = 'stopped'
      return
    }
    this.status = 'degraded'
    this.scheduleReconnect()
  }

  private handleSocketError(event: Event): void {
    this.emitError(new Error('DingTalk WebSocket connection error.'), {
      operation: 'receive',
      retryable: true,
      raw: event,
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS,
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
  }

  // ─────────────────────────── Frame handling ───────────────────────────

  private handleMessage(event: MessageEvent): void {
    let frame: DingTalkFrame
    try {
      frame = JSON.parse(String(event.data)) as DingTalkFrame
    } catch (error) {
      this.emitError(toError(error), { operation: 'receive', raw: event.data })
      return
    }

    switch (frame.type) {
      case 'SYSTEM':
        this.handleSystemFrame(frame)
        break
      case 'CALLBACK':
        this.handleCallbackFrame(frame)
        break
      case 'EVENT':
        this.ackFrame(
          frame.headers.messageId,
          JSON.stringify({ status: 'SUCCESS' }),
        )
        break
    }
  }

  private handleSystemFrame(frame: DingTalkFrame): void {
    const topic = frame.headers.topic
    if (topic === 'ping') {
      this.ackFrame(frame.headers.messageId, frame.data)
      return
    }
    if (topic === 'disconnect') {
      this.emitError(
        new Error(`DingTalk server requested disconnect: ${frame.data}`),
        { operation: 'receive', retryable: true, raw: frame },
      )
    }
  }

  private handleCallbackFrame(frame: DingTalkFrame): void {
    this.ackFrame(frame.headers.messageId, '{}')

    let message: DingTalkChatbotMessage
    try {
      message = JSON.parse(frame.data) as DingTalkChatbotMessage
    } catch (error) {
      this.emitError(toError(error), { operation: 'receive', raw: frame.data })
      return
    }

    const event = this.convertToPlatformEvent(message)
    this.sessionBindings.set(event.sessionKey, {
      sessionWebhook: message.sessionWebhook,
      sessionWebhookExpiredTime: message.sessionWebhookExpiredTime,
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      senderStaffId: message.senderStaffId,
    })

    for (const handler of this.messageHandlers) {
      Promise.resolve(handler(event)).catch((error: unknown) => {
        this.emitError(toError(error), {
          operation: 'receive',
          sessionKey: event.sessionKey,
          messageId: event.messageId,
          raw: error,
        })
      })
    }
  }

  private ackFrame(messageId: string, data: string): void {
    const ws = this.ws
    if (!ws) return
    ws.send(
      JSON.stringify({
        code: 200,
        message: 'OK',
        headers: {
          messageId,
          contentType: 'application/json',
          time: String(Date.now()),
        },
        data,
      }),
    )
  }

  private convertToPlatformEvent(
    message: DingTalkChatbotMessage,
  ): PlatformMessageEvent {
    const chatType = message.conversationType === '2' ? 'group' : 'private'
    const sessionKey = encodeSessionKey(
      'dingtalk',
      chatType,
      message.conversationId,
    )
    const components: MessageComponent[] = []
    const plainTextParts: string[] = []

    switch (message.msgtype) {
      case 'text':
        if (message.text?.content) {
          components.push({ type: 'text', text: message.text.content })
          plainTextParts.push(message.text.content)
        }
        break
      case 'picture': {
        const downloadCode =
          message.content?.pictureDownloadCode ?? message.content?.downloadCode
        if (downloadCode) {
          components.push({ type: 'image', fileId: downloadCode })
        }
        break
      }
      case 'richText':
        for (const item of message.content?.richText ?? []) {
          if (item.downloadCode) {
            components.push({ type: 'image', fileId: item.downloadCode })
          } else if (item.text) {
            components.push({ type: 'text', text: item.text })
            plainTextParts.push(item.text)
          }
        }
        break
      case 'file':
        if (message.content?.downloadCode) {
          components.push({
            type: 'file',
            fileId: message.content.downloadCode,
            mimeType: 'application/octet-stream',
            name: message.content.fileName ?? 'file',
          })
        }
        break
      default:
        components.push({
          type: 'unsupported',
          kind: message.msgtype,
          raw: message,
        })
    }

    for (const atUser of message.atUsers ?? []) {
      const id = atUser.staffId ?? atUser.dingtalkId
      components.push({ type: 'mention', userId: id, displayName: id })
    }

    if (components.length === 0) {
      components.push({
        type: 'unsupported',
        kind: message.msgtype,
        raw: message,
      })
    }

    // Group wake signal: DingTalk only pushes the group message callback for
    // messages that @ the robot, and `isInAtList` is the per-message
    // confirmation carried by newer versions — when it is explicitly false
    // the message was pushed for another reason and must not wake the bot.
    const mentionedBotId =
      chatType === 'group' && message.isInAtList !== false
        ? 'dingtalk'
        : undefined

    return {
      platformName: 'dingtalk',
      messageId: message.msgId,
      sessionKey,
      chatType,
      senderId: message.senderStaffId ?? message.senderId,
      senderName: message.senderNick,
      message: {
        components,
        plainText: plainTextParts.join('\n'),
        rawMessage: message,
        timestamp: message.createAt,
      },
      mentionedBotId,
      // DingTalk never echoes the robot's own messages back through the
      // message callback (replies go out via webhook/REST), so there is no
      // self-echo loop to guard against.
      isFromBot: false,
    }
  }

  // ─────────────────────────── Sending ───────────────────────────

  private async sendViaWebhook(
    webhookUrl: string,
    text: string,
  ): Promise<void> {
    await requestUrl({
      url: webhookUrl,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    })
  }

  private async sendViaRest(
    config: BotPlatformDingtalkConfig,
    binding: SessionBinding,
    sessionKey: string,
    content: ReplyContent,
    options?: { progress?: (percent: number) => void },
  ): Promise<SentMessageRef[]> {
    const token = await this.getAccessToken(config)
    const refs: SentMessageRef[] = []
    const totalSteps =
      (content.text ? 1 : 0) +
      (content.images?.length ?? 0) +
      (content.files?.length ?? 0)
    let completedSteps = 0
    const reportProgress = () => {
      completedSteps += 1
      if (totalSteps > 0) {
        options?.progress?.(Math.round((completedSteps / totalSteps) * 100))
      }
    }

    const pushRef = () =>
      refs.push({
        platformMessageId: `${sessionKey}-${Date.now()}`,
        sessionKey,
        timestamp: Date.now(),
      })

    if (content.text) {
      // B4: chunk long replies to the platform cap (20000) — the REST send
      // API errors on oversized text payloads.
      for (const chunk of splitTextAtBoundaries(
        content.text,
        this.capabilities.maxMessageLength,
      )) {
        await this.dispatchRobotMessage(config, binding, token, 'sampleText', {
          content: chunk,
        })
        pushRef()
      }
      reportProgress()
    }

    for (const image of content.images ?? []) {
      const mediaId = await this.uploadMedia(token, image, 'image')
      await this.dispatchRobotMessage(
        config,
        binding,
        token,
        'sampleImageMsg',
        { photoURL: mediaId },
      )
      pushRef()
      reportProgress()
    }

    for (const file of content.files ?? []) {
      const mediaId = await this.uploadMedia(token, file, 'file')
      await this.dispatchRobotMessage(config, binding, token, 'sampleFile', {
        mediaId,
        fileName: file.name,
        fileType: file.mimeType.split('/').pop() ?? 'bin',
      })
      pushRef()
      reportProgress()
    }

    if (refs.length === 0) {
      throw new Error('sendMessage called with no text/images/files content.')
    }

    return refs
  }

  private async dispatchRobotMessage(
    config: BotPlatformDingtalkConfig,
    binding: SessionBinding,
    token: string,
    msgKey: string,
    msgParam: Record<string, unknown>,
  ): Promise<void> {
    const isGroup = binding.conversationType === '2'
    const url = isGroup ? GROUP_SEND_URL : PRIVATE_SEND_URL
    const body = isGroup
      ? {
          msgKey,
          msgParam: JSON.stringify(msgParam),
          openConversationId: binding.conversationId,
          robotCode: config.robotCode,
        }
      : {
          robotCode: config.robotCode,
          userIds: [binding.senderStaffId],
          msgKey,
          msgParam: JSON.stringify(msgParam),
        }

    await requestUrl({
      url,
      method: 'POST',
      contentType: 'application/json',
      headers: { 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(body),
    })
  }

  // ─────────────────────────── OAuth2 / media ───────────────────────────

  private async getAccessToken(
    config: BotPlatformDingtalkConfig,
  ): Promise<string> {
    const cached = this.accessToken
    if (cached && Date.now() < cached.expiresAt - TOKEN_SAFETY_BUFFER_MS) {
      return cached.token
    }

    const response = await requestUrl({
      url: OAUTH_TOKEN_URL,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        appKey: config.clientId,
        appSecret: config.clientSecret,
      }),
    })
    const json = response.json as {
      accessToken?: string
      expireIn?: number
      data?: { accessToken?: string; expireIn?: number }
    }
    const token = json.accessToken ?? json.data?.accessToken
    const expireIn = json.expireIn ?? json.data?.expireIn ?? DEFAULT_TOKEN_TTL_S
    if (!token) {
      throw new Error(
        'DingTalk OAuth2 token response did not contain an access token.',
      )
    }
    this.accessToken = { token, expiresAt: Date.now() + expireIn * 1000 }
    return token
  }

  private async uploadMedia(
    token: string,
    ref: ImageRef | FileRef,
    mediaType: 'image' | 'file',
  ): Promise<string> {
    const { data, fileName } = await this.resolveMediaBytes(ref)
    const validation = validateOutgoingAttachmentSize({
      kind: mediaType,
      byteLength: data.byteLength,
      maxBytes:
        mediaType === 'image'
          ? this.capabilities.maxImageSize
          : this.capabilities.maxFileSize,
      name: fileName,
    })
    if (!validation.ok) throw new Error(validation.error)
    const { body, contentType } = this.buildMultipartBody(
      'media',
      fileName,
      ref.mimeType,
      data,
    )
    const response = await requestUrl({
      url: `${MEDIA_UPLOAD_URL}?access_token=${encodeURIComponent(token)}&type=${mediaType}`,
      method: 'POST',
      contentType,
      body,
    })
    const json = response.json as {
      errcode?: number
      errmsg?: string
      media_id?: string
    }
    if (json.errcode || !json.media_id) {
      throw new Error(
        `DingTalk media upload failed: ${json.errmsg ?? 'unknown error'}`,
      )
    }
    return json.media_id
  }

  private async resolveMediaBytes(
    ref: ImageRef | FileRef,
  ): Promise<{ data: ArrayBuffer; fileName: string }> {
    const fileName = 'name' in ref ? ref.name : (ref.label ?? 'image')
    if (ref.source === 'url' && ref.url) {
      const response = await requestUrl({ url: ref.url })
      return { data: response.arrayBuffer, fileName }
    }
    if (ref.source === 'base64' && ref.dataBase64) {
      const buffer = Buffer.from(ref.dataBase64, 'base64')
      return {
        data: buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer,
        fileName,
      }
    }
    if (ref.source === 'vault-path' && ref.path) {
      const absolutePath = this.resolveVaultAbsolutePath(ref.path)
      if (!absolutePath) {
        throw new Error(
          `Cannot resolve vault path "${ref.path}": vault adapter is not filesystem-backed.`,
        )
      }

      const fs = await import('node:fs/promises')
      const buffer = await fs.readFile(absolutePath)
      return {
        data: buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer,
        fileName,
      }
    }
    throw new Error(
      `Attachment has source "${ref.source}" but no matching data field is set.`,
    )
  }

  private buildMultipartBody(
    fieldName: string,
    fileName: string,
    mimeType: string,
    data: ArrayBuffer,
  ): { body: ArrayBuffer; contentType: string } {
    const boundary = `----yoloDingTalk${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
    const encoder = new TextEncoder()
    const header = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    )
    const footer = encoder.encode(`\r\n--${boundary}--\r\n`)
    const body = new Uint8Array(
      header.byteLength + data.byteLength + footer.byteLength,
    )
    body.set(header, 0)
    body.set(new Uint8Array(data), header.byteLength)
    body.set(footer, header.byteLength + data.byteLength)
    return {
      body: body.buffer,
      contentType: `multipart/form-data; boundary=${boundary}`,
    }
  }

  private resolveVaultAbsolutePath(relativePath: string): string | undefined {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) return undefined
    const basePath = adapter.getBasePath()
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    return `${basePath}/${normalized}`
  }
}
