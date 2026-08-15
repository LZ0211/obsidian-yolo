/**
 * WebCliRuntimeScope（Phase B Step 4 重写）
 *
 * Web 端 CLI 运行时的 CliRuntimeScope 实现，不再代理遗留 `/api/cli/*` 端点，
 * 改为 RemoteChatRuntimeAdapter（`/api/chat-runtime/*` 契约协议）背书：会话
 * 列表/置顶/重命名/删除、控制器快照与事件全部走契约端点。渲染层（ChatSidebarTabs
 * buildRuntime）与编排层（CliRuntimeScope）各自持有独立的 adapter 实例，但都
 * 指向同一服务端 runtime（服务端按 runtimeId:conversationId 缓存实例），状态一致。
 */
import type {
  ChatCommandError,
  ChatRuntime,
  ChatRuntimeId,
  ChatRuntimeSnapshot,
  ChatSessionSummary,
} from '../../core/chat-runtime/contract'
import { RemoteChatRuntimeAdapter } from '../../core/chat-runtime/remote/RemoteChatRuntimeAdapter'
import {
  CliConversationController,
  type CliConversationRewriteTurn,
  type CliConversationTurn,
  type CliStagedConversationTurn,
} from '../../core/cli-runtime/conversation-controller'
import type { CliRuntimeScope } from '../../core/cli-runtime/coordinator'
import {
  type CliRuntimeAvailability,
  EMPTY_CLI_RUNTIME_AVAILABILITY,
} from '../../core/cli-runtime/desktop'
import type {
  CliSessionDiscoveryResult,
  CliSessionService,
} from '../../core/cli-runtime/session-service'
import {
  CLI_RUNTIME_IDS,
  type CliAssistantBinding,
  type CliPermissionProfileUpdate,
  type CliRuntime,
  type CliRuntimeConfiguration,
  type CliRuntimeConfigurationUpdate,
  type CliRuntimeId,
  type CliRuntimeRunState,
  type CliSessionHydration,
  type CliSessionOverlay,
  type CliSessionRef,
} from '../../core/cli-runtime/types'
import type { ChatMessage, ChatUserMessage } from '../../types/chat'

import { createWebRemoteTransport } from './remoteChatTransport'

type CliSnapshot = ReturnType<CliConversationController['getSnapshot']>

/** master 的 session-service 不导出 CliSessionListItem（backup 有），本地
 *  补齐同名字面类型（backup 的该类型 = CliSessionMetadata & 会话列表字段）。 */
type CliSessionListItem = {
  ref: CliSessionRef
  title: string
  preview?: string
  updatedAt: number
  hasOverlay: boolean
  assistantId?: string
  lastOpenedAt?: number
  isPinned: boolean
  pinnedAt?: number
}

const toCliSnapshot = (
  snapshot: ChatRuntimeSnapshot,
  runtimeId: CliRuntimeId,
): CliSnapshot => ({
  surfaceId: `${runtimeId}:${snapshot.conversationId ?? ''}`,
  runtimeId,
  messages: snapshot.messages,
  compactionBoundaries: snapshot.compactionBoundaries,
  sessionRef: (snapshot.sessionRef as CliSessionRef | null) ?? null,
  runState: snapshot.runState as CliRuntimeRunState,
  error: snapshot.error,
  // master 的 CliConversationSnapshot 无 failure 字段（backup 有，契约快照
  // 不携带失效分类），configuration 透传。
  configuration: snapshot.configuration as CliRuntimeConfiguration | null,
})

const toSessionListItem = (
  summary: ChatSessionSummary,
): CliSessionListItem => ({
  ref: summary.ref as CliSessionRef,
  title: summary.title,
  ...(summary.preview !== undefined ? { preview: summary.preview } : {}),
  updatedAt: summary.updatedAt,
  hasOverlay: false,
  isPinned: summary.isPinned === true,
})

const getDiscoveryErrorMessage = (error: ChatCommandError): string => {
  if (error.kind === 'failed' && error.message) return error.message
  if (error.kind === 'rejected') return error.reason
  if (error.kind === 'unsupported' && error.reason) return error.reason
  return `Session discovery failed (${error.kind}).`
}

const getSessionCommandErrorMessage = (error: ChatCommandError): string => {
  if (error.kind === 'failed' && error.message) return error.message
  if (error.kind === 'rejected') return error.reason
  if (error.kind === 'unsupported' && error.reason) return error.reason
  return `CLI session command failed (${error.kind}).`
}

const createUnsupportedWebRuntime = (runtimeId: CliRuntimeId): CliRuntime => {
  const unsupported = async (): Promise<never> => {
    throw new Error(`${runtimeId} operation is unsupported on the web CLI runtime`)
  }
  return {
    runtimeId,
    openSession: unsupported,
    ensureReady: unsupported,
    getConfiguration: unsupported,
    updateConfiguration: unsupported,
    sendTurn: unsupported,
    rewriteTurn: unsupported,
    cancel: unsupported,
    respondApproval: unsupported,
    respondQuestion: unsupported,
    subscribe: () => () => undefined,
    dispose: async () => undefined,
  }
}

/** 编排层用的 CliConversationController：契约 adapter 快照/事件/命令的薄包装。 */
class WebCliConversationController extends CliConversationController {
  private unsubscribe: () => void
  private webConversationEpoch = 0

  constructor(
    private adapter: RemoteChatRuntimeAdapter,
    private readonly getAdapter: (
      conversationId?: string | null,
    ) => RemoteChatRuntimeAdapter,
    runtimeId: CliRuntimeId,
  ) {
    super(createUnsupportedWebRuntime(runtimeId))
    this.publish(toCliSnapshot(this.adapter.getSnapshot(), runtimeId))
    this.unsubscribe = this.adapter.subscribe(() => {
      this.publish(toCliSnapshot(this.adapter.getSnapshot(), runtimeId))
    })
  }

  override getConversationId = (): string | null =>
    this.adapter.getSnapshot().conversationId || null

  override getConversationEpoch = (): number => this.webConversationEpoch

  override bindConversation(conversationId: string): void {
    if (this.adapter.getSnapshot().conversationId === conversationId) return
    const runtimeId = this.getSnapshot().runtimeId
    this.webConversationEpoch += 1
    this.unsubscribe()
    this.adapter = this.getAdapter(conversationId)
    this.publish(toCliSnapshot(this.adapter.getSnapshot(), runtimeId))
    this.unsubscribe = this.adapter.subscribe(() => {
      this.publish(toCliSnapshot(this.adapter.getSnapshot(), runtimeId))
    })
  }

  override resetSession(): void {
    this.webConversationEpoch += 1
    this.publish({
      ...this.getSnapshot(),
      sessionRef: null,
      messages: [],
      compactionBoundaries: [],
      runState: 'idle',
      error: null,
    })
  }

  override async hydrateSession(
    ref: CliSessionRef,
    restoreMessages?: (
      messages: readonly ChatMessage[],
    ) => Promise<readonly ChatMessage[] | CliSessionOverlay>,
  ): Promise<CliSessionHydration> {
    const result = await this.adapter.openSession(ref)
    if (!result.ok) {
      throw new Error(getSessionCommandErrorMessage(result.error))
    }
    const snapshot =
      (await this.adapter.refreshSnapshot()) ?? this.adapter.getSnapshot()
    const sessionRef = snapshot.sessionRef as CliSessionRef | null
    if (sessionRef === null) {
      throw new Error('CLI session open did not produce an active session.')
    }
    if (
      sessionRef.runtimeId !== ref.runtimeId ||
      sessionRef.nativeSessionId !== ref.nativeSessionId
    ) {
      throw new Error('CLI session open produced a different session.')
    }
    const restored = restoreMessages
      ? await restoreMessages(snapshot.messages)
      : snapshot.messages
    const messages = Array.isArray(restored)
      ? restored
      : (restored as CliSessionOverlay).messages
    this.publish({
      ...toCliSnapshot(snapshot, this.getSnapshot().runtimeId),
      messages: Object.freeze([...messages]),
      ...(!Array.isArray(restored)
        ? {
            turnConfigurationByUserMessageId: (
              restored as CliSessionOverlay
            ).turnConfigurationByUserMessageId,
          }
        : {}),
    })
    return {
      ref: sessionRef,
      messages: [...messages],
      compactionBoundaries: [...(snapshot.compactionBoundaries ?? [])],
    }
  }

  override async ensureReady(
    initialConfiguration?: CliRuntimeConfigurationUpdate,
    _assistant?: CliAssistantBinding,
  ): Promise<void> {
    if (initialConfiguration) {
      await this.updateConfiguration(initialConfiguration)
    }
  }

  override async sendTurn({
    userMessage,
    content,
    selectedSkills,
  }: CliConversationTurn): Promise<void> {
    await this.adapter.sendTurn({
      content,
      messageId: userMessage.id,
      baseRevision: 0,
      messageGeneration: 0,
      ...(selectedSkills ? { selectedSkills } : {}),
    })
  }

  override async updateConfiguration(
    update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration | undefined> {
    await this.adapter.updateConfiguration(update)
    const snapshot = this.getSnapshot()
    const current = snapshot.configuration
    if (!current) return undefined
    const configuration = { ...current, ...update }
    this.publish({
      ...snapshot,
      configuration,
      error: null,
    })
    return configuration
  }

  override async cancel(): Promise<void> {
    await this.adapter.cancel()
  }

  override async rewriteTurn(_turn: CliConversationRewriteTurn): Promise<void> {
    // 远端契约 runtime 的 rewrite 走 UI 事务层，不提供远端 rewrite 端点——
    // 显式抛错而不是静默 no-op（E5）。
    const result = await this.adapter.rewriteTurn()
    if (!result.ok) {
      throw new Error(`rewrite is unsupported on the web CLI runtime`)
    }
  }

  async rollbackToTurn(): Promise<void> {
    const result = await this.adapter.rollbackToTurn()
    if (!result.ok) {
      throw new Error(`rollback is unsupported on the web CLI runtime`)
    }
  }

  async respondApproval(response: {
    requestId: string
    decision: 'approve_once' | 'approve_for_session' | 'reject'
  }): Promise<boolean> {
    const result = await this.adapter.respondApproval(response)
    if (!result.ok) {
      throw new Error(
        `failed to respond to approval request ${response.requestId}`,
      )
    }
    return true
  }

  async respondQuestion(response: {
    requestId: string
    answer: unknown
  }): Promise<boolean> {
    const result = await this.adapter.respondQuestion(response)
    if (!result.ok) {
      throw new Error(
        `failed to respond to question request ${response.requestId}`,
      )
    }
    return true
  }

  override async updatePermissionProfile(
    update: CliPermissionProfileUpdate,
  ): Promise<void> {
    const result = await this.adapter.updatePermissionProfile(update)
    if (!result.ok) {
      throw new Error('failed to update the permission profile')
    }
  }

  override async compact(): Promise<void> {
    const result = await this.adapter.compact()
    if (!result.ok) {
      throw new Error(`compact is unsupported on the web CLI runtime`)
    }
  }

  override stageTurn(userMessage: ChatUserMessage): CliStagedConversationTurn {
    const snapshot = this.getSnapshot()
    const staged = Object.freeze({
      surfaceId: snapshot.surfaceId,
      conversationEpoch: this.webConversationEpoch,
      userMessageId: userMessage.id,
    })
    const index = snapshot.messages.findIndex(
      (message) => message.id === userMessage.id,
    )
    const messages = [...snapshot.messages]
    if (index < 0) messages.push(userMessage)
    else messages[index] = userMessage
    this.publish({
      ...snapshot,
      messages: Object.freeze(messages),
      runState: 'running',
      error: null,
    })
    return staged
  }

  override rejectStagedTurn(
    stagedTurn: CliStagedConversationTurn,
    error: unknown,
  ): void {
    const snapshot = this.getSnapshot()
    if (
      stagedTurn.surfaceId !== snapshot.surfaceId ||
      stagedTurn.conversationEpoch !== this.webConversationEpoch
    ) {
      return
    }
    this.publish({
      ...snapshot,
      runState: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  override stageConfiguration(
    update: CliRuntimeConfigurationUpdate = {},
  ): CliRuntimeConfiguration | undefined {
    const snapshot = this.getSnapshot()
    const current = snapshot.configuration
    if (!current) return undefined
    const configuration = { ...current, ...update }
    this.publish({
      ...snapshot,
      configuration,
      error: null,
    })
    return configuration
  }

  override dispose(): void {
    this.unsubscribe()
    super.dispose()
  }
}

export type WebCliRuntimeScopeOptions = {
  baseUrl: string
  sessionId?: string | null
  fetchImpl?: typeof fetch
}

export function createWebCliRuntimeScope(
  options: WebCliRuntimeScopeOptions,
): CliRuntimeScope & {
  /** 渲染层共享的契约 ChatRuntime（ChatSidebarTabs buildRuntime 注入用）。
   *  `conversationId` 绑定 web-native 适配器实例（会话级实例化，与服务端
   *  native runtime 的按会话缓存一致）。runtimeId 取完整 ChatRuntimeId——
   *  web 主面（'yolo'）与 CLI 面（'claude-code'/'codex'）共用本 scope。 */
  getChatRuntime(
    runtimeId: ChatRuntimeId,
    conversationId?: string | null,
  ): ChatRuntime
} {
  const probeTransport = createWebRemoteTransport({
    baseUrl: options.baseUrl,
    sessionId: options.sessionId,
    fetchImpl: options.fetchImpl,
  })
  const adapters = new Map<string, RemoteChatRuntimeAdapter>()
  const controllers = new Map<CliRuntimeId, WebCliConversationController>()
  const allControllers = new Set<WebCliConversationController>()

  const getAdapter = (
    runtimeId: ChatRuntimeId,
    conversationId?: string | null,
  ): RemoteChatRuntimeAdapter => {
    const key = `${runtimeId}:${conversationId ?? ''}`
    let adapter = adapters.get(key)
    if (!adapter) {
      const transport = createWebRemoteTransport({
        baseUrl: options.baseUrl,
        sessionId: options.sessionId,
        fetchImpl: options.fetchImpl,
      })
      // The adapter is the web-native contract runtime; the conversation id
      // keys the server-side native runtime instance (stream/turn/permission
      // all resolve `conversationId` from the adapter).
      adapter = new RemoteChatRuntimeAdapter(
        runtimeId,
        transport,
        conversationId ?? '',
      )
      adapters.set(key, adapter)
    }
    return adapter
  }

  const createController = (
    runtimeId: CliRuntimeId,
  ): WebCliConversationController => {
    const controller = new WebCliConversationController(
      getAdapter(runtimeId),
      (conversationId) => getAdapter(runtimeId, conversationId),
      runtimeId,
    )
    allControllers.add(controller)
    return controller
  }

  const getController = (runtimeId: CliRuntimeId) => {
    let controller = controllers.get(runtimeId)
    if (!controller) {
      controller = createController(runtimeId)
      controllers.set(runtimeId, controller)
    }
    return controller
  }

  const listSessions = async (): Promise<CliSessionDiscoveryResult> => {
    const errors: CliSessionDiscoveryResult['errors'] = {}
    const results = await Promise.all(
      CLI_RUNTIME_IDS.map(async (runtimeId) => {
        try {
          const result = await getAdapter(runtimeId).listSessions()
          if (result.ok) return result.sessions
          errors[runtimeId] = getDiscoveryErrorMessage(result.error)
          return []
        } catch (error) {
          errors[runtimeId] =
            error instanceof Error ? error.message : String(error)
          return []
        }
      }),
    )
    return { sessions: results.flat().map(toSessionListItem), errors }
  }

  const sessionService = {
    listSessions: async () => {
      const result = await listSessions()
      return result.sessions.map((item) => item.ref) as never
    },
    discoverSessions: listSessions,
    recordOpenedSession: async () => undefined,
    recordUserDisplay: async () => undefined,
    getRememberedConfiguration: async () => ({}),
    renameSession: async (ref: CliSessionRef, title: string) => {
      const result = await getAdapter(ref.runtimeId).renameSession(ref, title)
      if (!result.ok) {
        throw new Error(getSessionCommandErrorMessage(result.error))
      }
    },
    recordTurnEditSummary: async () => undefined,
    rebindOverlay: async () => undefined,
    rememberConfiguration: async () => undefined,
    rememberContextUsage: async () => undefined,
    restoreUserDisplays: async (
      _ref: CliSessionRef,
      messages: readonly import('../../types/chat').ChatMessage[],
    ) => messages,
    restoreSessionOverlay: async (
      _ref: CliSessionRef,
      messages: readonly import('../../types/chat').ChatMessage[],
    ) => ({
      messages,
      turnConfigurationByUserMessageId: {},
    }),
    setPinned: async (ref: CliSessionRef, pinned: boolean) => {
      const result = await getAdapter(ref.runtimeId).setSessionPinned(ref, pinned)
      if (!result.ok) {
        throw new Error(getSessionCommandErrorMessage(result.error))
      }
    },
    removeOverlay: async (ref: CliSessionRef) => {
      const result = await getAdapter(ref.runtimeId).deleteSession(ref)
      if (!result.ok) {
        throw new Error(getSessionCommandErrorMessage(result.error))
      }
      return true
    },
  } as unknown as CliSessionService

  const toCliRuntime = (runtimeId: CliRuntimeId): CliRuntime => {
    const adapter = getAdapter(runtimeId)
    return {
      runtimeId,
      openSession: async (ref: CliSessionRef) => {
        await adapter.openSession(ref)
        const snapshot = adapter.getSnapshot()
        return {
          ref,
          messages: [...snapshot.messages],
          compactionBoundaries: [...(snapshot.compactionBoundaries ?? [])],
        }
      },
      ensureReady: async () => undefined,
      getConfiguration: async () =>
        adapter.getSnapshot().configuration as CliRuntimeConfiguration | null,
      updateConfiguration: async (update: {
        modelId?: string | null
        reasoningEffort?: string | null
      }) => {
        await adapter.updateConfiguration(update)
        return adapter.getSnapshot().configuration as CliRuntimeConfiguration | null
      },
      sendTurn: async () => undefined,
      rewriteTurn: async () => undefined,
      rollbackToTurn: async () => undefined,
      cancel: async () => undefined,
      respondApproval: async () => true,
      respondQuestion: async () => true,
      subscribe: () => () => undefined,
      dispose: async () => undefined,
    } as unknown as CliRuntime
  }

  return {
    sessionService,
    chatRuntimeActions: {} as never,
    // 浏览器里 Platform.isDesktop 为 false，Chat 的桌面探测不可达——改问
    // 服务端（桌面宿主）的实际探测结果。
    probeAvailability: async () => {
      const response = await probeTransport.get('/api/cli/availability')
      if (!response.ok) {
        return EMPTY_CLI_RUNTIME_AVAILABILITY
      }
      const payload = (await response.json().catch(() => null)) as Partial<
        Record<CliRuntimeId, boolean>
      > | null
      return Object.fromEntries(
        CLI_RUNTIME_IDS.map((runtimeId) => [
          runtimeId,
          payload?.[runtimeId] === true,
        ]),
      ) as CliRuntimeAvailability
    },
    resolveRuntime: toCliRuntime,
    selectConversationRuntime: (runtimeId) => getController(runtimeId),
    createConversationRuntime: (runtimeId) => {
      const previous = controllers.get(runtimeId)
      const controller = createController(runtimeId)
      controllers.set(runtimeId, controller)
      if (previous) {
        previous.dispose()
        allControllers.delete(previous)
      }
      return controller
    },
    selectConversationSession: (ref) => getController(ref.runtimeId),
    getModelCatalogSnapshot: () => new Map(),
    subscribeToModelCatalog: () => () => undefined,
    warmModelCatalog: async () => undefined,
    warmConversationRuntime: async () => undefined,
    getChatRuntime: (runtimeId, conversationId) =>
      getAdapter(runtimeId, conversationId),
    dispose: async () => {
      for (const controller of allControllers) controller.dispose()
      allControllers.clear()
      controllers.clear()
      for (const adapter of adapters.values()) await adapter.dispose()
      adapters.clear()
    },
  }
}
