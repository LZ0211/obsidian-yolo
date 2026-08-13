/**
 * Message conversion between `PlatformMessageEvent` (incoming, platform ->
 * YOLO) and `ReplyContent`/`send_attachment` tool calls (outgoing, YOLO ->
 * platform). Bot Platform implementation plan, Phase 1.3:
 * `platformToUserMessage()`, `scanForSendAttachment()`,
 * `convertAttachmentsToReply()`.
 *
 * Kept free of Obsidian imports (no `TFile`/`Vault`), matching the "no
 * Obsidian deps" spirit of the rest of Phase 1 — see the final report for
 * the rationale on why incoming attachment -> `Mentionable` resolution is
 * DI'd out (`resolveMentionableFile`) rather than done here directly.
 */
import type { ChatMessage } from '../../types/chat'
import type { Mentionable } from '../../types/mentionable'
import { getToolCallArgumentsObject } from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { parseToolName } from '../mcp/tool-name-utils'

import type {
  FileRef,
  ImageRef,
  MessageComponent,
  PlatformMessageEvent,
} from './types'

export const SEND_ATTACHMENT_TOOL_NAME = 'send_attachment'

// ─────────────────────────── Incoming ───────────────────────────

/**
 * Describes one incoming attachment component after `BotService` has
 * attempted to download it. Attachments that were skipped (e.g. too large,
 * per the design doc's "Incoming 附件下载策略") carry `skippedReason` and no
 * `vaultPath`.
 */
export type IncomingAttachmentResult = {
  component: MessageComponent
  vaultPath?: string
  size?: number
  skippedReason?: string
}

export type PlatformToUserMessageOptions = {
  attachments?: IncomingAttachmentResult[]
  /**
   * Resolves a vault-relative path (already-downloaded attachment) to a
   * `Mentionable`. Left undefined by pure/unit-test callers; `BotService`
   * supplies a real implementation backed by `app.vault.getAbstractFileByPath`
   * since building a `MentionableFile` requires an actual `TFile` instance,
   * which this Obsidian-independent module cannot construct itself.
   */
  resolveMentionableFile?: (vaultPath: string) => Mentionable | undefined
}

export type PlatformToUserMessageResult = {
  promptContent: string
  mentionables: Mentionable[]
}

function describeAttachment(attachment: IncomingAttachmentResult): string {
  const name = componentDisplayName(attachment.component)
  if (attachment.skippedReason) {
    return `[User shared: ${name}, ${attachment.skippedReason}]`
  }
  const sizeSuffix =
    attachment.size !== undefined ? ` (${attachment.size} bytes)` : ''
  return `[User shared: ${name}${sizeSuffix}]`
}

function componentDisplayName(component: MessageComponent): string {
  switch (component.type) {
    case 'file':
      return component.name
    case 'image':
      return 'image'
    case 'audio':
      return 'audio'
    case 'video':
      return 'video'
    default:
      return component.type
  }
}

/**
 * Builds the plain-text prompt content (+ resolved mentionables) for a new
 * `ChatUserMessage` from an incoming platform message. Reply-to and mention
 * components are folded into the text as simple bracketed prefixes — MVP
 * doesn't attempt to resolve `reply_to.messageId` back into quoted content
 * (the platform-message id space isn't reliably reverse-lookupable without
 * per-platform history APIs); `preview` (when the adapter provides one) is
 * used verbatim instead.
 */
export function platformToUserMessage(
  event: PlatformMessageEvent,
  options: PlatformToUserMessageOptions = {},
): PlatformToUserMessageResult {
  const parts: string[] = []

  for (const component of event.message.components) {
    if (component.type === 'reply_to' && component.preview) {
      parts.push(`[Replying to: ${component.preview}]`)
    }
    if (component.type === 'mention') {
      parts.push(`[Mentioned: ${component.displayName}]`)
    }
    if (component.type === 'unsupported') {
      parts.push(
        `[Unsupported ${component.kind} content${component.summary ? `: ${component.summary}` : ''}]`,
      )
    }
  }

  if (event.message.plainText) {
    parts.push(event.message.plainText)
  }

  const mentionables: Mentionable[] = []
  for (const attachment of options.attachments ?? []) {
    parts.push(describeAttachment(attachment))
    if (attachment.vaultPath && options.resolveMentionableFile) {
      const mentionable = options.resolveMentionableFile(attachment.vaultPath)
      if (mentionable) mentionables.push(mentionable)
    }
  }

  return { promptContent: parts.join('\n'), mentionables }
}

// ─────────────────────────── Outgoing ───────────────────────────

export type SendAttachmentCall = {
  toolCallId: string
  path: string
  label?: string
}

function isSendAttachmentRequestName(name: string): boolean {
  try {
    return parseToolName(name).toolName === SEND_ATTACHMENT_TOOL_NAME
  } catch {
    // Built-in local tools may be registered unprefixed in some contexts;
    // fall back to a direct name match so a bare 'send_attachment' (no
    // 'server__' prefix) is still recognized.
    return name === SEND_ATTACHMENT_TOOL_NAME
  }
}

/**
 * Scans a conversation's messages for every completed `send_attachment` tool
 * call. Per the design doc's v4 review note #4, the `tool` event stream
 * itself doesn't carry `arguments` — callers must reverse-look-up the full
 * `ChatToolMessage.toolCalls[].request.arguments` from the same
 * `state.messages` snapshot, which is exactly what this function does.
 */
export function scanForSendAttachment(
  messages: ChatMessage[],
): SendAttachmentCall[] {
  const calls: SendAttachmentCall[] = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const toolCall of message.toolCalls) {
      if (!isSendAttachmentRequestName(toolCall.request.name)) continue
      if (toolCall.response.status !== ToolCallResponseStatus.Success) continue
      const args = getToolCallArgumentsObject(toolCall.request.arguments)
      const path = args?.path
      if (typeof path !== 'string' || path.length === 0) continue
      const label = typeof args?.label === 'string' ? args.label : undefined
      calls.push({ toolCallId: toolCall.request.id, path, label })
    }
  }
  return calls
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

function getExtension(path: string): string | undefined {
  const fileName = path.split('/').pop() ?? path
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex === -1 || dotIndex === fileName.length - 1) return undefined
  return fileName.slice(dotIndex + 1).toLowerCase()
}

export type ConvertAttachmentsToReplyResult = {
  images: ImageRef[]
  files: FileRef[]
}

/**
 * Converts resolved `send_attachment` calls into `ReplyContent` refs.
 * Deliberately produces `source: 'vault-path'` refs rather than reading file
 * bytes itself — actual size/allowDir re-validation is the
 * `BotOutputDispatcher`'s job (Phase 5, "二次验证"), and adapters that accept
 * `vault-path` refs read the bytes themselves at send time. `mimeType` here
 * is a best-effort extension-based guess only.
 */
export function convertAttachmentsToReply(
  calls: SendAttachmentCall[],
): ConvertAttachmentsToReplyResult {
  const images: ImageRef[] = []
  const files: FileRef[] = []

  for (const call of calls) {
    const extension = getExtension(call.path)
    const fileName = call.path.split('/').pop() ?? call.path
    if (extension && IMAGE_EXTENSIONS.has(extension)) {
      images.push({
        source: 'vault-path',
        path: call.path,
        mimeType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}`,
        label: call.label,
      })
    } else {
      // FileRef has no `label` field (unlike ImageRef) — the design doc's
      // send_attachment `label` is a description for *images*; for generic
      // files the vault-relative `name` already conveys enough context.
      files.push({
        source: 'vault-path',
        path: call.path,
        mimeType: 'application/octet-stream',
        name: fileName,
      })
    }
  }

  return { images, files }
}
