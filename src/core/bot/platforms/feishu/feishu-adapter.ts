/**
 * FeishuAdapter — `PlatformAdapter` implementation for Feishu (飞书) / Lark,
 * Socket Mode (long-connection) only — the only mode this adapter supports,
 * there is no webhook-push fallback (unlike DingTalk's Stream Mode + REST
 * duality).
 *
 * Protocol facts below were confirmed by reading `@larksuiteoapi/node-sdk`'s
 * source (`ws-client/proto-buf/pbbp2.js`, `ws-client/index.ts`, `enum.ts`,
 * `data-cache.ts`, `ws-config.ts`) — read only for protocol facts, never
 * adopted as a dependency:
 *
 * - Wire protocol is binary protobuf ("pbbp2"/"Bin Protocol V2"): every frame
 *   in both directions is a `Frame` message wrapping `Header` messages (see
 *   `./frame-codec.ts` for the hand-rolled codec — only varint and
 *   length-delimited wire types are used, so no general protobuf library is
 *   needed).
 * - Handshake: `POST {domain}/callback/ws/endpoint` body
 *   `{AppID, AppSecret}` (PascalCase — differs from the snake_case used by
 *   every other Feishu REST call) → `{code, msg, data: {URL, ClientConfig}}`.
 *   `URL` is ready-to-connect (already carries `device_id`/`service_id` query
 *   params); `service_id` is extracted from it to populate outgoing
 *   `Frame.service`. `ClientConfig` fields are in seconds; ×1000 for ms.
 * - Control frames (`method = 0`): unlike DingTalk, the *client* initiates
 *   pings, every `ClientConfig.PingInterval` ms (default 120s):
 *   `{SeqID:0, LogID:0, service, method:0, headers:[{key:'type',value:'ping'}]}`,
 *   no payload. The server replies with a pong control frame (ignored here —
 *   this adapter deliberately uses its own fixed reconnect backoff instead of
 *   the server-suggested `ReconnectCount`/`ReconnectInterval`/`ReconnectNonce`
 *   values carried in the pong payload, for consistency with the DingTalk
 *   adapter's already-tested reconnect logic).
 * - Data frames (`method = 1`): headers carry `type` (`'event'` handled,
 *   `'card'` ignored — interactive-card callbacks are out of scope),
 *   `message_id`, `sum` (total chunk count), `seq` (0-based chunk index).
 *   Large payloads may be split across multiple physical frames sharing the
 *   same `message_id` — chunks are buffered per-`message_id` (indexed by
 *   `seq`) and only reassembled (byte-concat + `JSON.parse`) once every slot
 *   up to `sum` is filled; incomplete buffers are swept after 10s to avoid
 *   unbounded memory growth. The reassembled JSON is `{schema, header:
 *   {event_id, event_type,...}, event:{...}}`. Only `event_type ===
 *   'im.message.receive_v1'` is handled.
 * - Ack: immediately after reassembly (regardless of downstream handler
 *   outcome — ack is pure protocol receipt, not the reply), send back a
 *   frame built from the *last received chunk frame* (same `SeqID`/`service`/
 *   `method`/headers-plus-`biz_rt`), with `payload` replaced by
 *   `JSON({code:200})` (or `{code:500}` if the reassembled bytes failed to
 *   parse as JSON).
 * - Feishu's REST convention: 200 HTTP + non-zero `code` on failure (e.g.
 *   expired token) — every REST response here is checked for `code !== 0`,
 *   not just the token endpoint.
 * - Reply is always via `POST .../messages/{message_id}/reply` (reply-to the
 *   most recent inbound message) — no group/private send-API split like
 *   DingTalk, since Feishu's reply endpoint handles both.
 *
 * Desktop-only, matching Telegram/DingTalk: `downloadFile` writes to a Node
 * temp file, gated behind `Platform.isMobile`.
 */
import { App, FileSystemAdapter, Platform, requestUrl } from 'obsidian'

import type { BotPlatformFeishuConfig } from '../../../../settings/schema/setting.types'
import { BoundedTtlMap } from '../../bounded-ttl-map'
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

import {
  type DecodedFrame,
  type FrameHeader,
  decodeFrame,
  encodeFrame,
} from './frame-codec'

const FEISHU_DOMAIN = 'https://open.feishu.cn'
const WS_ENDPOINT_URL = `${FEISHU_DOMAIN}/callback/ws/endpoint`
const TENANT_TOKEN_URL = `${FEISHU_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`
const IMAGE_UPLOAD_URL = `${FEISHU_DOMAIN}/open-apis/im/v1/images`
const FILE_UPLOAD_URL = `${FEISHU_DOMAIN}/open-apis/im/v1/files`

function buildReplyMessageUrl(messageId: string): string {
  return `${FEISHU_DOMAIN}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`
}

function buildMessageResourceUrl(messageId: string, fileKey: string): string {
  return `${FEISHU_DOMAIN}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`
}

const TOKEN_SAFETY_BUFFER_MS = 5 * 60_000
const DEFAULT_TOKEN_TTL_S = 7200
const DEFAULT_PING_INTERVAL_S = 120
const RECONNECT_BASE_DELAY_MS = 10_000
const RECONNECT_MAX_DELAY_MS = 300_000
const STABLE_CONNECTION_MS = 300_000
const PENDING_FRAME_TTL_MS = 10_000
const SESSION_BINDING_CAPACITY = 5000
const SESSION_BINDING_TTL_MS = 24 * 60 * 60_000
const FILE_LOOKUP_CAPACITY = 5000
const FILE_LOOKUP_TTL_MS = 24 * 60 * 60_000

const FRAME_METHOD_CONTROL = 0
const FRAME_METHOD_DATA = 1

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : JSON.stringify(error))
}

function headerValue(headers: FrameHeader[], key: string): string | undefined {
  return headers.find((header) => header.key === key)?.value
}

function getComponentFileId(component: MessageComponent): string | undefined {
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

type FeishuApiResponse<T> = {
  code: number
  msg: string
  data?: T
}

type FeishuHandshakeResponse = {
  code: number
  msg: string
  data?: {
    URL: string
    ClientConfig?: {
      PingInterval?: number
      ReconnectCount?: number
      ReconnectInterval?: number
      ReconnectNonce?: number
    }
  }
}

type FeishuEventEnvelope = {
  schema?: string
  header: {
    event_id: string
    token?: string
    create_time?: string
    event_type: string
    tenant_key?: string
    app_id?: string
  }
  event: Record<string, unknown>
}

type FeishuMentionRef = {
  key: string
  id: { open_id?: string; union_id?: string; user_id?: string }
  name: string
  tenant_key?: string
}

type FeishuMessageReceiveEvent = {
  sender: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string }
    sender_type?: string
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time?: string
    chat_id: string
    chat_type: 'p2p' | 'group'
    message_type: string
    content: string
    mentions?: FeishuMentionRef[]
  }
}

type SessionBinding = {
  chatId: string
  chatType: 'private' | 'group'
  senderId: string
  lastMessageId: string
}

type PendingDataFrame = {
  sum: number
  chunks: Map<number, Uint8Array>
  firstSeenAt: number
}

function parseFeishuContent(
  messageType: string,
  contentJson: string,
): { components: MessageComponent[]; plainTextParts: string[] } {
  const components: MessageComponent[] = []
  const plainTextParts: string[] = []
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(contentJson) as Record<string, unknown>
  } catch {
    components.push({
      type: 'unsupported',
      kind: messageType,
      raw: contentJson,
    })
    return { components, plainTextParts }
  }

  switch (messageType) {
    case 'text': {
      const text = typeof parsed.text === 'string' ? parsed.text : ''
      if (text) {
        components.push({ type: 'text', text })
        plainTextParts.push(text)
      }
      break
    }
    case 'post': {
      const paragraphs = Array.isArray(parsed.content)
        ? (parsed.content as unknown[][])
        : []
      for (const paragraph of paragraphs) {
        if (!Array.isArray(paragraph)) continue
        for (const node of paragraph) {
          if (!node || typeof node !== 'object') continue
          const tagNode = node as {
            tag?: string
            text?: string
            href?: string
            user_id?: string
            user_name?: string
            image_key?: string
          }
          if (tagNode.tag === 'text' && tagNode.text) {
            components.push({ type: 'text', text: tagNode.text })
            plainTextParts.push(tagNode.text)
          } else if (tagNode.tag === 'a' && tagNode.text) {
            const label = tagNode.href
              ? `${tagNode.text} (${tagNode.href})`
              : tagNode.text
            components.push({ type: 'text', text: label })
            plainTextParts.push(label)
          } else if (tagNode.tag === 'at') {
            const userId = tagNode.user_id ?? ''
            const displayName = tagNode.user_name ?? userId
            components.push({ type: 'mention', userId, displayName })
          } else if (tagNode.tag === 'img' && tagNode.image_key) {
            components.push({ type: 'image', fileId: tagNode.image_key })
          }
        }
      }
      break
    }
    case 'image': {
      const imageKey =
        typeof parsed.image_key === 'string' ? parsed.image_key : undefined
      if (imageKey) components.push({ type: 'image', fileId: imageKey })
      break
    }
    case 'file': {
      const fileKey =
        typeof parsed.file_key === 'string' ? parsed.file_key : undefined
      const fileName =
        typeof parsed.file_name === 'string' ? parsed.file_name : 'file'
      if (fileKey) {
        components.push({
          type: 'file',
          fileId: fileKey,
          mimeType: 'application/octet-stream',
          name: fileName,
        })
      }
      break
    }
    case 'audio': {
      const fileKey =
        typeof parsed.file_key === 'string' ? parsed.file_key : undefined
      const duration =
        typeof parsed.duration === 'number' ? parsed.duration : undefined
      if (fileKey) {
        components.push({
          type: 'audio',
          fileId: fileKey,
          mimeType: 'audio/opus',
          duration,
        })
      }
      break
    }
    case 'media': {
      const fileKey =
        typeof parsed.file_key === 'string' ? parsed.file_key : undefined
      if (fileKey) {
        components.push({
          type: 'video',
          fileId: fileKey,
          mimeType: 'video/mp4',
        })
      }
      break
    }
    default:
      components.push({ type: 'unsupported', kind: messageType, raw: parsed })
  }

  if (components.length === 0) {
    components.push({ type: 'unsupported', kind: messageType, raw: parsed })
  }

  return { components, plainTextParts }
}

export class FeishuAdapter implements PlatformAdapter {
  readonly meta: PlatformMetadata = {
    name: 'feishu',
    displayName: 'Feishu',
    description:
      'Feishu (飞书/Lark) bot adapter (Socket Mode long-connection; text/image/file, final-only replies).',
    version: '1.0.0',
  }

  readonly capabilities: PlatformCapabilities = {
    markdownMode: 'none',
    supportsImage: true,
    supportsFile: true,
    supportsStreaming: false,
    maxMessageLength: 10_000,
    maxImageSize: 10 * 1024 * 1024,
    maxFileSize: 30 * 1024 * 1024,
  }

  private readonly app: App
  private config: BotPlatformFeishuConfig | null = null
  private ws: WebSocket | null = null
  private status: 'stopped' | 'running' | 'degraded' | 'failed' = 'stopped'
  private stopping = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pingIntervalMs = DEFAULT_PING_INTERVAL_S * 1000
  private service = 0
  private accessToken: { token: string; expiresAt: number } | null = null
  private readonly pendingFrames = new Map<string, PendingDataFrame>()
  private readonly sessionBindings = new BoundedTtlMap<string, SessionBinding>({
    capacity: SESSION_BINDING_CAPACITY,
    ttlMs: SESSION_BINDING_TTL_MS,
  })
  private readonly fileMessageLookup = new BoundedTtlMap<string, string>({
    capacity: FILE_LOOKUP_CAPACITY,
    ttlMs: FILE_LOOKUP_TTL_MS,
  })
  private readonly messageHandlers: MessageHandler[] = []
  private readonly errorHandlers: ErrorHandler[] = []

  constructor(app: App) {
    this.app = app
  }

  async start(config: PlatformConfig): Promise<void> {
    if (Platform.isMobile) {
      throw new Error('The Feishu bot platform is desktop-only.')
    }
    this.config = config as unknown as BotPlatformFeishuConfig
    this.stopping = false
    this.reconnectAttempt = 0
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.status = 'stopped'
    this.clearStableTimer()
    this.clearPingTimer()
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

  async sendMessage(
    sessionKey: string,
    content: ReplyContent,
    options?: { progress?: (percent: number) => void },
  ): Promise<SentMessageRef[]> {
    const config = this.config
    if (!config) throw new Error('Feishu adapter is not started.')

    const binding = this.sessionBindings.get(sessionKey)
    if (!binding) {
      throw new Error(
        `No Feishu session binding found for sessionKey "${sessionKey}" — the bot must have received a message from this chat first.`,
      )
    }

    try {
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

      if (content.text) {
        const messageId = await this.replyMessage(
          token,
          binding.lastMessageId,
          'text',
          { text: content.text },
        )
        refs.push({
          platformMessageId: messageId,
          sessionKey,
          timestamp: Date.now(),
        })
        reportProgress()
      }

      for (const image of content.images ?? []) {
        const imageKey = await this.uploadImage(token, image)
        const messageId = await this.replyMessage(
          token,
          binding.lastMessageId,
          'image',
          { image_key: imageKey },
        )
        refs.push({
          platformMessageId: messageId,
          sessionKey,
          timestamp: Date.now(),
        })
        reportProgress()
      }

      for (const file of content.files ?? []) {
        const fileKey = await this.uploadFile(token, file)
        const messageId = await this.replyMessage(
          token,
          binding.lastMessageId,
          'file',
          { file_key: fileKey },
        )
        refs.push({
          platformMessageId: messageId,
          sessionKey,
          timestamp: Date.now(),
        })
        reportProgress()
      }

      if (refs.length === 0) {
        throw new Error('sendMessage called with no text/images/files content.')
      }
      return refs
    } catch (error) {
      const err = toError(error)
      this.emitError(err, { operation: 'send', sessionKey, raw: error })
      throw err
    }
  }

  sendStreamingMessage(_sessionKey: string): StreamReplyHandle {
    throw new Error(
      'Streaming replies are not supported by the Feishu adapter (capabilities.supportsStreaming = false).',
    )
  }

  async downloadFile(component: MessageComponent): Promise<DownloadedFile> {
    const config = this.config
    if (!config) throw new Error('Feishu adapter is not started.')

    const fileId = getComponentFileId(component)
    if (!fileId) {
      throw new Error(
        `Cannot download a "${component.type}" component: no fileId present.`,
      )
    }
    const messageId = this.fileMessageLookup.get(fileId)
    if (!messageId) {
      throw new Error(
        `No source message found for Feishu file "${fileId}" — it may have expired from cache.`,
      )
    }

    try {
      const token = await this.getAccessToken(config)
      const resourceType = component.type === 'image' ? 'image' : 'file'
      const url = `${buildMessageResourceUrl(messageId, fileId)}?type=${resourceType}`
      const response = await requestUrl({
        url,
        headers: { Authorization: `Bearer ${token}` },
      })

      const os = await import('node:os')

      const path = await import('node:path')

      const fs = await import('node:fs/promises')
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-feishu-'))
      const fileName = component.type === 'file' ? component.name : fileId
      const filePath = path.join(tempDir, fileName)
      await fs.writeFile(filePath, Buffer.from(response.arrayBuffer))
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

  // ─────────────────────────── Connection lifecycle ───────────────────────────

  private async connect(): Promise<void> {
    const config = this.config
    if (!config) return

    let handshake: NonNullable<FeishuHandshakeResponse['data']>
    try {
      const response = await requestUrl({
        url: WS_ENDPOINT_URL,
        method: 'POST',
        contentType: 'application/json',
        headers: { locale: 'zh', 'User-Agent': 'yolo-obsidian' },
        body: JSON.stringify({
          AppID: config.appId,
          AppSecret: config.appSecret,
        }),
      })
      const body = response.json as FeishuHandshakeResponse
      if (body.code !== 0 || !body.data) {
        throw new Error(`Feishu WS handshake failed: ${body.msg}`)
      }
      handshake = body.data
    } catch (error) {
      const err = toError(error)
      this.status = 'degraded'
      this.emitError(err, { operation: 'start', retryable: true, raw: error })
      this.scheduleReconnect()
      return
    }

    const wsUrl = new URL(handshake.URL)
    const serviceId = Number(wsUrl.searchParams.get('service_id'))
    this.service = Number.isFinite(serviceId) ? serviceId : 0
    this.pingIntervalMs =
      (handshake.ClientConfig?.PingInterval ?? DEFAULT_PING_INTERVAL_S) * 1000

    const ws = new WebSocket(handshake.URL)
    ws.binaryType = 'arraybuffer'
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
    this.clearPingTimer()
    this.pingTimer = setInterval(() => this.sendPing(), this.pingIntervalMs)
  }

  private handleClose(): void {
    this.ws = null
    this.clearStableTimer()
    this.clearPingTimer()
    if (this.stopping) {
      this.status = 'stopped'
      return
    }
    this.status = 'degraded'
    this.scheduleReconnect()
  }

  private handleSocketError(event: Event): void {
    this.emitError(new Error('Feishu WebSocket connection error.'), {
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

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private sendPing(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const frame = encodeFrame({
      seqId: 0,
      logId: 0,
      service: this.service,
      method: FRAME_METHOD_CONTROL,
      headers: [{ key: 'type', value: 'ping' }],
    })
    ws.send(frame)
  }

  // ─────────────────────────── Frame handling ───────────────────────────

  private handleMessage(event: MessageEvent): void {
    let frame: DecodedFrame
    try {
      frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer))
    } catch (error) {
      this.emitError(toError(error), { operation: 'receive', raw: event.data })
      return
    }

    if (frame.method === FRAME_METHOD_CONTROL) {
      // Server pongs (and any stray server pings) carry no actionable state
      // for us — this adapter uses its own fixed reconnect backoff rather
      // than the server-suggested reconnect policy in the pong payload.
      return
    }
    if (frame.method === FRAME_METHOD_DATA) {
      this.handleDataFrame(frame)
    }
  }

  private handleDataFrame(frame: DecodedFrame): void {
    const messageId = headerValue(frame.headers, 'message_id')
    const type = headerValue(frame.headers, 'type')
    if (!messageId) {
      this.emitError(
        new Error('Feishu data frame missing message_id header.'),
        {
          operation: 'receive',
          raw: frame,
        },
      )
      return
    }
    const sum = Number(headerValue(frame.headers, 'sum') ?? '1')
    const seq = Number(headerValue(frame.headers, 'seq') ?? '0')

    this.sweepStalePendingFrames()

    let pending = this.pendingFrames.get(messageId)
    if (!pending) {
      pending = { sum, chunks: new Map(), firstSeenAt: Date.now() }
      this.pendingFrames.set(messageId, pending)
    }
    pending.chunks.set(seq, frame.payload ?? new Uint8Array(0))

    if (pending.chunks.size < pending.sum) return
    this.pendingFrames.delete(messageId)

    const elapsedMs = Date.now() - pending.firstSeenAt
    const orderedChunks: Uint8Array[] = []
    for (let i = 0; i < pending.sum; i++) {
      const chunk = pending.chunks.get(i)
      if (!chunk) {
        this.emitError(
          new Error(
            `Feishu data frame reassembly for message ${messageId} is missing chunk ${i}.`,
          ),
          { operation: 'receive' },
        )
        this.ackDataFrame(frame, 500, elapsedMs)
        return
      }
      orderedChunks.push(chunk)
    }

    let combinedLength = 0
    for (const chunk of orderedChunks) combinedLength += chunk.length
    const combined = new Uint8Array(combinedLength)
    let offset = 0
    for (const chunk of orderedChunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }

    let envelope: FeishuEventEnvelope
    try {
      envelope = JSON.parse(
        new TextDecoder().decode(combined),
      ) as FeishuEventEnvelope
    } catch (error) {
      this.emitError(toError(error), { operation: 'receive', raw: combined })
      this.ackDataFrame(frame, 500, elapsedMs)
      return
    }

    this.ackDataFrame(frame, 200, elapsedMs)

    if (type !== 'event') return
    if (envelope.header?.event_type !== 'im.message.receive_v1') return

    const platformEvent = this.convertToPlatformEvent(
      envelope.event as unknown as FeishuMessageReceiveEvent,
    )

    for (const handler of this.messageHandlers) {
      Promise.resolve(handler(platformEvent)).catch((error: unknown) => {
        this.emitError(toError(error), {
          operation: 'receive',
          sessionKey: platformEvent.sessionKey,
          messageId: platformEvent.messageId,
          raw: error,
        })
      })
    }
  }

  private ackDataFrame(
    originalFrame: DecodedFrame,
    code: number,
    bizRtMs: number,
  ): void {
    const ws = this.ws
    if (!ws) return
    const ackHeaders: FrameHeader[] = [
      ...originalFrame.headers,
      { key: 'biz_rt', value: String(bizRtMs) },
    ]
    const payload = new TextEncoder().encode(JSON.stringify({ code }))
    const ackFrame = encodeFrame({
      seqId: originalFrame.seqId,
      logId: originalFrame.logId,
      service: originalFrame.service,
      method: originalFrame.method,
      headers: ackHeaders,
      payload,
    })
    ws.send(ackFrame)
  }

  private sweepStalePendingFrames(): void {
    const now = Date.now()
    for (const [messageId, pending] of this.pendingFrames) {
      if (now - pending.firstSeenAt > PENDING_FRAME_TTL_MS) {
        this.pendingFrames.delete(messageId)
      }
    }
  }

  private convertToPlatformEvent(
    raw: FeishuMessageReceiveEvent,
  ): PlatformMessageEvent {
    const message = raw.message
    const chatType: 'private' | 'group' =
      message.chat_type === 'group' ? 'group' : 'private'
    const sessionKey = encodeSessionKey('feishu', chatType, message.chat_id)
    const { components, plainTextParts } = parseFeishuContent(
      message.message_type,
      message.content,
    )

    for (const mention of message.mentions ?? []) {
      const userId = mention.id?.open_id ?? ''
      components.push({
        type: 'mention',
        userId,
        displayName: mention.name || userId,
      })
    }

    // Feishu's event payload only carries the sender's open_id, not a
    // display name — resolving that needs a separate contact API call,
    // out of scope for this pass.
    const senderId = raw.sender?.sender_id?.open_id ?? ''

    this.sessionBindings.set(sessionKey, {
      chatId: message.chat_id,
      chatType,
      senderId,
      lastMessageId: message.message_id,
    })

    for (const component of components) {
      const fileId = getComponentFileId(component)
      if (fileId) {
        this.fileMessageLookup.set(fileId, message.message_id)
      }
    }

    return {
      platformName: 'feishu',
      messageId: message.message_id,
      sessionKey,
      chatType,
      senderId,
      senderName: senderId,
      message: {
        components,
        plainText: plainTextParts.join('\n'),
        rawMessage: raw,
        timestamp: Number(message.create_time) || Date.now(),
      },
      isFromBot: false,
    }
  }

  // ─────────────────────────── Sending ───────────────────────────

  private async replyMessage(
    token: string,
    messageId: string,
    msgType: 'text' | 'image' | 'file',
    content: Record<string, unknown>,
  ): Promise<string> {
    const response = await requestUrl({
      url: buildReplyMessageUrl(messageId),
      method: 'POST',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        msg_type: msgType,
        content: JSON.stringify(content),
        reply_in_thread: false,
      }),
    })
    const json = response.json as FeishuApiResponse<{ message_id: string }>
    if (json.code !== 0 || !json.data?.message_id) {
      throw new Error(`Feishu send message failed: ${json.msg}`)
    }
    return json.data.message_id
  }

  // ─────────────────────────── OAuth2 / media ───────────────────────────

  private async getAccessToken(
    config: BotPlatformFeishuConfig,
  ): Promise<string> {
    const cached = this.accessToken
    if (cached && Date.now() < cached.expiresAt - TOKEN_SAFETY_BUFFER_MS) {
      return cached.token
    }

    const response = await requestUrl({
      url: TENANT_TOKEN_URL,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    })
    const json = response.json as {
      code: number
      msg: string
      tenant_access_token?: string
      expire?: number
    }
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new Error(`Feishu tenant access token request failed: ${json.msg}`)
    }
    const expireS = json.expire ?? DEFAULT_TOKEN_TTL_S
    this.accessToken = {
      token: json.tenant_access_token,
      expiresAt: Date.now() + expireS * 1000,
    }
    return this.accessToken.token
  }

  private async uploadImage(token: string, ref: ImageRef): Promise<string> {
    const { data, fileName } = await this.resolveMediaBytes(ref)
    const { body, contentType } = this.buildMultipartBody(
      [{ name: 'image_type', value: 'message' }],
      'image',
      fileName,
      ref.mimeType,
      data,
    )
    const response = await requestUrl({
      url: IMAGE_UPLOAD_URL,
      method: 'POST',
      contentType,
      headers: { Authorization: `Bearer ${token}` },
      body,
    })
    const json = response.json as FeishuApiResponse<{ image_key: string }>
    if (json.code !== 0 || !json.data?.image_key) {
      throw new Error(`Feishu image upload failed: ${json.msg}`)
    }
    return json.data.image_key
  }

  private async uploadFile(token: string, ref: FileRef): Promise<string> {
    const { data, fileName } = await this.resolveMediaBytes(ref)
    const fileType = fileName.includes('.')
      ? (fileName.split('.').pop() ?? 'stream')
      : 'stream'
    const { body, contentType } = this.buildMultipartBody(
      [
        { name: 'file_type', value: fileType },
        { name: 'file_name', value: fileName },
      ],
      'file',
      fileName,
      ref.mimeType,
      data,
    )
    const response = await requestUrl({
      url: FILE_UPLOAD_URL,
      method: 'POST',
      contentType,
      headers: { Authorization: `Bearer ${token}` },
      body,
    })
    const json = response.json as FeishuApiResponse<{ file_key: string }>
    if (json.code !== 0 || !json.data?.file_key) {
      throw new Error(`Feishu file upload failed: ${json.msg}`)
    }
    return json.data.file_key
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
    extraFields: Array<{ name: string; value: string }>,
    fieldName: string,
    fileName: string,
    mimeType: string,
    data: ArrayBuffer,
  ): { body: ArrayBuffer; contentType: string } {
    const boundary = `----yoloFeishu${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
    const encoder = new TextEncoder()
    const parts: Uint8Array[] = []
    for (const field of extraFields) {
      parts.push(
        encoder.encode(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
            `${field.value}\r\n`,
        ),
      )
    }
    parts.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
          `Content-Type: ${mimeType}\r\n\r\n`,
      ),
    )
    parts.push(new Uint8Array(data))
    parts.push(encoder.encode(`\r\n--${boundary}--\r\n`))

    const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0)
    const body = new Uint8Array(totalLength)
    let offset = 0
    for (const part of parts) {
      body.set(part, offset)
      offset += part.byteLength
    }

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
