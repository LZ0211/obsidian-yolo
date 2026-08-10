/**
 * Bot Platform — shared core types.
 *
 * Source of truth: `docs/superpowers/specs/2026-07-06-bot-platform-design.md`
 * ("Core Abstractions" section) and
 * `docs/superpowers/specs/2026-07-06-bot-platform-implementation-plan.md`
 * (Phase 1.1, plus the Telegram/WeChat pseudocode in Phase 2/3 that
 * constructs these types). Kept verbatim where the design doc gives an
 * authoritative shape; see the bottom of this file for a note on the couple
 * of places where this implementation had to make an explicit choice.
 */

import type { SessionMapping } from '../../settings/schema/setting.types'

// Re-exported so the rest of the bot module has a single import surface —
// the Zod-inferred settings type is the source of truth, not a parallel copy.
export type { SessionMapping }

export type PlatformMetadata = {
  name: string
  displayName: string
  description: string
  version: string
}

// ─────────────────────────── Incoming ───────────────────────────

export type MessageComponent =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; fileId?: string; mimeType?: string }
  | {
      type: 'file'
      url?: string
      fileId?: string
      mimeType: string
      name: string
      size?: number
    }
  | {
      type: 'audio'
      url?: string
      fileId?: string
      mimeType: string
      duration?: number
    }
  | { type: 'video'; url?: string; fileId?: string; mimeType: string }
  | { type: 'mention'; userId: string; displayName: string }
  | { type: 'reply_to'; messageId: string; preview: string }
  | { type: 'unsupported'; kind: string; raw: unknown; summary?: string }

export type PlatformMessage = {
  components: MessageComponent[]
  plainText: string
  rawMessage: unknown
  timestamp: number
}

export type PlatformMessageCommand = {
  /** e.g. 'help', 'reset', 'status' — without the leading slash. */
  name: string
  /** Telegram: '/help@MyBot' -> 'MyBot'. Undefined when the command has no explicit target. */
  targetBotId?: string
  args?: string
}

export type PlatformMessageEvent = {
  platformName: string
  /** Platform message id, unique within the chat. */
  messageId: string
  /** 'platform:chatType:encodedChatId[:thread:encodedThreadId]' — see encodeSessionKey. */
  sessionKey: string
  chatType: 'private' | 'group'
  senderId: string
  senderName: string
  message: PlatformMessage
  threadId?: string
  /** Adapter-parsed slash command, if any. */
  command?: PlatformMessageCommand
  mentionedBotId?: string
  /** Must be set to true by the adapter to prevent echo loops. */
  isFromBot?: boolean
}

// ─────────────────────────── Outgoing ───────────────────────────

export type ImageRef = {
  source: 'vault-path' | 'url' | 'base64'
  path?: string
  url?: string
  dataBase64?: string
  mimeType: string
  label?: string
}

export type FileRef = {
  source: 'vault-path' | 'url' | 'base64'
  path?: string
  url?: string
  dataBase64?: string
  mimeType: string
  name: string
  size?: number
}

export type ReplyContent = {
  text?: string
  images?: ImageRef[]
  files?: FileRef[]
  replyToMessageId?: string
}

export type SentMessageRef = {
  platformMessageId: string
  sessionKey: string
  timestamp: number
}

export type StreamReplyHandle = {
  /** Full text, not a delta. */
  update(fullText: string): Promise<void>
  /** Waits for any pending update() before completing. */
  finish(content: ReplyContent): Promise<SentMessageRef[]>
  abort(): Promise<void>
}

export type PlatformErrorContext = {
  operation: 'start' | 'stop' | 'receive' | 'send' | 'upload' | 'stream-update'
  sessionKey?: string
  messageId?: string
  retryable?: boolean
  raw?: unknown
}

export type DownloadedFile = {
  fileName: string
  mimeType: string
  size: number
  /** Absolute path in the system temp directory. */
  tempPath: string
}

export type MessageHandler = (
  event: PlatformMessageEvent,
) => void | Promise<void>
export type ErrorHandler = (
  error: Error,
  adapter: PlatformAdapter,
  context?: PlatformErrorContext,
) => void

export type PlatformCapabilities = {
  markdownMode: 'none' | 'telegram-markdown-v2' | 'html' | 'basic'
  supportsImage: boolean
  supportsFile: boolean
  /** MVP: always false (final-only sending). */
  supportsStreaming: boolean
  maxMessageLength: number
  /** bytes */
  maxImageSize: number
  /** bytes */
  maxFileSize: number
}

/**
 * Per-adapter config shape. Kept as `Record<string, unknown>` at the
 * interface boundary (matches the design doc) — concrete adapters (Telegram,
 * WeChat, DingTalk) narrow this to their own Zod-inferred config type in
 * their `start()` override; TypeScript's bivariant method-parameter checking
 * for interface implementations allows that narrowing.
 */
export type PlatformConfig = Record<string, unknown>

export type PlatformAdapter = {
  readonly meta: PlatformMetadata
  readonly capabilities: PlatformCapabilities

  start(config: PlatformConfig): Promise<void>
  stop(): Promise<void>
  health(): 'running' | 'stopped' | 'degraded' | 'failed'

  sendMessage(
    sessionKey: string,
    content: ReplyContent,
    options?: { progress?: (percent: number) => void },
  ): Promise<SentMessageRef[]>

  /** MVP: throws when `capabilities.supportsStreaming` is false. */
  sendStreamingMessage(sessionKey: string): StreamReplyHandle

  /** Downloads a platform file (image/file/audio/video component) to a temp path. */
  downloadFile(component: MessageComponent): Promise<DownloadedFile>

  onMessage(handler: MessageHandler): () => void
  onError(handler: ErrorHandler): () => void
}
// Adapters handle their own connection retry; BotService observes health()
// and reacts to onError(). Every adapter's onMessage callers must guard
// against unhandled rejections:
//   Promise.resolve(handler(event)).catch(err => this.emitError(err))

// ─────────────────────────── Session key ───────────────────────────

export type DecodedSessionKey = {
  platform: string
  chatType: string
  chatId: string
  threadId?: string
}

/**
 * Format: `platform:chatType:encodedChatId[:thread:encodedThreadId]`.
 *
 * `chatId`/`threadId` are individually `encodeURIComponent`-escaped so a raw
 * id containing ':' (or any other delimiter-looking character) can never be
 * confused with the session-key's own separators.
 */
export function encodeSessionKey(
  platform: string,
  chatType: string,
  chatId: string,
  threadId?: string,
): string {
  const base = `${platform}:${chatType}:${encodeURIComponent(chatId)}`
  return threadId ? `${base}:thread:${encodeURIComponent(threadId)}` : base
}

export function decodeSessionKey(key: string): DecodedSessionKey {
  const parts = key.split(':')
  if (parts.length < 3) {
    throw new Error(`Invalid sessionKey: ${key}`)
  }
  const platform = parts[0]
  const chatType = parts[1]
  if (chatType !== 'private' && chatType !== 'group') {
    throw new Error(`Invalid chatType in sessionKey: ${key}`)
  }
  // parts[2] is normally the encoded chatId, but encodeURIComponent never
  // produces a literal ':' so this loop is defensive rather than load-bearing.
  let chatIdEnd = 2
  while (chatIdEnd < parts.length && parts[chatIdEnd] !== 'thread') {
    chatIdEnd++
  }
  const chatIdRaw = parts.slice(2, chatIdEnd).join(':')
  if (chatIdRaw === '') {
    throw new Error(`Invalid sessionKey (empty chatId): ${key}`)
  }
  const chatId = decodeURIComponent(chatIdRaw)
  const threadId =
    chatIdEnd < parts.length - 1
      ? decodeURIComponent(parts.slice(chatIdEnd + 1).join(':'))
      : undefined
  return { platform, chatType, chatId, threadId }
}

/**
 * Notes on decisions made because the plan/design docs left the exact shape
 * ambiguous (see final report for the full rationale):
 *
 * - `MessageComponent` union: taken verbatim from the design doc's Core
 *   Abstractions section (image/audio/video `mimeType` optional for image
 *   only, matching how the Telegram/WeChat adapter pseudocode constructs
 *   these components).
 * - Session key string format: `platform:chatType:chatId[:thread:threadId]`
 *   with per-segment `encodeURIComponent`, taken verbatim from the design
 *   doc's `encodeSessionKey`/`decodeSessionKey` reference implementation.
 * - `PlatformConfig` stays the loose `Record<string, unknown>` from the
 *   design doc at the interface boundary; concrete adapters use their own
 *   narrower config type (not defined here — that's Phase 2/3/4 scope).
 */
