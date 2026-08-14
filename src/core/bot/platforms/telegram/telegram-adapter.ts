/**
 * TelegramAdapter — `PlatformAdapter` implementation backed by
 * `node-telegram-bot-api` (long polling only, no webhook). Bot Platform
 * design doc, Phase 2.2.
 *
 * The installed SDK version (1.x) is a ground-up TypeScript rewrite with a
 * different API than the plan doc's pseudocode assumed (which targeted the
 * older 0.x API). Notable reconciliations, see the final report for the full
 * list:
 * - `reply_parameters` (not `reply_to_message_id`).
 * - A single `message` listener is registered — `processUpdate` always
 *   emits `message` in addition to the type-specific event (`photo`,
 *   `document`, ...), so registering both would double-process every media
 *   message. All components are built from the one `Message` object's
 *   fields.
 * - `bot.downloadFile(fileId, dir)` is used instead of manually resolving
 *   the file URL; `dir` must already exist, so a temp dir is created first.
 * - Error classes expose a `.code` field (`EFATAL`/`ETELEGRAM`/`EPARSE`)
 *   rather than requiring a message-string match.
 */
import type {
  ChatId,
  Message,
  MessageEntity,
  TelegramBot as TelegramBotClient,
} from 'node-telegram-bot-api'
import { App, FileSystemAdapter, Platform } from 'obsidian'

import type { BotPlatformTelegramConfig } from '../../../../settings/schema/setting.types'
import { validateOutgoingAttachmentSize } from '../../attachment-security'
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
  type PlatformMessageCommand,
  type PlatformMessageEvent,
  type PlatformMetadata,
  type ReplyContent,
  type SentMessageRef,
  type StreamReplyHandle,
  decodeSessionKey,
  encodeSessionKey,
} from '../../types'

const RECOVERY_THRESHOLD = 3
const FAILURE_WINDOW_MS = 60_000

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : JSON.stringify(error))
}

function isFatalPollingError(error: Error): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'EFATAL' || error.message.includes('EFATAL')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

export class TelegramAdapter implements PlatformAdapter {
  readonly meta: PlatformMetadata = {
    name: 'telegram',
    displayName: 'Telegram',
    description:
      'Telegram Bot API adapter (long polling; MVP: text/image/file, final-only replies).',
    version: '1.0.0',
  }

  readonly capabilities: PlatformCapabilities = {
    markdownMode: 'none',
    supportsImage: true,
    supportsFile: true,
    supportsStreaming: false,
    maxMessageLength: 4096,
    maxImageSize: 10 * 1024 * 1024,
    maxFileSize: 50 * 1024 * 1024,
  }

  private readonly app: App
  private bot: TelegramBotClient | null = null
  private botUsername: string | undefined
  private status: 'stopped' | 'running' | 'degraded' | 'failed' = 'stopped'
  private readonly messageHandlers: MessageHandler[] = []
  private readonly errorHandlers: ErrorHandler[] = []
  private pollingFailures = 0
  private lastPollingFailureAt = 0

  constructor(app: App) {
    this.app = app
  }

  async start(config: BotPlatformTelegramConfig): Promise<void> {
    if (Platform.isMobile) {
      throw new Error('The Telegram bot platform is desktop-only.')
    }

    const { TelegramBot } = await import('node-telegram-bot-api')

    const bot = new TelegramBot(config.botToken, {
      polling: {
        interval: config.pollingIntervalMs,
        params:
          config.startupUpdatePolicy === 'skip' ? { offset: -1 } : undefined,
      },
    })

    bot.on('message', (msg) => this.handleTelegramMessage(msg))
    bot.on('polling_error', (error) => this.handlePollingError(toError(error)))
    bot.on('error', (error) => this.handleFatalError(toError(error)))

    // Fail fast instead of degrading silently: without the bot username the
    // group-chat "@bot" wake check can never fire, and the operator would have
    // no idea why mentions are ignored.
    try {
      const me = await bot.getMe()
      this.botUsername = me.username
    } catch (error) {
      const err = toError(error)
      this.emitError(err, { operation: 'start', raw: error })
      try {
        await bot.stopPolling()
      } catch (stopError) {
        this.emitError(toError(stopError), {
          operation: 'stop',
          raw: stopError,
        })
      }
      throw err
    }

    this.bot = bot
    this.pollingFailures = 0
    this.lastPollingFailureAt = 0
    this.status = 'running'
  }

  async stop(): Promise<void> {
    const bot = this.bot
    this.bot = null
    this.status = 'stopped'
    if (!bot) return
    try {
      await bot.stopPolling()
    } catch (error) {
      this.emitError(toError(error), { operation: 'stop', raw: error })
    }
  }

  health(): 'running' | 'stopped' | 'degraded' | 'failed' {
    return this.status
  }

  /** The bot username (`me.username`) that `targetBotId` in `/cmd@username`
   * commands refers to — resolved during `start()`, undefined before then. */
  getBotUsername(): string | undefined {
    return this.botUsername
  }

  async sendMessage(
    sessionKey: string,
    content: ReplyContent,
    options?: { progress?: (percent: number) => void },
  ): Promise<SentMessageRef[]> {
    const bot = this.bot
    if (!bot) throw new Error('Telegram adapter is not started.')

    const { chatId, threadId } = decodeSessionKey(sessionKey)
    const targetChatId: ChatId = chatId
    // B3: the session key encodes the topic thread (see convertToPlatformEvent
    // — encodeSessionKey with msg.message_thread_id); a reply must carry
    // message_thread_id back or it lands in the channel's general thread
    // instead of the topic the message came from.
    const messageThreadId = threadId ? Number(threadId) : undefined
    const replyParameters = content.replyToMessageId
      ? { message_id: Number(content.replyToMessageId) }
      : undefined
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

    try {
      if (content.text) {
        const chunks = splitTextAtBoundaries(
          content.text,
          this.capabilities.maxMessageLength,
        )
        for (const chunk of chunks) {
          const sent = await bot.sendMessage(targetChatId, chunk, {
            message_thread_id: messageThreadId,
            reply_parameters: replyParameters,
          })
          refs.push({
            platformMessageId: String(sent.message_id),
            sessionKey,
            timestamp: sent.date * 1000,
          })
        }
        reportProgress()
      }

      for (const image of content.images ?? []) {
        const input = await this.resolveOutgoingFile(image)
        const imageSize =
          typeof input === 'string' ? undefined : input.byteLength
        if (imageSize !== undefined) {
          const validation = validateOutgoingAttachmentSize({
            kind: 'image',
            byteLength: imageSize,
            maxBytes: this.capabilities.maxImageSize,
            name: image.label ?? 'image',
          })
          if (!validation.ok) throw new Error(validation.error)
        }
        const sent = await bot.sendPhoto(targetChatId, input, {
          message_thread_id: messageThreadId,
          caption: image.label,
          reply_parameters: replyParameters,
        })
        refs.push({
          platformMessageId: String(sent.message_id),
          sessionKey,
          timestamp: sent.date * 1000,
        })
        reportProgress()
      }

      for (const file of content.files ?? []) {
        const input = await this.resolveOutgoingFile(file)
        const fileSize =
          typeof input === 'string' ? file.size : input.byteLength
        if (fileSize !== undefined) {
          const validation = validateOutgoingAttachmentSize({
            kind: 'file',
            byteLength: fileSize,
            maxBytes: this.capabilities.maxFileSize,
            name: file.name,
          })
          if (!validation.ok) throw new Error(validation.error)
        }
        const sent = await bot.sendDocument(
          targetChatId,
          input,
          {
            message_thread_id: messageThreadId,
            caption: file.name,
            reply_parameters: replyParameters,
          },
          { filename: file.name, contentType: file.mimeType },
        )
        refs.push({
          platformMessageId: String(sent.message_id),
          sessionKey,
          timestamp: sent.date * 1000,
        })
        reportProgress()
      }
    } catch (error) {
      const err = toError(error)
      this.emitError(err, { operation: 'send', sessionKey, raw: error })
      throw err
    }

    return refs
  }

  sendStreamingMessage(_sessionKey: string): StreamReplyHandle {
    throw new Error(
      'Streaming replies are not supported by the Telegram adapter in MVP.',
    )
  }

  async downloadFile(component: MessageComponent): Promise<DownloadedFile> {
    const bot = this.bot
    if (!bot) throw new Error('Telegram adapter is not started.')

    const fileId = getComponentFileId(component)
    if (!fileId) {
      throw new Error(
        `Cannot download a "${component.type}" component: no fileId present.`,
      )
    }

    try {
      const os = await import('node:os')

      const path = await import('node:path')

      const fs = await import('node:fs/promises')
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-telegram-'))
      const filePath = await bot.downloadFile(fileId, tempDir)
      const stat = await fs.stat(filePath)
      const fileName =
        component.type === 'file' ? component.name : path.basename(filePath)
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

  private handlePollingError(error: Error): void {
    if (isFatalPollingError(error)) {
      this.status = 'failed'
      this.emitError(error, {
        operation: 'receive',
        retryable: false,
        raw: error,
      })
      return
    }

    const now = Date.now()
    if (now - this.lastPollingFailureAt > FAILURE_WINDOW_MS) {
      this.pollingFailures = 0
    }
    this.pollingFailures += 1
    this.lastPollingFailureAt = now
    this.status = 'degraded'
    this.emitError(error, { operation: 'receive', retryable: true, raw: error })

    if (this.pollingFailures >= RECOVERY_THRESHOLD) {
      this.pollingFailures = 0
      void this.recreatePolling()
    }
  }

  private handleFatalError(error: Error): void {
    this.status = 'failed'
    this.emitError(error, {
      operation: 'receive',
      retryable: false,
      raw: error,
    })
  }

  private async recreatePolling(): Promise<void> {
    const bot = this.bot
    if (!bot) return
    try {
      await bot.stopPolling()
      // A stop() (or a replacement start) that landed while the polling
      // teardown was in flight must not resurrect a dead bot: `this.bot`
      // is nulled by stop() and replaced by a new start(), so the identity
      // check below is the stopped/destroyed guard.
      if (this.bot !== bot) return
      await bot.startPolling({ restart: true })
      if (this.bot !== bot) return
      this.status = 'running'
    } catch (error) {
      const err = toError(error)
      this.status = 'failed'
      this.emitError(err, {
        operation: 'receive',
        retryable: false,
        raw: error,
      })
    }
  }

  private handleTelegramMessage(msg: Message): void {
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

  private convertToPlatformEvent(msg: Message): PlatformMessageEvent {
    const chatType = msg.chat.type === 'private' ? 'private' : 'group'
    const chatId = String(msg.chat.id)
    const threadId = msg.message_thread_id
      ? String(msg.message_thread_id)
      : undefined
    const sessionKey = encodeSessionKey('telegram', chatType, chatId, threadId)
    const sourceText = msg.text ?? msg.caption ?? ''

    const components: MessageComponent[] = []
    if (msg.text) {
      components.push({ type: 'text', text: msg.text })
    }
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1]
      components.push({
        type: 'image',
        fileId: largest.file_id,
        mimeType: 'image/jpeg',
      })
    }
    if (msg.document) {
      components.push({
        type: 'file',
        fileId: msg.document.file_id,
        mimeType: msg.document.mime_type ?? 'application/octet-stream',
        name: msg.document.file_name ?? 'file',
        size: msg.document.file_size,
      })
    }
    if (msg.voice) {
      components.push({
        type: 'audio',
        fileId: msg.voice.file_id,
        mimeType: msg.voice.mime_type ?? 'audio/ogg',
        duration: msg.voice.duration,
      })
    }
    if (msg.video) {
      components.push({
        type: 'video',
        fileId: msg.video.file_id,
        mimeType: msg.video.mime_type ?? 'video/mp4',
      })
    }
    if (msg.caption && (msg.photo || msg.document || msg.voice || msg.video)) {
      components.push({ type: 'text', text: msg.caption })
    }

    const entities = msg.entities ?? msg.caption_entities
    if (entities) {
      for (const entity of entities) {
        if (entity.type === 'text_mention' && entity.user) {
          const displayName =
            entity.user.username ??
            `${entity.user.first_name}${entity.user.last_name ? ` ${entity.user.last_name}` : ''}`
          components.push({
            type: 'mention',
            userId: String(entity.user.id),
            displayName,
          })
        }
      }
    }

    if (msg.reply_to_message) {
      const preview =
        msg.reply_to_message.text ?? msg.reply_to_message.caption ?? ''
      components.push({
        type: 'reply_to',
        messageId: String(msg.reply_to_message.message_id),
        preview,
      })
    }

    if (components.length === 0) {
      components.push({
        type: 'unsupported',
        kind: this.describeUnsupportedMessage(msg),
        raw: msg,
      })
    }

    const command = this.parseCommand(entities, sourceText)
    const mentionedBotId = this.parseMentionedBotId(sourceText)

    const senderId = msg.from
      ? String(msg.from.id)
      : msg.sender_chat
        ? String(msg.sender_chat.id)
        : 'unknown'
    const senderName = msg.from
      ? `${msg.from.first_name}${msg.from.last_name ? ` ${msg.from.last_name}` : ''}`
      : (msg.sender_chat?.title ?? 'Unknown')

    return {
      platformName: 'telegram',
      messageId: String(msg.message_id),
      sessionKey,
      chatType,
      senderId,
      senderName,
      message: {
        components,
        plainText: sourceText,
        rawMessage: msg,
        timestamp: msg.date * 1000,
      },
      threadId,
      command,
      mentionedBotId,
      isFromBot: msg.from?.is_bot ?? false,
    }
  }

  private describeUnsupportedMessage(msg: Message): string {
    const knownKinds: Array<[string, unknown]> = [
      ['sticker', msg.sticker],
      ['location', msg.location],
      ['contact', msg.contact],
      ['poll', msg.poll],
      ['animation', msg.animation],
      ['video_note', msg.video_note],
      ['dice', msg.dice],
      ['venue', msg.venue],
    ]
    const match = knownKinds.find(([, value]) => value !== undefined)
    return match ? match[0] : 'unknown'
  }

  private parseCommand(
    entities: MessageEntity[] | undefined,
    sourceText: string,
  ): PlatformMessageCommand | undefined {
    if (!entities) return undefined
    const botCommandEntity = entities.find(
      (entity) => entity.type === 'bot_command',
    )
    if (!botCommandEntity) return undefined

    const cmdText = sourceText.substring(
      botCommandEntity.offset,
      botCommandEntity.offset + botCommandEntity.length,
    )
    const atIdx = cmdText.indexOf('@')
    const name = atIdx > 0 ? cmdText.substring(1, atIdx) : cmdText.substring(1)
    const targetBotId = atIdx > 0 ? cmdText.substring(atIdx + 1) : undefined
    const args = sourceText
      .slice(botCommandEntity.offset + botCommandEntity.length)
      .trim()

    return { name, targetBotId, args: args.length > 0 ? args : undefined }
  }

  private parseMentionedBotId(sourceText: string): string | undefined {
    if (!this.botUsername) return undefined
    const pattern = new RegExp(`@${escapeRegExp(this.botUsername)}\\b`, 'i')
    return pattern.test(sourceText) ? this.botUsername : undefined
  }

  private async resolveOutgoingFile(
    ref: ImageRef | FileRef,
  ): Promise<Buffer | string> {
    if (ref.source === 'url' && ref.url) return ref.url
    if (ref.source === 'base64' && ref.dataBase64) {
      return Buffer.from(ref.dataBase64, 'base64')
    }
    if (ref.source === 'vault-path' && ref.path) {
      const absolutePath = this.resolveVaultAbsolutePath(ref.path)
      if (!absolutePath) {
        throw new Error(
          `Cannot resolve vault path "${ref.path}": vault adapter is not filesystem-backed.`,
        )
      }

      const fs = await import('node:fs/promises')
      return fs.readFile(absolutePath)
    }
    throw new Error(
      `Attachment has source "${ref.source}" but no matching data field is set.`,
    )
  }

  private resolveVaultAbsolutePath(relativePath: string): string | undefined {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) return undefined
    const basePath = adapter.getBasePath()
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    return `${basePath}/${normalized}`
  }
}
