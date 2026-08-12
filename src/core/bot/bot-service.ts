/**
 * BotService — top-level lifecycle + incoming-message pipeline for the Bot
 * Platform. Bot Platform implementation plan, Phase 1.2, and design doc's
 * "核心设计原则" #4 ("Adapter 只做协议：消息转换、去重、权限、wakeCheck 全部在
 * BotService 层").
 *
 * Lifecycle follows `McpManager` (`src/core/mcp/mcpManager.ts`) per the
 * design doc's v4 review note #8: constructor DI + `initialize()`/
 * `cleanup()` called from `main.ts`, settings changes diffed via an
 * injected `registerSettingsListener`.
 *
 * The agent-run wiring (design doc's Incoming Flow step 10) is Phase 5
 * scope: `runBotTurn` below hands off to `runBotAgentTurn`
 * (`./agent-runner.ts`), which subscribes to `agentService` via the existing
 * `streamResolvedAgentRunEvents` (`agent-api.ts`) and streams the reply back
 * through the originating `PlatformAdapter`.
 */
import isEqual from 'lodash.isequal'
import { type App, TFile } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import type {
  BotPlatformConfig,
  BotsSettings,
  SessionMapping,
  YoloSettings,
} from '../../settings/schema/setting.types'
import type { Mentionable } from '../../types/mentionable'
import type { AgentService } from '../agent/service'
import type { ChatMessage } from '../../types/chat'
import type { McpManager } from '../mcp/mcpManager'
import { getYoloBaseDir } from '../paths/yoloPaths'

import { runBotAgentTurn } from './agent-runner'
import { BotOutbox } from './bot-outbox'
import { BotSentMessageRegistry } from './bot-sent-registry'
import { DedupeStore, buildDedupeKey } from './dedupe-store'
import {
  type IncomingAttachmentResult,
  platformToUserMessage,
} from './message-converter'
import { SessionMapper } from './session-mapper'
import {
  type PlatformAdapter,
  type PlatformMessageEvent,
  decodeSessionKey,
} from './types'

/**
 * Builds a concrete `PlatformAdapter` for a platform config, or `null` if
 * this platform type isn't (yet) supported — e.g. the Phase 4 DingTalk stub
 * before its adapter exists, or an adapter constructor throwing during
 * validation. Injected rather than hardcoded so `BotService` (Phase 1)
 * doesn't need to statically depend on the Telegram/WeChat/DingTalk adapter
 * modules built in later phases.
 */
export type BotPlatformAdapterFactory = (
  config: BotPlatformConfig,
) => PlatformAdapter | null

export type BotServiceDeps = {
  app: App
  getSettings: () => YoloSettings
  saveSettings: (settings: YoloSettings) => Promise<void>
  registerSettingsListener: (
    listener: (settings: YoloSettings) => void,
  ) => () => void
  loadConversation: (
    conversationId: string,
  ) => Promise<readonly ChatMessage[] | null>
  createConversation: (title: string) => Promise<string>
  createAdapter: BotPlatformAdapterFactory
  getAgentService: () => AgentService
  getMcpManager: () => Promise<McpManager>
  notifyUser?: (message: string) => void
  now?: () => number
}

const HELP_TEXT = [
  'Available commands:',
  '/help - show this message',
  '/status - show the current session status',
  '/reset - start a new conversation (admin only)',
].join('\n')

const SESSION_TOUCH_INTERVAL_MS = 30_000
const BOT_ATTACHMENT_SUBDIR = 'Bot Attachments'
const BOT_ATTACHMENT_TOTAL_MAX_BYTES = 50 * 1024 * 1024

export class BotService {
  private readonly deps: BotServiceDeps
  private readonly now: () => number

  private readonly adapters = new Map<string, PlatformAdapter>()
  // Snapshot of the config each adapter was last started with, so
  // onSettingsChanged can diff by value (not just by id) to decide whether a
  // running adapter needs restarting.
  private readonly startedConfigs = new Map<string, BotPlatformConfig>()

  private readonly sessionMapper: SessionMapper
  private readonly dedupeStore = new DedupeStore()
  private readonly sentRegistry = new BotSentMessageRegistry()
  private readonly outbox = new BotOutbox()
  private readonly sessionTouchAt = new Map<string, number>()
  private readonly sessionResolutionQueues = new Map<
    string,
    Promise<string | null>
  >()
  private readonly turnQueues = new Map<string, Promise<void>>()
  private readonly activeTurnAbortControllers = new Set<AbortController>()
  private readonly adapterUnsubscribers = new Map<string, Array<() => void>>()
  private settingsChangeQueue: Promise<void> = Promise.resolve()
  private lastBotsSettings: BotsSettings | null = null
  private cleanupPromise: Promise<void> | null = null
  private acceptingEvents = true

  private unsubscribeFromSettings: (() => void) | null = null

  constructor(deps: BotServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.sessionMapper = new SessionMapper({
      getSettings: () => this.deps.getSettings().bots,
      saveSettings: async (bots) => {
        await this.deps.saveSettings({ ...this.deps.getSettings(), bots })
      },
    })
  }

  private loadConversation(
    conversationId: string,
  ): Promise<readonly ChatMessage[] | null> {
    return this.deps.loadConversation(conversationId)
  }

  private async createConversation(title: string): Promise<string> {
    return this.deps.createConversation(title)
  }

  async initialize(): Promise<void> {
    if (!this.acceptingEvents) return
    const settings = this.getBotsSettings()
    this.lastBotsSettings = settings
    if (settings.enabled) {
      await this.onSettingsChanged(this.emptyBotsSettings(), settings)
    }
    this.unsubscribeFromSettings = this.deps.registerSettingsListener(
      (newSettings) => {
        const previous = this.lastBotsSettings ?? this.emptyBotsSettings()
        this.lastBotsSettings = newSettings.bots
        this.settingsChangeQueue = this.settingsChangeQueue
          .then(() => this.onSettingsChanged(previous, newSettings.bots))
          .catch((error) => {
            console.error('[YOLO Bot] Failed to handle settings update:', error)
          })
      },
    )
  }

  async cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise
    this.acceptingEvents = false
    this.cleanupPromise = (async () => {
      if (this.unsubscribeFromSettings) {
        this.unsubscribeFromSettings()
        this.unsubscribeFromSettings = null
      }
      for (const unsubscribe of this.adapterUnsubscribers.values()) {
        for (const dispose of unsubscribe) dispose()
      }
      this.adapterUnsubscribers.clear()
      for (const controller of this.activeTurnAbortControllers) {
        controller.abort()
      }
      await this.settingsChangeQueue
      await Promise.all(
        Array.from(this.adapters.keys()).map((id) => this.stopPlatform(id)),
      )
      await Promise.allSettled([...this.turnQueues.values()])
      this.activeTurnAbortControllers.clear()
      this.turnQueues.clear()
      this.sessionTouchAt.clear()
      this.sessionResolutionQueues.clear()
      this.dedupeStore.clear()
      this.sentRegistry.clear()
      this.outbox.clear()
    })()
    return this.cleanupPromise
  }

  /**
   * Diffs `prev.platforms[]` against `next.platforms[]` by `id` and
   * starts/stops/restarts adapters as needed. Also stops everything if the
   * whole bot subsystem was just disabled, and (re)starts every enabled
   * platform if it was just enabled — mirrors calling this from
   * `initialize()` with an empty `prev`.
   */
  async onSettingsChanged(
    prev: BotsSettings,
    next: BotsSettings,
  ): Promise<void> {
    if (!this.acceptingEvents) return
    if (!next.enabled) {
      await Promise.all(
        Array.from(this.adapters.keys()).map((id) => this.stopPlatform(id)),
      )
      return
    }

    const prevById = new Map(
      prev.platforms.map((platform) => [platform.id, platform]),
    )
    const nextById = new Map(
      next.platforms.map((platform) => [platform.id, platform]),
    )

    const removedIds = Array.from(prevById.keys()).filter(
      (id) => !nextById.has(id),
    )
    await Promise.all(removedIds.map((id) => this.stopPlatform(id)))

    for (const [id, config] of nextById) {
      const prevConfig = prevById.get(id)
      const alreadyRunning = this.adapters.has(id)

      if (!config.enabled) {
        if (alreadyRunning) await this.stopPlatform(id)
        continue
      }

      const configChanged = !prevConfig || !isEqual(prevConfig, config)
      if (!alreadyRunning) {
        await this.startPlatform(config)
      } else if (configChanged) {
        await this.stopPlatform(id)
        await this.startPlatform(config)
      }
    }
  }

  getAdapter(id: string): PlatformAdapter | undefined {
    return this.adapters.get(id)
  }

  getSessionMapper(): SessionMapper {
    return this.sessionMapper
  }

  getDedupeStore(): DedupeStore {
    return this.dedupeStore
  }

  getSentMessageRegistry(): BotSentMessageRegistry {
    return this.sentRegistry
  }

  getOutbox(): BotOutbox {
    return this.outbox
  }

  /**
   * Incoming handler — registered on each adapter's `onMessage`. Takes the
   * originating platform's config as an explicit second argument: unlike
   * `event.platformName` (which only identifies the platform *type*, e.g.
   * `'telegram'`), whitelist/admin/tool-policy checks need the specific
   * platform *instance* config (a user may run more than one bot of the same
   * type). `startPlatform` closes over the right config per adapter, so
   * callers never have to look it up themselves. See the final report for
   * the full rationale on this deviation from the design doc's single-arg
   * `handleIncoming(event)` pseudocode.
   */
  async handleIncoming(
    event: PlatformMessageEvent,
    platformConfig: BotPlatformConfig,
  ): Promise<void> {
    if (!this.acceptingEvents) return
    // Step 1: never process the bot's own echoed messages.
    if (event.isFromBot) return

    const activeConfig = this.startedConfigs.get(platformConfig.id)
    if (!activeConfig || !isEqual(activeConfig, platformConfig)) return
    if (event.platformName !== platformConfig.platformType) return

    // Step 2: validate the session key shape early so a malformed adapter
    // event fails loudly instead of corrupting session/dedupe state.
    let decoded: ReturnType<typeof decodeSessionKey>
    try {
      decoded = decodeSessionKey(event.sessionKey)
    } catch (error) {
      console.error('[YOLO Bot] Dropping event with invalid sessionKey:', error)
      return
    }

    // Step 3: dedupe.
    const dedupeKey = buildDedupeKey({
      platformName: event.platformName,
      sessionKey: event.sessionKey,
      threadId: event.threadId,
      messageId: event.messageId,
    })
    if (this.dedupeStore.hasSeen(dedupeKey)) return
    this.dedupeStore.markSeen(dedupeKey)

    // Step 4: reply-to-bot detection, used by the group wakeCheck below.
    const isReplyToBot = event.message.components.some(
      (component) =>
        component.type === 'reply_to' &&
        this.sentRegistry.isSentByBot(component.messageId),
    )

    // Step 5: whitelist auth.
    if (!this.isAuthorized(event, platformConfig)) return

    // Step 6: group wakeCheck.
    if (event.chatType === 'group') {
      if (!this.getBotsSettings().groupChatEnabled) return
      const isCommandForThisBot =
        event.command?.targetBotId !== undefined &&
        event.command.targetBotId === platformConfig.name
      const shouldWake =
        Boolean(event.mentionedBotId) || isReplyToBot || isCommandForThisBot
      if (!shouldWake) {
        // MVP: no groupContextBuffer persistence yet (Phase 5/6 concern per
        // the design doc's "群聊上下文策略") — silently drop non-wake traffic.
        return
      }
    }

    // Step 7: built-in commands. Only reachable for private chats, or group
    // chats that already passed the wakeCheck above.
    if (event.command) {
      const handled = await this.handleCommand(event, platformConfig)
      if (handled) return
    }

    const adapter = this.adapters.get(platformConfig.id)
    if (!adapter) return

    // Step 8: getOrCreateConversation.
    const conversationId = await this.getOrCreateConversationId(
      event,
      decoded.chatId,
      decoded.threadId,
    )
    if (!conversationId) return

    // Step 9 (attachment download) stays platform-independent; step 10
    // (agent run) is handled by `runBotTurn` below.
    const attachments = await this.prepareIncomingAttachments(
      event,
      adapter,
      platformConfig,
    )
    const { promptContent, mentionables } = platformToUserMessage(event, {
      attachments,
      resolveMentionableFile: (vaultPath) => {
        const file = this.deps.app.vault.getAbstractFileByPath(vaultPath)
        if (!(file instanceof TFile)) return undefined
        return { type: 'file', file }
      },
    })
    this.runBotTurn({
      conversationId,
      sessionKey: event.sessionKey,
      chatType: event.chatType,
      platformConfig,
      adapter,
      promptContent,
      mentionables,
    })
  }

  private async prepareIncomingAttachments(
    event: PlatformMessageEvent,
    adapter: PlatformAdapter,
    platformConfig: BotPlatformConfig,
  ): Promise<IncomingAttachmentResult[]> {
    const components = event.message.components.filter(
      (component) =>
        component.type === 'image' ||
        component.type === 'file' ||
        component.type === 'audio' ||
        component.type === 'video',
    )
    if (components.length === 0) return []

    let totalBytes = 0
    const results: IncomingAttachmentResult[] = []
    for (const [index, component] of components.entries()) {
      const maxBytes =
        component.type === 'image'
          ? adapter.capabilities.maxImageSize
          : adapter.capabilities.maxFileSize
      const reportedSize =
        component.type === 'file' ? component.size : undefined
      if (reportedSize !== undefined && reportedSize > maxBytes) {
        results.push({
          component,
          size: reportedSize,
          skippedReason: `exceeds the ${maxBytes}-byte platform limit`,
        })
        continue
      }
      if (totalBytes >= BOT_ATTACHMENT_TOTAL_MAX_BYTES) {
        results.push({
          component,
          skippedReason: 'the message attachment budget is exhausted',
        })
        continue
      }

      let downloaded:
        | { fileName: string; mimeType: string; tempPath: string; size: number }
        | undefined
      try {
        downloaded = await adapter.downloadFile(component)
        const fs = await import('node:fs/promises')
        const bytes = await fs.readFile(downloaded.tempPath)
        if (bytes.byteLength > maxBytes) {
          results.push({
            component,
            size: bytes.byteLength,
            skippedReason: `exceeds the ${maxBytes}-byte platform limit`,
          })
          continue
        }
        if (totalBytes + bytes.byteLength > BOT_ATTACHMENT_TOTAL_MAX_BYTES) {
          results.push({
            component,
            size: bytes.byteLength,
            skippedReason: 'the message attachment budget is exhausted',
          })
          continue
        }
        const fileName = this.incomingAttachmentFileName(
          component,
          event.messageId,
          index,
          downloaded.fileName,
          downloaded.mimeType,
        )
        const folder = `${getYoloBaseDir(this.deps.getSettings())}/${BOT_ATTACHMENT_SUBDIR}/${this.safePathSegment(platformConfig.name || platformConfig.id)}`
        await this.ensureVaultFolder(folder)
        const vaultPath = `${folder}/${fileName}`
        await this.deps.app.vault.createBinary(
          vaultPath,
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        )
        totalBytes += bytes.byteLength
        results.push({ component, vaultPath, size: bytes.byteLength })
      } catch (error) {
        results.push({
          component,
          size: downloaded?.size,
          skippedReason: 'the platform attachment could not be downloaded',
        })
        console.warn('[YOLO Bot] Failed to prepare incoming attachment:', error)
      } finally {
        if (downloaded?.tempPath) {
          try {
            const fs = await import('node:fs/promises')
            await fs.rm(downloaded.tempPath, { force: true })
          } catch {
            // Best-effort cleanup; the adapter owns the temporary directory.
          }
        }
      }
    }
    return results
  }

  private async ensureVaultFolder(folder: string): Promise<void> {
    const parts = folder.split('/')
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      try {
        await this.deps.app.vault.createFolder(current)
      } catch {
        // Obsidian throws when the folder already exists.
      }
    }
  }

  private incomingAttachmentFileName(
    component: Extract<
      PlatformMessageEvent['message']['components'][number],
      { type: 'image' | 'file' | 'audio' | 'video' }
    >,
    messageId: string,
    index: number,
    downloadedFileName?: string,
    downloadedMimeType?: string,
  ): string {
    const fallback = `${component.type}-${index}`
    let name =
      component.type === 'file'
        ? component.name
        : (downloadedFileName ?? fallback)
    if (component.type !== 'file' && !/\.[a-z\d]{1,8}$/i.test(name)) {
      const extension = this.attachmentExtension(downloadedMimeType)
      if (extension) name = `${name}.${extension}`
    }
    const safeName = this.safePathSegment(name) || fallback
    return `${this.safePathSegment(messageId)}-${index}-${safeName}`
  }

  private attachmentExtension(
    mimeType: string | undefined,
  ): string | undefined {
    const normalized = mimeType?.toLowerCase().split(';', 1)[0]
    if (!normalized) return undefined
    const extensions: Record<string, string> = {
      'audio/amr': 'amr',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/ogg': 'ogg',
      'audio/opus': 'opus',
      'audio/wav': 'wav',
      'image/gif': 'gif',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/x-msvideo': 'avi',
    }
    return extensions[normalized]
  }

  private safePathSegment(value: string): string {
    return value
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\.\.+/g, '.')
      .slice(0, 160)
  }

  /**
   * Fire-and-forget: `handleIncoming` doesn't await the agent run (bot
   * replies are delivered asynchronously via the adapter, not via this
   * method's return value). Any error is caught and logged here so it can
   * never escape into `handleIncoming`'s caller.
   */
  private runBotTurn(params: {
    conversationId: string
    sessionKey: string
    chatType: 'private' | 'group'
    platformConfig: BotPlatformConfig
    adapter: PlatformAdapter
    promptContent: string
    mentionables: Mentionable[]
  }): void {
    if (!this.acceptingEvents) return
    const previous = this.turnQueues.get(params.sessionKey) ?? Promise.resolve()
    const abortController = new AbortController()
    this.activeTurnAbortControllers.add(abortController)
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.acceptingEvents || abortController.signal.aborted) return
        const mcpManager = await this.deps.getMcpManager()
        if (!this.acceptingEvents || abortController.signal.aborted) return
        await runBotAgentTurn({
          app: this.deps.app,
          settings: this.deps.getSettings(),
          agentService: this.deps.getAgentService(),
          mcpManager,
          loadConversation: (conversationId) =>
            this.loadConversation(conversationId),
          abortSignal: abortController.signal,
          adapter: params.adapter,
          sentMessageRegistry: this.sentRegistry,
          conversationId: params.conversationId,
          sessionKey: params.sessionKey,
          chatType: params.chatType,
          platformConfig: params.platformConfig,
          promptContent: params.promptContent,
          mentionables: params.mentionables,
        })
      })
      .catch((error) => {
        console.error('[YOLO Bot] Failed to run agent turn:', error)
      })
      .finally(() => {
        this.activeTurnAbortControllers.delete(abortController)
      })
    this.turnQueues.set(params.sessionKey, current)
    void current.then(() => {
      if (this.turnQueues.get(params.sessionKey) === current) {
        this.turnQueues.delete(params.sessionKey)
      }
    })
  }

  private async getOrCreateConversationId(
    event: PlatformMessageEvent,
    chatId: string,
    threadId: string | undefined,
  ): Promise<string | null> {
    const pending = this.sessionResolutionQueues.get(event.sessionKey)
    if (pending) return pending
    const resolution = this.resolveConversationId(event, chatId, threadId)
    this.sessionResolutionQueues.set(event.sessionKey, resolution)
    try {
      return await resolution
    } finally {
      if (this.sessionResolutionQueues.get(event.sessionKey) === resolution) {
        this.sessionResolutionQueues.delete(event.sessionKey)
      }
    }
  }

  private async resolveConversationId(
    event: PlatformMessageEvent,
    chatId: string,
    threadId: string | undefined,
  ): Promise<string | null> {
    const existing = this.sessionMapper.getSessionByKey(event.sessionKey)
    if (existing) {
      if (existing.disabled) return null

      // Settings can outlive chat files (for example after clearing chat
      // history or moving the YOLO data directory). Do not keep routing new
      // messages into a conversation that the chat UI cannot load.
      const conversation = await this.loadConversation(existing.conversationId)
      if (!conversation) {
        const replacement = await this.createConversation(
          `${event.platformName}:${chatId}`,
        )
        const now = this.now()
        await this.sessionMapper.upsertSession({
          ...existing,
          platformName: event.platformName,
          chatType: event.chatType,
          platformChatId: chatId,
          threadId,
          conversationId: replacement,
          lastActiveAt: now,
          archivedAt: undefined,
        })
        this.sessionTouchAt.set(event.sessionKey, now)
        return replacement
      }

      const now = this.now()
      const lastTouch = this.sessionTouchAt.get(event.sessionKey)
      if (
        existing.archivedAt !== undefined ||
        lastTouch === undefined ||
        now < lastTouch ||
        now - lastTouch >= SESSION_TOUCH_INTERVAL_MS
      ) {
        await this.sessionMapper.touchActiveSession(event.sessionKey, now)
        this.sessionTouchAt.set(event.sessionKey, now)
      }
      return existing.conversationId
    }

    const conversation = await this.createConversation(
      `${event.platformName}:${chatId}`,
    )
    const now = this.now()
    const mapping: SessionMapping = {
      sessionKey: event.sessionKey,
      platformName: event.platformName,
      chatType: event.chatType,
      platformChatId: chatId,
      threadId,
      conversationId: conversation,
      createdAt: now,
      lastActiveAt: now,
    }
    await this.sessionMapper.upsertSession(mapping)
    this.sessionTouchAt.set(event.sessionKey, now)
    return conversation
  }

  private async handleCommand(
    event: PlatformMessageEvent,
    platformConfig: BotPlatformConfig,
  ): Promise<boolean> {
    const command = event.command
    if (!command) return false
    const adapter = this.adapters.get(platformConfig.id)
    if (!adapter) return false

    switch (command.name) {
      case 'help':
        await adapter.sendMessage(event.sessionKey, { text: HELP_TEXT })
        return true
      case 'status': {
        const session = this.sessionMapper.getSessionByKey(event.sessionKey)
        const text = session
          ? `Session bound to conversation ${session.conversationId}. Last active: ${new Date(session.lastActiveAt).toISOString()}.`
          : 'No conversation bound to this session yet.'
        await adapter.sendMessage(event.sessionKey, { text })
        return true
      }
      case 'reset': {
        if (!this.isAdmin(event)) {
          await adapter.sendMessage(event.sessionKey, {
            text: 'You are not authorized to reset this session.',
          })
          return true
        }
        const decoded = decodeSessionKey(event.sessionKey)
        const conversation = await this.createConversation(
          `${event.platformName}:${decoded.chatId}`,
        )
        const now = this.now()
        await this.sessionMapper.upsertSession({
          sessionKey: event.sessionKey,
          platformName: event.platformName,
          chatType: event.chatType,
          platformChatId: decoded.chatId,
          threadId: decoded.threadId,
          conversationId: conversation,
          createdAt: now,
          lastActiveAt: now,
        })
        this.sessionTouchAt.set(event.sessionKey, now)
        await adapter.sendMessage(event.sessionKey, {
          text: 'Conversation has been reset.',
        })
        return true
      }
      default:
        return false
    }
  }

  private isAdmin(event: PlatformMessageEvent): boolean {
    return this.getBotsSettings().adminUsers.includes(event.senderId)
  }

  /**
   * Whitelist check. Only `telegram`/`weixin_oc` configs currently carry
   * `whitelistEnabled`/`allowedUsers`/`allowedGroups` (the DingTalk MVP stub
   * schema doesn't yet — see `botPlatformDingtalkSchema`); platforms without
   * those fields conservatively deny everyone except global admins until
   * their own auth fields are added in a later phase.
   */
  private isAuthorized(
    event: PlatformMessageEvent,
    platformConfig: BotPlatformConfig,
  ): boolean {
    if (this.isAdmin(event)) return true
    const botsSettings = this.getBotsSettings()
    if (!botsSettings.whitelistEnabled) return true
    if (
      'whitelistEnabled' in platformConfig &&
      !platformConfig.whitelistEnabled
    ) {
      return true
    }
    if (!('whitelistEnabled' in platformConfig)) return false

    const allowedUsers: readonly string[] =
      'allowedUsers' in platformConfig ? platformConfig.allowedUsers : []
    if (allowedUsers.includes(event.senderId)) return true

    if (event.chatType === 'group' && 'allowedGroups' in platformConfig) {
      const decoded = decodeSessionKey(event.sessionKey)
      return platformConfig.allowedGroups.includes(decoded.chatId)
    }
    return false
  }

  private async startPlatform(config: BotPlatformConfig): Promise<void> {
    if (!this.acceptingEvents) return
    const adapter = this.deps.createAdapter(config)
    if (!adapter) {
      console.error(
        `[YOLO Bot] No adapter implementation available for platform type: ${config.platformType}`,
      )
      return
    }

    const unsubscribeMessage = adapter.onMessage((event) =>
      this.handleIncoming(event, config).catch((error) => {
        console.error('[YOLO Bot] Failed to handle incoming message:', error)
      }),
    )
    const unsubscribeError = adapter.onError((error, _adapter, context) => {
      console.error(
        `[YOLO Bot] Adapter error (${config.platformType}/${config.id}):`,
        error,
        context,
      )
      if (
        config.platformType === 'weixin_oc' &&
        context?.operation === 'receive' &&
        error.message.includes('session expired')
      ) {
        this.deps.notifyUser?.(
          'WeChat bot login expired. Open Bot settings, scan the QR code again, and click Save.',
        )
      }
    })
    this.adapterUnsubscribers.set(config.id, [
      unsubscribeMessage,
      unsubscribeError,
    ])

    this.adapters.set(config.id, adapter)
    this.startedConfigs.set(config.id, config)

    try {
      await adapter.start(config)
    } catch (error) {
      console.error(
        `[YOLO Bot] Failed to start adapter ${config.platformType}/${config.id}:`,
        error,
      )
      try {
        await adapter.stop()
      } catch (stopError) {
        console.error(
          `[YOLO Bot] Failed to clean up adapter ${config.platformType}/${config.id}:`,
          stopError,
        )
      }
      unsubscribeMessage()
      unsubscribeError()
      this.adapterUnsubscribers.delete(config.id)
      this.adapters.delete(config.id)
      this.startedConfigs.delete(config.id)
      return
    }
  }

  private async stopPlatform(id: string): Promise<void> {
    const unsubscribe = this.adapterUnsubscribers.get(id)
    if (unsubscribe) {
      for (const dispose of unsubscribe) dispose()
      this.adapterUnsubscribers.delete(id)
    }
    const adapter = this.adapters.get(id)
    if (!adapter) return
    try {
      await adapter.stop()
    } catch (error) {
      console.error(`[YOLO Bot] Failed to stop adapter ${id}:`, error)
    }
    this.adapters.delete(id)
    this.startedConfigs.delete(id)
  }

  private getBotsSettings(): BotsSettings {
    return this.deps.getSettings().bots
  }

  private emptyBotsSettings(): BotsSettings {
    return { ...this.getBotsSettings(), platforms: [] }
  }
}
