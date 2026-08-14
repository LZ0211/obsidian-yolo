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

import {
  BOT_TURN_MAX_DURATION_MS,
  BOT_TURN_TIMEOUT_REASON,
  runBotAgentTurn,
} from './agent-runner'
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
import { emitBotConversationUpdated } from './conversation-updated-event'

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
  /** i18n resolver for user-visible strings — resolved at use time. */
  translate?: (key: string, fallback: string) => string
  now?: () => number
}

/**
 * Bot conversation title format: `{平台名} · {发送者名?} · {MM-DD HH:mm}`.
 *
 * The title is written once at conversation creation and shows up in the chat
 * history list and the Bots settings Sessions list. The platform label is
 * i18n-resolved by the caller (the raw platform type id, e.g. `weixin_oc`,
 * reads like a random string); the sender name comes from the inbound event
 * and is omitted when the platform could not provide one; the timestamp is the
 * creation moment in local `MM-DD HH:mm` form. Compared with the pre-title
 * convention (`platform:chatId`) the conversation is identifiable at a glance.
 */
export function formatBotConversationTitle(params: {
  platformLabel: string
  senderName?: string
  createdAt: number
}): string {
  const parts = [params.platformLabel]
  const senderName = params.senderName?.trim()
  if (senderName) parts.push(senderName)
  parts.push(formatBotConversationTimestamp(params.createdAt))
  return parts.join(' · ')
}

/** Local `MM-DD HH:mm` form of a creation timestamp. */
export function formatBotConversationTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** i18n key per platform type for the conversation-title platform segment. */
const PLATFORM_LABEL_I18N_KEY: Record<string, string> = {
  telegram: 'settings.bots.platformName.telegram',
  weixin_oc: 'settings.bots.platformName.weixin',
  dingtalk: 'settings.bots.platformName.dingtalk',
  feishu: 'settings.bots.platformName.feishu',
  qq_official: 'settings.bots.platformName.qq',
}

/** Runtime health of one platform adapter, consumed by the Bots settings UI. */
export type BotPlatformHealth = {
  status: 'running' | 'stopped' | 'degraded' | 'failed'
  /** Adapter is currently started (enabled and the last start succeeded). */
  started: boolean
  /** Message of the last failed start attempt, when the last start failed. */
  startError?: string
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
  private readonly sessionTouchAt = new Map<string, number>()
  private readonly sessionResolutionQueues = new Map<
    string,
    Promise<string | null>
  >()
  private readonly turnQueues = new Map<string, Promise<void>>()
  private readonly activeTurnAbortControllers = new Set<AbortController>()
  private readonly adapterUnsubscribers = new Map<string, Array<() => void>>()
  /** Last adapter start-failure message per platform id — surfaced through
   * `getHealth` so the Bots settings UI can show why a platform never came
   * up instead of a silent "stopped" dot. */
  private readonly startErrors = new Map<string, string>()
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

  /**
   * `cleanup()` leaves the instance permanently dead (`acceptingEvents` is
   * never re-enabled). Lets `main.ts` tell a cleaned-up instance apart from a
   * live one so a settings flip can rebuild instead of silently no-op'ing.
   */
  get isCleanedUp(): boolean {
    return this.cleanupPromise !== null
  }

  private t(key: string, fallback: string): string {
    return this.deps.translate?.(key, fallback) ?? fallback
  }

  private notifyUser(message: string): void {
    this.deps.notifyUser?.(message)
  }

  /** Builds the creation-time conversation title for an inbound event. */
  private botConversationTitle(
    platformName: string,
    senderName: string | undefined,
    createdAt: number,
  ): string {
    return formatBotConversationTitle({
      platformLabel: this.t(
        PLATFORM_LABEL_I18N_KEY[platformName] ?? '',
        platformName,
      ),
      senderName,
      createdAt,
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
    // B2: the settings listener is registered BEFORE the initial platform
    // start, and the initial sync runs through the same serialized
    // settingsChangeQueue as every later change. Previously the listener was
    // only registered after the (network-bound) start handshake completed, so
    // a settings flip during startup (e.g. disabling the whole bot switch)
    // was consumed by nobody — the platform stayed running and the
    // lastBotsSettings snapshot drifted from the applied state.
    if (settings.enabled) {
      const initialSync = this.enqueueSettingsChange(
        this.emptyBotsSettings(),
        settings,
      )
      this.unsubscribeFromSettings = this.deps.registerSettingsListener(
        (newSettings) => this.handleSettingsChange(newSettings),
      )
      await initialSync
    } else {
      this.unsubscribeFromSettings = this.deps.registerSettingsListener(
        (newSettings) => this.handleSettingsChange(newSettings),
      )
    }
  }

  private handleSettingsChange(newSettings: YoloSettings): void {
    const previous = this.lastBotsSettings ?? this.emptyBotsSettings()
    this.lastBotsSettings = newSettings.bots
    this.enqueueSettingsChange(previous, newSettings.bots)
  }

  /**
   * Serializes a settings diff onto the settingsChangeQueue (one at a time,
   * in arrival order) and returns the queued promise so callers can await
   * the applied state.
   */
  private enqueueSettingsChange(
    previous: BotsSettings,
    next: BotsSettings,
  ): Promise<void> {
    const queued = this.settingsChangeQueue
      .then(() => this.onSettingsChanged(previous, next))
      .catch((error) => {
        console.error('[YOLO Bot] Failed to handle settings update:', error)
      })
    this.settingsChangeQueue = queued
    return queued
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
      // Abort in-flight turns before stopping adapters — the same order as
      // `cleanup()`: without the abort, a queued turn would keep running and
      // try to reply through an already-stopped adapter, failing silently.
      for (const controller of this.activeTurnAbortControllers) {
        controller.abort()
      }
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

  /**
   * Runtime health of one platform adapter, consumed by the Bots settings UI
   * (status dot, error row, "test connection"). A configured-but-never-started
   * platform (including a failed start attempt) reports `stopped` with the
   * last start-failure message attached.
   */
  getHealth(platformId: string): BotPlatformHealth {
    const adapter = this.getAdapter(platformId)
    if (!adapter) {
      return {
        status: 'stopped',
        started: false,
        startError: this.startErrors.get(platformId),
      }
    }
    return { status: adapter.health(), started: true }
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
      platformInstanceId: platformConfig.id,
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
        this.sentRegistry.isSentByBot(
          component.messageId,
          this.now(),
          event.sessionKey,
          platformConfig.id,
        ),
    )

    // Step 5: whitelist auth.
    if (!this.isAuthorized(event, platformConfig)) return

    // Step 6: group wakeCheck.
    if (event.chatType === 'group') {
      if (!this.getBotsSettings().groupChatEnabled) return
      const shouldWake =
        Boolean(event.mentionedBotId) ||
        isReplyToBot ||
        this.isCommandForThisBot(event, platformConfig)
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
      platformConfig.id,
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
      replyToMessageId: event.messageId,
      queueKey: this.sessionRuntimeKey(platformConfig.id, event.sessionKey),
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
        // Copy into a fresh, exact-size ArrayBuffer: `bytes.buffer` on Node's
        // pooled Buffers is the whole shared pool (a 1-byte read can carry a
        // 4KB pool as `.buffer`), and `bytes.buffer.slice(byteOffset, ...)`
        // can come back empty near the pool boundary — either way the bytes
        // Obsidian writes would be wrong.
        const exactBytes = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(exactBytes).set(bytes)
        await this.deps.app.vault.createBinary(vaultPath, exactBytes)
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
      } catch (error) {
        // Obsidian throws when the folder already exists; anything else (e.g.
        // a vault permission error) is a real failure and must not be hidden.
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes('already exists')
        ) {
          continue
        }
        throw error
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
    replyToMessageId: string
    queueKey: string
    chatType: 'private' | 'group'
    platformConfig: BotPlatformConfig
    adapter: PlatformAdapter
    promptContent: string
    mentionables: Mentionable[]
  }): void {
    if (!this.acceptingEvents) return
    const previous = this.turnQueues.get(params.queueKey) ?? Promise.resolve()
    const abortController = new AbortController()
    // Whole-turn duration budget: a stuck agent loop must not occupy the
    // per-session serial queue forever (see agent-runner.ts). The abort
    // reason lets the runner tell a timeout apart from a user/plugin cancel.
    const turnTimeoutHandle = setTimeout(
      () => abortController.abort(BOT_TURN_TIMEOUT_REASON),
      BOT_TURN_MAX_DURATION_MS,
    )
    this.activeTurnAbortControllers.add(abortController)
    // Set only when the agent turn actually ran (not when it was skipped by an
    // abort/unload) — the open chat view reloads on this event, so a turn that
    // changed nothing must not churn its message state.
    let turnRan = false
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.acceptingEvents || abortController.signal.aborted) return
        const mcpManager = await this.deps.getMcpManager()
        if (!this.acceptingEvents || abortController.signal.aborted) return
        turnRan = true
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
          replyToMessageId: params.replyToMessageId,
          platformConfig: params.platformConfig,
          promptContent: params.promptContent,
          mentionables: params.mentionables,
        })
      })
      .catch((error) => {
        console.error('[YOLO Bot] Failed to run agent turn:', error)
      })
      .finally(() => {
        clearTimeout(turnTimeoutHandle)
        this.activeTurnAbortControllers.delete(abortController)
        if (turnRan) {
          emitBotConversationUpdated(params.conversationId)
        }
      })
    this.turnQueues.set(params.queueKey, current)
    void current.then(() => {
      if (this.turnQueues.get(params.queueKey) === current) {
        this.turnQueues.delete(params.queueKey)
      }
    })
  }

  private async getOrCreateConversationId(
    event: PlatformMessageEvent,
    chatId: string,
    threadId: string | undefined,
    platformInstanceId: string,
  ): Promise<string | null> {
    const queueKey = this.sessionRuntimeKey(
      platformInstanceId,
      event.sessionKey,
    )
    const pending = this.sessionResolutionQueues.get(queueKey)
    if (pending) return pending
    const resolution = this.resolveConversationId(
      event,
      chatId,
      threadId,
      platformInstanceId,
      queueKey,
    )
    this.sessionResolutionQueues.set(queueKey, resolution)
    try {
      return await resolution
    } finally {
      if (this.sessionResolutionQueues.get(queueKey) === resolution) {
        this.sessionResolutionQueues.delete(queueKey)
      }
    }
  }

  private async resolveConversationId(
    event: PlatformMessageEvent,
    chatId: string,
    threadId: string | undefined,
    platformInstanceId: string,
    runtimeSessionKey: string,
  ): Promise<string | null> {
    const allowLegacyInstance = this.canUseLegacySessionMapping(
      event.platformName,
    )
    const existing = this.sessionMapper.getSessionByKey(
      event.sessionKey,
      platformInstanceId,
      allowLegacyInstance,
    )
    if (existing) {
      if (existing.disabled) return null

      // Settings can outlive chat files (for example after clearing chat
      // history or moving the YOLO data directory). Do not keep routing new
      // messages into a conversation that the chat UI cannot load.
      const conversation = await this.loadConversation(existing.conversationId)
      if (!conversation) {
        const now = this.now()
        const title = this.botConversationTitle(
          event.platformName,
          event.senderName,
          now,
        )
        const replacement = await this.createConversation(title)
        await this.sessionMapper.upsertSession(
          {
            ...existing,
            platformInstanceId,
            platformName: event.platformName,
            chatType: event.chatType,
            platformChatId: chatId,
            threadId,
            conversationId: replacement,
            conversationTitle: title,
            lastActiveAt: now,
            archivedAt: undefined,
          },
          allowLegacyInstance,
        )
        this.sessionTouchAt.set(runtimeSessionKey, now)
        return replacement
      }

      const now = this.now()
      const lastTouch = this.sessionTouchAt.get(runtimeSessionKey)
      if (
        existing.archivedAt !== undefined ||
        lastTouch === undefined ||
        now < lastTouch ||
        now - lastTouch >= SESSION_TOUCH_INTERVAL_MS
      ) {
        await this.sessionMapper.touchActiveSession(
          event.sessionKey,
          platformInstanceId,
          now,
          allowLegacyInstance,
        )
        this.sessionTouchAt.set(runtimeSessionKey, now)
      }
      return existing.conversationId
    }

    // First message of a brand-new session: the title is fixed at creation
    // (`platform · sender · MM-DD HH:mm`) and never overwritten by later
    // messages — `conversationTitle` carries it into the session mapping.
    const now = this.now()
    const title = this.botConversationTitle(
      event.platformName,
      event.senderName,
      now,
    )
    const conversation = await this.createConversation(title)
    const mapping: SessionMapping = {
      sessionKey: event.sessionKey,
      platformInstanceId,
      platformName: event.platformName,
      chatType: event.chatType,
      platformChatId: chatId,
      threadId,
      conversationId: conversation,
      conversationTitle: title,
      createdAt: now,
      lastActiveAt: now,
    }
    await this.sessionMapper.upsertSession(mapping, allowLegacyInstance)
    this.sessionTouchAt.set(runtimeSessionKey, now)
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
        const session = this.sessionMapper.getSessionByKey(
          event.sessionKey,
          platformConfig.id,
          this.canUseLegacySessionMapping(event.platformName),
        )
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
        // A /reset starts a fresh conversation; the incoming text is just the
        // command itself, so the title carries platform + sender + reset time.
        const now = this.now()
        const title = this.botConversationTitle(
          event.platformName,
          event.senderName,
          now,
        )
        const conversation = await this.createConversation(title)
        await this.sessionMapper.upsertSession(
          {
            sessionKey: event.sessionKey,
            platformInstanceId: platformConfig.id,
            platformName: event.platformName,
            chatType: event.chatType,
            platformChatId: decoded.chatId,
            threadId: decoded.threadId,
            conversationId: conversation,
            conversationTitle: title,
            createdAt: now,
            lastActiveAt: now,
          },
          this.canUseLegacySessionMapping(event.platformName),
        )
        this.sessionTouchAt.set(
          this.sessionRuntimeKey(platformConfig.id, event.sessionKey),
          now,
        )
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

  private sessionRuntimeKey(
    platformInstanceId: string,
    sessionKey: string,
  ): string {
    return `${platformInstanceId}\u0000${sessionKey}`
  }

  private canUseLegacySessionMapping(platformName: string): boolean {
    let instances = 0
    for (const config of this.startedConfigs.values()) {
      if (config.platformType === platformName) instances += 1
    }
    return instances <= 1
  }

  /**
   * Group wakeCheck for commands. A command belongs to this bot when it has
   * no explicit target (a bare `/help` in a group is delivered to every bot,
   * and any of them may answer), or when the explicit target is this bot's
   * own platform identity. Telegram's `targetBotId` is the bot *username*
   * (`/help@username`), which the adapter exposes via `getBotUsername` —
   * the free-form `config.name` label is a user-facing tag, not the
   * protocol identity, so it must not be used for attribution.
   */
  private isCommandForThisBot(
    event: PlatformMessageEvent,
    platformConfig: BotPlatformConfig,
  ): boolean {
    const command = event.command
    if (!command) return false
    if (command.targetBotId === undefined) return true
    const botUsername = this.adapters.get(platformConfig.id)?.getBotUsername?.()
    if (!botUsername) return false
    return command.targetBotId.toLowerCase() === botUsername.toLowerCase()
  }

  /**
   * Whitelist check. Every platform config schema extends
   * `botPlatformBaseSchema`, which carries `whitelistEnabled`/`allowedUsers`/
   * `allowedGroups` for all platform types, so the per-platform `in`-guards
   * and the conservative deny branch are gone — a global whitelist toggle
   * gates every platform, and each platform config can opt out of the list
   * via its own `whitelistEnabled`.
   */
  private isAuthorized(
    event: PlatformMessageEvent,
    platformConfig: BotPlatformConfig,
  ): boolean {
    if (this.isAdmin(event)) return true
    const botsSettings = this.getBotsSettings()
    if (!botsSettings.whitelistEnabled) return true
    if (!platformConfig.whitelistEnabled) return true

    if (platformConfig.allowedUsers.includes(event.senderId)) return true

    if (event.chatType === 'group') {
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
      if (!context) return
      if (
        config.platformType === 'weixin_oc' &&
        context.operation === 'receive' &&
        error.message.includes('session expired')
      ) {
        // Receive-side expiry detection (the long-poll loop stopping) — the
        // user must re-scan the QR code.
        this.notifyUser(
          this.t(
            'settings.bots.notifySessionExpired',
            'WeChat bot login expired. Open Bot settings, scan the QR code again, and click Save.',
          ),
        )
      } else if (context.operation === 'send' && context.retryable === false) {
        // Send-side credential failure (e.g. WeChat session expired between
        // polls): without this the user sees neither a platform reply nor a
        // local notice — the turn just vanishes into the console.
        const platformLabel = config.name || config.platformType
        this.notifyUser(
          this.t(
            'settings.bots.notifySendFailed',
            'Bot reply failed to send ({platform}). Check the bot connection and try again.',
          ).replace('{platform}', platformLabel),
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
      this.startErrors.delete(config.id)
    } catch (error) {
      this.startErrors.set(
        config.id,
        error instanceof Error ? error.message : String(error),
      )
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
    // A deliberate stop (disable / config change / unload) supersedes any
    // earlier start failure — clear it so the UI doesn't keep showing it.
    this.startErrors.delete(id)
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
