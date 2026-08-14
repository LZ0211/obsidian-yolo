/**
 * WeixinOCAdapter — `PlatformAdapter` implementation for the personal-WeChat
 * official personal-WeChat ClawBot/iLink interface. Bot Platform implementation plan, Phase 3.
 *
 * Outgoing text/image/file messages use the iLink item-list protocol. Incoming
 * media is kept behind the same lazy desktop crypto boundary so the host can
 * still load the text path on runtimes without Node crypto.
 *
 * Uses Obsidian's `requestUrl` exclusively for HTTP, matching the convention
 * in `src/core/auth/*OAuthService.ts` and `src/core/web-search/http.ts`.
 */
import { type App, type RequestUrlParam, requestUrl } from 'obsidian'

import type { BotPlatformWeixinConfig } from '../../../../settings/schema/setting.types'
import { loadDesktopNodeModule } from '../../../../utils/platform/desktopNodeModule'
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
  type PlatformErrorContext,
  type PlatformMessageEvent,
  type PlatformMetadata,
  type ReplyContent,
  type SentMessageRef,
  type StreamReplyHandle,
  decodeSessionKey,
  encodeSessionKey,
} from '../../types'

const CHANNEL_VERSION = '1.0.2'
const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = 132102
const BOT_AGENT = 'SmartRAG/1.6.0'

// Bounded per the implementation plan (3.6) — reuses `BoundedTtlMap` instead
// of reimplementing capacity/TTL eviction (same class as `dedupe-store.ts`).
const CONTEXT_TOKEN_CAPACITY = 5000
const CONTEXT_TOKEN_TTL_MS = 30 * 60_000
const RECENT_MESSAGES_CAPACITY = 5000
const RECENT_MESSAGES_TTL_MS = 30 * 60_000
const RECENT_MESSAGES_PER_SESSION_CAP = 100

const SESSION_EXPIRED_ERRCODE = -14
const GETUPDATES_PROTOCOL_ERROR_BACKOFF_MS = 3000
const GETUPDATES_EXCEPTION_BACKOFF_MS = 5000
// Safety-net client-side timeout on top of the server's own long-poll window
// (35-40s per the demo/AstrBot reconciliation, plan 3.1) so a hung connection
// doesn't wedge the loop forever.
const LONG_POLL_TIMEOUT_MARGIN_MS = 10_000
const QR_POLL_TIMEOUT_MS = 45_000
const CONNECTION_NOTIFY_TIMEOUT_MS = 10_000
const MEDIA_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

type MediaCrypto = Pick<
  typeof import('node:crypto'),
  'createCipheriv' | 'createDecipheriv' | 'createHash' | 'randomBytes'
>

type MediaUploadResponse = {
  ret?: number
  errcode?: number
  errmsg?: string
  upload_param?: string
  upload_full_url?: string
}

type DownloadableComponent = Extract<
  MessageComponent,
  { type: 'image' | 'file' | 'audio' | 'video' }
>

type InboundItemPayload = Record<string, unknown>

function isRecord(value: unknown): value is InboundItemPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function itemPayloadKey(itemType: number): string | undefined {
  switch (itemType) {
    case 2:
      return 'image_item'
    case 3:
      return 'voice_item'
    case 4:
      return 'file_item'
    case 5:
      return 'video_item'
    default:
      return undefined
  }
}

function getItemPayload(
  item: InboundItemPayload,
  itemType: number,
): InboundItemPayload | undefined {
  const key = itemPayloadKey(itemType)
  if (!key) return undefined
  const payload = item[key]
  return isRecord(payload) ? payload : undefined
}

function numericField(
  record: InboundItemPayload,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key]
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed)
  }
  return undefined
}

function mimeTypeFromFileName(fileName: string): string | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (!extension || extension === fileName.toLowerCase()) return undefined
  const mimeTypes: Record<string, string> = {
    amr: 'audio/amr',
    avi: 'video/x-msvideo',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    pdf: 'application/pdf',
    png: 'image/png',
    txt: 'text/plain',
    wav: 'audio/wav',
    webm: 'video/webm',
    webp: 'image/webp',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  }
  return mimeTypes[extension]
}

function inboundFileName(
  itemType: number,
  payload: InboundItemPayload,
): string {
  const declaredName =
    stringField(payload.file_name) ||
    stringField(payload.filename) ||
    stringField(payload.name)
  if (declaredName) return declaredName

  const directUrl = stringField(payload.url)
  if (directUrl) {
    const urlPath = directUrl.split('?')[0].replace(/\\/g, '/')
    const urlName = urlPath.split('/').pop()
    if (urlName) return urlName
  }

  switch (itemType) {
    case 2:
      return 'image.jpg'
    case 3:
      return 'voice.amr'
    case 5:
      return 'video.mp4'
    default:
      return 'file'
  }
}

function inboundMimeType(
  itemType: number,
  payload: InboundItemPayload,
  fileName: string,
): string {
  const declared =
    stringField(payload.mime_type) || stringField(payload.mimeType)
  if (declared) return declared
  if (itemType === 2) return 'image/jpeg'
  if (itemType === 3) return 'audio/amr'
  if (itemType === 5) return 'video/mp4'
  return mimeTypeFromFileName(fileName) ?? 'application/octet-stream'
}

function componentTypeForItem(
  itemType: number,
): DownloadableComponent['type'] | undefined {
  switch (itemType) {
    case 2:
      return 'image'
    case 3:
      return 'audio'
    case 4:
      return 'file'
    case 5:
      return 'video'
    default:
      return undefined
  }
}

function itemTypeForComponent(component: DownloadableComponent): number {
  switch (component.type) {
    case 'image':
      return 2
    case 'audio':
      return 3
    case 'file':
      return 4
    case 'video':
      return 5
  }
}

function isDownloadableComponent(
  component: MessageComponent,
): component is DownloadableComponent {
  return (
    component.type === 'image' ||
    component.type === 'file' ||
    component.type === 'audio' ||
    component.type === 'video'
  )
}

function decodeHexAesKey(value: string): Buffer {
  if (!/^[0-9a-f]{32}$/i.test(value)) {
    throw new Error('WeChat media AES key is not a 16-byte hexadecimal key.')
  }
  return Buffer.from(value, 'hex')
}

function decodeMediaAesKey(value: string): Buffer {
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    throw new Error('WeChat media AES key is not valid base64.')
  }
  if (decoded.byteLength === 16) return decoded

  const ascii = decoded.toString('utf8')
  if (decoded.byteLength === 32 && /^[0-9a-f]{32}$/i.test(ascii)) {
    return Buffer.from(ascii, 'hex')
  }
  throw new Error(
    'WeChat media AES key must decode to 16 raw bytes or 32 hexadecimal characters.',
  )
}

function safeTempFileName(fileName: string, fallback: string): string {
  const basename = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  const safe = Array.from(basename.replace(/[<>:"|?*]/g, '_'), (character) =>
    character.charCodeAt(0) < 0x20 ? '_' : character,
  )
    .join('')
    .replace(/^\.+$/, '')
    .trim()
  return safe || fallback
}

async function loadMediaCrypto(): Promise<MediaCrypto> {
  return loadDesktopNodeModule<MediaCrypto>('node:crypto')
}

function encryptedMediaSize(rawSize: number): number {
  return rawSize + (16 - (rawSize % 16) || 16)
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase()
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === target,
  )
  return entry?.[1]
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : JSON.stringify(error))
}

/** Abortable so backoff sleeps don't keep a real timer alive past `stop()` —
 * without this, `pollingController.abort()` mid-backoff would still leave the
 * loop (and its underlying timer) running for up to
 * `GETUPDATES_EXCEPTION_BACKOFF_MS`. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** iLink payload fields arrive as `unknown` (raw JSON) — avoids
 * `no-base-to-string` lint errors from `String(unknown)` on values that could
 * be non-primitive objects. */
function stringField(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

type CachedMessage = {
  messageId: string
  timestamp: number
}

type GetUpdatesResponseBody = {
  ret?: number
  errcode?: number
  errmsg?: string
  get_updates_buf?: string
  msgs?: Array<Record<string, unknown>>
}

type SendMessageResponseBody = {
  ret?: number
  errcode?: number
  errmsg?: string
  msg_id?: string | number
}

export type QRCodeRequestResult = {
  qrcode: string
  interval: number
  qrcodeUrl?: string
}

export type QRPollStatus = 'pending' | 'scanned' | 'expired' | 'confirmed'

export type QRPollResult = {
  status: QRPollStatus
  botToken?: string
  baseUrl?: string
  botId?: string
}

export class WeixinOCAdapter implements PlatformAdapter {
  readonly meta: PlatformMetadata = {
    name: 'weixin_oc',
    displayName: 'WeChat (Personal Account, iLink)',
    description:
      'Personal-WeChat iLink interface (long polling; text/image/file replies).',
    version: '1.0.0',
  }

  readonly capabilities: PlatformCapabilities = {
    markdownMode: 'none',
    supportsImage: true,
    supportsFile: true,
    supportsStreaming: false,
    maxMessageLength: 2048,
    maxImageSize: MAX_IMAGE_SIZE_BYTES,
    maxFileSize: MAX_FILE_SIZE_BYTES,
  }

  private readonly app: App | undefined
  private baseUrl: string
  private token: string | null = null
  private botId: string | undefined
  private syncBuf = ''
  private pollTimeoutMs = 40_000

  private status: 'stopped' | 'running' | 'degraded' | 'failed' = 'stopped'
  private readonly messageHandlers: MessageHandler[] = []
  private readonly errorHandlers: ErrorHandler[] = []

  // senderId -> last context_token. WeChat's iLink protocol requires echoing
  // the sender's most recent context_token on every reply — the bot cannot
  // initiate a conversation, so with no cached token there is nothing valid
  // to reply to.
  private readonly contextTokens = new BoundedTtlMap<string, string>({
    capacity: CONTEXT_TOKEN_CAPACITY,
    ttlMs: CONTEXT_TOKEN_TTL_MS,
  })
  // senderId -> recent inbound messages, kept for future reply-matching.
  private readonly recentMessages = new BoundedTtlMap<string, CachedMessage[]>({
    capacity: RECENT_MESSAGES_CAPACITY,
    ttlMs: RECENT_MESSAGES_TTL_MS,
  })
  private readonly inboundMedia = new WeakMap<
    DownloadableComponent,
    InboundItemPayload
  >()

  private pollingController: AbortController | null = null

  /**
   * `baseUrl` can be supplied up front so the Settings UI can drive the QR
   * login flow (`requestQRCode`/`pollQRStatus`) with a throwaway instance
   * before any `PlatformConfig`/`start()` call exists.
   */
  constructor(options: { app?: App; baseUrl?: string } = {}) {
    this.app = options.app
    this.baseUrl = options.baseUrl ?? 'https://ilinkai.weixin.qq.com'
  }

  async start(config: BotPlatformWeixinConfig): Promise<void> {
    this.baseUrl = config.baseUrl
    this.pollTimeoutMs = config.pollTimeoutMs
    this.botId = config.botId

    if (!config.botToken) {
      // No saved credentials — stay startable-but-unauthenticated so the
      // Settings UI can drive QR login rather than the adapter throwing.
      this.status = 'stopped'
      return
    }

    this.token = config.botToken
    await this.notifyStart()
    this.beginPolling()
  }

  async stop(): Promise<void> {
    this.stopPolling()
    this.status = 'stopped'
  }

  health(): 'running' | 'stopped' | 'degraded' | 'failed' {
    return this.status
  }

  // ─────────────────────────── QR login ───────────────────────────

  async requestQRCode(): Promise<QRCodeRequestResult> {
    const response = await requestUrl({
      url: `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
      method: 'GET',
      throw: false,
    })
    const responseBody = response.json as {
      qrcode?: string
      qrcode_img_content?: string
      interval?: number
    }
    if (!responseBody?.qrcode) {
      throw new Error('WeChat QR code request did not return a qrcode key.')
    }
    return {
      qrcode: responseBody.qrcode,
      interval: responseBody.interval ?? 2000,
      qrcodeUrl: responseBody.qrcode_img_content,
    }
  }

  /**
   * A single status check against the long-poll `get_qrcode_status`
   * endpoint. The caller (Settings UI) loops this until `status` is
   * `'confirmed'` or `'expired'`, optionally passing an `AbortSignal` to
   * cancel if e.g. the modal is closed mid-poll.
   */
  async pollQRStatus(
    qrcode: string,
    signal?: AbortSignal,
  ): Promise<QRPollResult> {
    const response = await this.longPollRequest(
      {
        url: `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}&bot_type=3`,
        method: 'GET',
      },
      { signal, timeoutMs: QR_POLL_TIMEOUT_MS },
    )
    const body = response.json as {
      status?: string
      bot_token?: string
      baseurl?: string
      bot_id?: string
      ilink_bot_id?: string
    }
    return {
      status: this.normalizeQrStatus(body?.status),
      botToken: body?.bot_token,
      baseUrl: body?.baseurl,
      botId: body?.bot_id ?? body?.ilink_bot_id,
    }
  }

  private normalizeQrStatus(value: string | undefined): QRPollStatus {
    if (value === 'scaned' || value === 'scanned') return 'scanned'
    if (value === 'expired' || value === 'confirmed') return value
    return 'pending'
  }

  // ─────────────────────────── Sending ───────────────────────────

  async sendMessage(
    sessionKey: string,
    content: ReplyContent,
  ): Promise<SentMessageRef[]> {
    if (!this.token) {
      throw new Error(
        'WeChat adapter is not logged in yet — complete QR login before sending.',
      )
    }

    const { chatId } = decodeSessionKey(sessionKey)
    const contextToken = this.contextTokens.get(chatId)
    if (!contextToken) {
      throw new Error(
        `No context_token cached for "${chatId}": WeChat's iLink protocol does not let the bot message a user first, they must message the bot before it can reply.`,
      )
    }

    let responseBody: SendMessageResponseBody | undefined
    try {
      // B4: the iLink sendmessage API silently truncates oversized text
      // payloads (the old `.slice(0, maxMessageLength)` in buildOutgoingItems
      // cut the reply tail off without any error). Send one message per chunk
      // at the platform cap (2048) instead; media-only sends keep their
      // single request.
      const perSendTexts = content.text
        ? splitTextAtBoundaries(content.text, this.capabilities.maxMessageLength)
        : []
      const hasMedia =
        (content.images?.length ?? 0) > 0 || (content.files?.length ?? 0) > 0
      // fix-round-1: media must NOT ride along on every text chunk — each
      // chunk would otherwise re-attach the same images/files and send them
      // N times. Text chunks are stripped of media; media is sent once on
      // its own trailing request (or as the only request for media-only
      // replies).
      const sends: ReplyContent[] = perSendTexts.map((text) => ({
        ...content,
        text,
        images: [],
        files: [],
      }))
      if (perSendTexts.length === 0 || hasMedia) {
        sends.push({ ...content, text: undefined })
      }
      const refs: SentMessageRef[] = []
      for (const sendContent of sends) {
        const items = await this.buildOutgoingItems(chatId, sendContent)
        if (items.length === 0) {
          throw new Error(
            'sendMessage called with no text/images/files content.',
          )
        }

        const body = JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: chatId,
            client_id: `yolo-${crypto.randomUUID()}`,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            context_token: contextToken,
            item_list: items,
          },
          base_info: this.baseInfo(), // top level, not nested in msg
        })

        const response = await requestUrl({
          url: `${this.baseUrl}/ilink/bot/sendmessage`,
          method: 'POST',
          headers: this.authHeaders(),
          body,
          throw: false,
        })
        responseBody = response.json as SendMessageResponseBody
        if (this.isProtocolError(responseBody)) {
          throw new Error(
            `WeChat sendmessage failed: ret=${responseBody.ret ?? 0} errcode=${responseBody.errcode ?? 0} ${responseBody.errmsg ?? ''}`.trim(),
          )
        }
        refs.push({
          platformMessageId: String(responseBody.msg_id ?? ''),
          sessionKey,
          timestamp: Date.now(),
        })
      }
      return refs
    } catch (error) {
      const err = toError(error)
      // Credential failures (no token / session-expired protocol error) are
      // not retryable — BotService surfaces them to the user instead of
      // letting the send vanish into the console. Transient failures stay
      // retryable so the UI does not spam notices on every network blip.
      const isCredentialFailure =
        err.message.includes('not logged in yet') ||
        (typeof responseBody?.errcode === 'number' &&
          responseBody.errcode === SESSION_EXPIRED_ERRCODE)
      this.emitError(err, {
        operation: 'send',
        sessionKey,
        retryable: isCredentialFailure ? false : true,
        raw: error,
      })
      throw err
    }
  }

  private async buildOutgoingItems(
    chatId: string,
    content: ReplyContent,
  ): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = []
    if (content.text) {
      items.push({
        type: 1,
        text_item: {
          text: content.text.slice(0, this.capabilities.maxMessageLength),
        },
      })
    }

    for (const image of content.images ?? []) {
      items.push(await this.prepareMediaItem(chatId, image, 'image'))
    }
    for (const file of content.files ?? []) {
      items.push(await this.prepareMediaItem(chatId, file, 'file'))
    }
    return items
  }

  private async prepareMediaItem(
    chatId: string,
    ref: ImageRef | FileRef,
    kind: 'image' | 'file',
  ): Promise<Record<string, unknown>> {
    const { bytes, fileName } = await this.resolveMediaBytes(ref)
    const maxSize =
      kind === 'image' ? MAX_IMAGE_SIZE_BYTES : MAX_FILE_SIZE_BYTES
    if (bytes.byteLength > maxSize) {
      throw new Error(
        `WeChat ${kind} exceeds the ${maxSize}-byte outgoing media limit.`,
      )
    }

    const nodeCrypto = await loadMediaCrypto()
    const rawBytes = Buffer.from(bytes)
    const aesKey = nodeCrypto.randomBytes(16)
    const aesKeyHex = aesKey.toString('hex')
    const fileKey = nodeCrypto.randomBytes(16).toString('hex')
    const rawSize = rawBytes.byteLength
    const encrypted = nodeCrypto.createCipheriv('aes-128-ecb', aesKey, null)
    encrypted.setAutoPadding(true)
    const encryptedBytes = Buffer.concat([
      encrypted.update(rawBytes),
      encrypted.final(),
    ])

    const uploadResponse = await requestUrl({
      url: `${this.baseUrl}/ilink/bot/getuploadurl`,
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        filekey: fileKey,
        media_type: kind === 'image' ? 1 : 3,
        to_user_id: chatId,
        rawsize: rawSize,
        rawfilemd5: nodeCrypto.createHash('md5').update(rawBytes).digest('hex'),
        filesize: encryptedMediaSize(rawSize),
        no_need_thumb: true,
        aeskey: aesKeyHex,
        base_info: this.baseInfo(),
      }),
      throw: false,
    })
    const uploadBody = uploadResponse.json as MediaUploadResponse
    if (this.isProtocolError(uploadBody)) {
      throw new Error(
        `WeChat getuploadurl failed: ret=${uploadBody.ret ?? 0} errcode=${uploadBody.errcode ?? 0} ${uploadBody.errmsg ?? ''}`.trim(),
      )
    }

    const uploadParam = uploadBody.upload_param?.trim()
    const uploadFullUrl = uploadBody.upload_full_url?.trim()
    const cdnUrl =
      uploadFullUrl ||
      (uploadParam
        ? `${MEDIA_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`
        : undefined)
    if (!cdnUrl) {
      throw new Error(
        'WeChat getuploadurl returned neither upload_full_url nor upload_param.',
      )
    }

    const cdnResponse = await requestUrl({
      url: cdnUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: toArrayBuffer(new Uint8Array(encryptedBytes)),
      throw: false,
    })
    if (cdnResponse.status < 200 || cdnResponse.status >= 300) {
      throw new Error(
        `WeChat CDN media upload failed with HTTP ${cdnResponse.status}.`,
      )
    }
    const encryptedQueryParam = headerValue(
      cdnResponse.headers,
      'x-encrypted-param',
    )
    if (!encryptedQueryParam) {
      throw new Error(
        'WeChat CDN media upload response did not include x-encrypted-param.',
      )
    }

    const media = {
      encrypt_query_param: encryptedQueryParam,
      aes_key: Buffer.from(aesKeyHex, 'utf8').toString('base64'),
      encrypt_type: 1,
    }
    if (kind === 'image') {
      return {
        type: 2,
        image_item: { media, mid_size: encryptedBytes.byteLength },
      }
    }
    return {
      type: 4,
      file_item: { media, file_name: fileName, len: String(rawSize) },
    }
  }

  private async resolveMediaBytes(
    ref: ImageRef | FileRef,
  ): Promise<{ bytes: Uint8Array; fileName: string }> {
    const fileName =
      'name' in ref && ref.name
        ? ref.name
        : 'label' in ref && ref.label
          ? ref.label
          : 'image.bin'

    let bytes: Uint8Array
    if (ref.source === 'url' && ref.url) {
      const response = await requestUrl({ url: ref.url, throw: false })
      if (response.status >= 400) {
        throw new Error(
          `WeChat attachment URL download failed with HTTP ${response.status}.`,
        )
      }
      bytes = new Uint8Array(response.arrayBuffer)
    } else if (ref.source === 'base64' && ref.dataBase64) {
      bytes = new Uint8Array(Buffer.from(ref.dataBase64, 'base64'))
    } else if (ref.source === 'vault-path' && ref.path) {
      if (!this.app) {
        throw new Error(
          `Cannot resolve vault attachment "${ref.path}" without an Obsidian App.`,
        )
      }
      bytes = new Uint8Array(
        await this.app.vault.adapter.readBinary(ref.path.replace(/^\/+/, '')),
      )
    } else {
      throw new Error(
        `Attachment has source "${ref.source}" but no matching data field is set.`,
      )
    }
    if (bytes.byteLength === 0) {
      throw new Error(`WeChat attachment "${fileName}" is empty.`)
    }
    return { bytes, fileName }
  }

  sendStreamingMessage(_sessionKey: string): StreamReplyHandle {
    throw new Error(
      'Streaming replies are not supported by the WeChat adapter (capabilities.supportsStreaming = false).',
    )
  }

  async downloadFile(component: MessageComponent): Promise<DownloadedFile> {
    try {
      if (!isDownloadableComponent(component)) {
        throw new Error(
          `Cannot download a "${component.type}" WeChat component.`,
        )
      }

      const item = this.inboundMedia.get(component)
      if (!item) {
        throw new Error(
          'WeChat media component is not associated with an inbound iLink item.',
        )
      }

      const itemType = itemTypeForComponent(component)
      const payload = getItemPayload(item, itemType)
      if (!payload) {
        throw new Error(
          `WeChat inbound media item ${itemType} has no payload object.`,
        )
      }

      const media = isRecord(payload.media) ? payload.media : undefined
      const directImageUrl =
        component.type === 'image' ? stringField(payload.url) : ''
      const fullUrl = media ? stringField(media.full_url) : ''
      const encryptedQueryParam = media
        ? stringField(media.encrypt_query_param)
        : ''
      const imageAesKey =
        component.type === 'image' ? stringField(payload.aeskey) : ''
      const mediaAesKey = stringField(media?.aes_key)
      const hasEncryptedMediaReference = Boolean(
        fullUrl || encryptedQueryParam || imageAesKey || mediaAesKey,
      )
      const url =
        fullUrl ||
        (encryptedQueryParam
          ? `${MEDIA_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
          : directImageUrl)
      const plaintextDownload =
        component.type === 'image' &&
        Boolean(directImageUrl) &&
        !hasEncryptedMediaReference
      if (!url) {
        throw new Error(
          `WeChat ${component.type} media has no downloadable URL or encrypted query parameter.`,
        )
      }

      const response = await requestUrl({
        url,
        method: 'GET',
        throw: false,
      })
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `WeChat media download failed with HTTP ${response.status}.`,
        )
      }

      const downloadedBytes = new Uint8Array(response.arrayBuffer)
      const maxBytes =
        component.type === 'image' ? MAX_IMAGE_SIZE_BYTES : MAX_FILE_SIZE_BYTES
      const maxEncryptedBytes = plaintextDownload ? maxBytes : maxBytes + 16
      if (downloadedBytes.byteLength > maxEncryptedBytes) {
        throw new Error(
          `WeChat ${component.type} media exceeds the ${maxBytes}-byte download limit.`,
        )
      }

      let plaintext = Buffer.from(downloadedBytes)
      if (!plaintextDownload) {
        const encodedAesKey = imageAesKey || mediaAesKey
        if (!encodedAesKey) {
          throw new Error(
            `WeChat encrypted ${component.type} media is missing an AES key.`,
          )
        }

        const aesKey = imageAesKey
          ? decodeHexAesKey(encodedAesKey)
          : decodeMediaAesKey(encodedAesKey)
        const nodeCrypto = await loadMediaCrypto()
        const decipher = nodeCrypto.createDecipheriv(
          'aes-128-ecb',
          aesKey,
          null,
        )
        decipher.setAutoPadding(true)
        plaintext = Buffer.concat([
          decipher.update(plaintext),
          decipher.final(),
        ])
      }

      if (plaintext.byteLength > maxBytes) {
        throw new Error(
          `WeChat ${component.type} media exceeds the ${maxBytes}-byte download limit after decryption.`,
        )
      }

      const fileName =
        component.type === 'file'
          ? component.name
          : inboundFileName(itemType, payload)
      const fallbackName =
        component.type === 'image'
          ? 'image.jpg'
          : component.type === 'audio'
            ? 'voice.amr'
            : component.type === 'video'
              ? 'video.mp4'
              : 'file'
      const safeFileName = safeTempFileName(fileName, fallbackName)

      const os = await import('node:os')
      const path = await import('node:path')
      const fs = await import('node:fs/promises')
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-weixin-'))
      const tempPath = path.join(tempDir, safeFileName)
      await fs.writeFile(tempPath, plaintext)
      const stat = await fs.stat(tempPath)
      return {
        fileName: safeFileName,
        mimeType:
          component.mimeType ??
          inboundMimeType(itemType, payload, safeFileName),
        size: stat.size,
        tempPath,
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

  // ─────────────────────────── Long-poll loop ───────────────────────────

  private beginPolling(): void {
    if (this.pollingController) return // already running
    this.pollingController = new AbortController()
    this.status = 'running'
    void this.runPollLoop(this.pollingController)
  }

  private stopPolling(): void {
    // `requestUrl` has no native cancellation (see `web-search/http.ts`), so
    // this only stops the loop from issuing further requests / acting on a
    // still-in-flight one — it does not cancel the underlying HTTP request.
    this.pollingController?.abort()
    this.pollingController = null
  }

  private async runPollLoop(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      let response: { json: unknown }
      try {
        const body = JSON.stringify({
          get_updates_buf: this.syncBuf,
          base_info: this.baseInfo(),
        })
        response = await this.longPollRequest(
          {
            url: `${this.baseUrl}/ilink/bot/getupdates`,
            method: 'POST',
            headers: this.authHeaders(),
            body,
          },
          {
            signal: controller.signal,
            timeoutMs: this.pollTimeoutMs + LONG_POLL_TIMEOUT_MARGIN_MS,
          },
        )
      } catch (_error) {
        if (controller.signal.aborted) return
        // Long-poll timeout (server held the connection with nothing new) or
        // a transient network failure — this is a long-poll design, so just
        // retry rather than treating it as fatal.
        const error = toError(_error)
        if (!error.message.startsWith('WeChat request timed out after ')) {
          this.status = 'degraded'
          this.emitError(error, {
            operation: 'receive',
            retryable: true,
            raw: _error,
          })
        }
        await sleep(GETUPDATES_EXCEPTION_BACKOFF_MS, controller.signal)
        continue
      }
      if (controller.signal.aborted) return

      const data = response.json as GetUpdatesResponseBody
      if (this.isProtocolError(data)) {
        if (data.errcode === SESSION_EXPIRED_ERRCODE) {
          this.token = null
          this.syncBuf = ''
          this.status = 'stopped'
          this.emitError(
            new Error('WeChat session expired; re-login (QR scan) required.'),
            { operation: 'receive', retryable: false, raw: data },
          )
          this.pollingController = null
          return
        }
        this.status = 'degraded'
        this.emitError(
          new Error(
            `WeChat getupdates error: ret=${data.ret ?? 0} errcode=${data.errcode ?? 0} ${data.errmsg ?? ''}`.trim(),
          ),
          { operation: 'receive', retryable: true, raw: data },
        )
        await sleep(GETUPDATES_PROTOCOL_ERROR_BACKOFF_MS, controller.signal)
        continue
      }

      this.status = 'running'
      if (data.get_updates_buf !== undefined) {
        this.syncBuf = data.get_updates_buf
      }

      for (const msg of data.msgs ?? []) {
        const event = this.convertToPlatformEvent(msg)
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
    }
  }

  private async notifyStart(): Promise<void> {
    if (!this.token) return

    const body = JSON.stringify({ base_info: this.baseInfo() })
    try {
      const response = await this.longPollRequest(
        {
          url: `${this.baseUrl}/ilink/bot/msg/notifystart`,
          method: 'POST',
          headers: this.authHeaders(),
          body,
        },
        { timeoutMs: CONNECTION_NOTIFY_TIMEOUT_MS },
      )
      const data = response.json as {
        ret?: number
        errcode?: number
        errmsg?: string
      }
      if (this.isProtocolError(data)) {
        throw new Error(
          `WeChat notifystart failed: ret=${data.ret ?? 0} errcode=${data.errcode ?? 0} ${data.errmsg ?? ''}`.trim(),
        )
      }
    } catch (error) {
      this.emitError(toError(error), {
        operation: 'start',
        retryable: true,
        raw: error,
      })
    }
  }

  /**
   * `wechat-ilink-demo` checks the top-level `ret` field; AstrBot's Python
   * port checks the nested `errcode` field (plan 3.1's reconciliation
   * table) — accept either being non-zero as an error so both upstream
   * protocol variants are handled.
   */
  private isProtocolError(data: { ret?: number; errcode?: number }): boolean {
    return Boolean(
      (data.ret && data.ret !== 0) || (data.errcode && data.errcode !== 0),
    )
  }

  private convertToPlatformEvent(
    msg: Record<string, unknown>,
  ): PlatformMessageEvent {
    const fromUserId = stringField(msg.from_user_id)
    const itemList = (msg.item_list as Array<Record<string, unknown>>) ?? []

    if (typeof msg.context_token === 'string' && msg.context_token) {
      this.contextTokens.set(fromUserId, msg.context_token)
    }

    const components: MessageComponent[] = []
    let plainText = ''
    for (const item of itemList) {
      const itemType = Number(item.type)
      if (itemType === 1) {
        const text =
          (item.text_item as { text?: string } | undefined)?.text ?? ''
        components.push({ type: 'text', text })
        plainText += text
        continue
      }
      const componentType = componentTypeForItem(itemType)
      const payload = getItemPayload(item, itemType)
      if (componentType && payload) {
        const fileName = inboundFileName(itemType, payload)
        const mimeType = inboundMimeType(itemType, payload, fileName)
        let component: DownloadableComponent
        switch (componentType) {
          case 'image':
            component = {
              type: 'image',
              ...(stringField(payload.url)
                ? { url: stringField(payload.url) }
                : {}),
              mimeType,
            }
            break
          case 'file': {
            const size = numericField(payload, 'len', 'size', 'file_size')
            component = {
              type: 'file',
              mimeType,
              name: fileName,
              ...(size !== undefined ? { size } : {}),
            }
            break
          }
          case 'audio': {
            const duration = numericField(
              payload,
              'duration',
              'duration_ms',
              'play_length',
            )
            component = {
              type: 'audio',
              mimeType,
              ...(duration !== undefined ? { duration } : {}),
            }
            break
          }
          case 'video':
            component = { type: 'video', mimeType }
            break
        }
        components.push(component)
        this.inboundMedia.set(component, item)
        continue
      }

      const kind =
        itemType === 2
          ? 'image'
          : itemType === 3
            ? 'voice'
            : itemType === 4
              ? 'file'
              : itemType === 5
                ? 'video'
                : `type-${itemType}`
      components.push({ type: 'unsupported', kind, raw: item })
    }

    const messageId = stringField(msg.message_id)
    const timestampMilliseconds =
      typeof msg.create_time_ms === 'number'
        ? msg.create_time_ms
        : typeof msg.timestamp === 'number'
          ? msg.timestamp * 1000
          : 0
    this.cacheRecentMessage(fromUserId, {
      messageId,
      timestamp: timestampMilliseconds,
    })

    // `wechat-ilink-demo` filters the bot's own echoed messages by
    // message_type === 2 OR a from_user_id ending in "@im.bot".
    const isFromBot = msg.message_type === 2 || fromUserId.endsWith('@im.bot')

    return {
      platformName: 'weixin_oc',
      messageId,
      sessionKey: encodeSessionKey('weixin_oc', 'private', fromUserId),
      chatType: 'private',
      senderId: fromUserId,
      senderName: fromUserId,
      message: {
        components,
        plainText,
        rawMessage: msg,
        timestamp: timestampMilliseconds,
      },
      isFromBot,
    }
  }

  private cacheRecentMessage(senderId: string, entry: CachedMessage): void {
    const existing = this.recentMessages.get(senderId) ?? []
    const next = [...existing, entry].slice(-RECENT_MESSAGES_PER_SESSION_CAP)
    this.recentMessages.set(senderId, next)
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': this.randomUin(),
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    return headers
  }

  private randomUin(): string {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]
    return Buffer.from(String(value), 'utf-8').toString('base64')
  }

  /**
   * Thin `requestUrl` wrapper adding client-side timeout + `AbortSignal`
   * support, mirroring `src/core/web-search/http.ts`'s `webSearchRequest` —
   * `requestUrl` doesn't natively honour either, so both race against the
   * underlying promise. Reused by both the QR-status poll and the
   * `getupdates` long-poll loop.
   */
  private async longPollRequest(
    params: RequestUrlParam,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ json: unknown }> {
    const requestPromise = requestUrl({ ...params, throw: false })
    const { signal, timeoutMs } = options
    if (!timeoutMs && !signal) return requestPromise

    return new Promise<{ json: unknown }>((resolve, reject) => {
      let settled = false
      const timer = timeoutMs
        ? setTimeout(() => {
            if (settled) return
            settled = true
            reject(new Error(`WeChat request timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        : null

      const onAbort = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        reject(new Error('WeChat request aborted'))
      }

      requestPromise.then(
        (response) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
          resolve(response)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
          reject(toError(error))
        },
      )

      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}
