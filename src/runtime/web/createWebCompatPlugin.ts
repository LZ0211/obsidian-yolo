import type { YoloPluginInfo, YoloRuntime } from '../yoloRuntime.types'

const EMPTY_MODULE_CHAT_MODE_SNAPSHOT: readonly unknown[] = Object.freeze([])

function unwrapAgentRunInput(input: unknown): unknown {
  if (
    input &&
    typeof input === 'object' &&
    'input' in input &&
    typeof (input as { input?: unknown }).input === 'object'
  ) {
    return (input as { input: unknown }).input
  }
  return input
}

export function createWebCompatPlugin({
  app,
  pluginInfo,
  getRuntime,
  getMcpManager,
}: {
  app: unknown
  pluginInfo: YoloPluginInfo
  getRuntime: () => YoloRuntime
  getMcpManager: () => Promise<unknown>
}) {
  const promptSourceWatcher = {
    getRevision: () => 0,
    setWatchedPaths: (_paths: Set<string>) => {},
    isWatching: (_path: string) => false,
  }
  const systemPromptSnapshotStore = {
    get: (_conversationId: string) => null,
    set: (_conversationId: string, _fingerprint: unknown, _snapshot: unknown) => {},
    evict: (_conversationId: string) => {},
    clear: () => {},
  }

  let cachedAgentService: Record<string, unknown> | null = null

  const getAgentService = () => {
    if (cachedAgentService) return cachedAgentService
    const runtime = getRuntime()
    const agent = runtime.agent
    cachedAgentService = {
      getState: (id: string) => agent.getState(id),
      getConversationRunSummary: (id: string) => agent.getConversationRunSummary(id),
      subscribe: (
        id: string,
        listener: (state: unknown) => void,
        options?: { emitCurrent?: boolean },
      ) => agent.subscribe(id, listener as never, options),
      getMessages: (id: string) => agent.getMessages(id),
      replaceConversationMessages: agent.replaceConversationMessages.bind(agent),
      run: (input: unknown) => agent.run(unwrapAgentRunInput(input) as never),
      abort: (id: string) => agent.abort(id),
      abortConversation: (id: string) => agent.abort(id),
      abortAll: () => {
        /* no-op for web */
      },
      approveToolCall: (input: unknown) => agent.approveToolCall(input as never),
      rejectToolCall: (input: unknown) => agent.rejectToolCall(input as never),
      abortToolCall: (input: unknown) => agent.abortToolCall(input as never),
      isRunning: (id: string) => agent.isRunning(id),
      subscribeToRunSummaries: (cb: (summaries: Map<string, unknown>) => void) =>
        agent.subscribeToRunSummaries(cb as never),
      // master 的 YoloRuntime 类型移除了 backup 的 activity/diagnostics 可选
      // 成员（conversation 子系统不存在），web 运行时也不实现——直接给降级值。
      getConversationActivitySnapshot: (id: string) => ({
        conversationId: id,
        activitiesById: new Map(),
        foregroundRunActivityIds: [],
        backgroundActivityIds: [],
      }),
      subscribeToConversationActivities: () => () => {},
      getConversationDiagnostics: () => [],
      subscribeToConversationDiagnostics: () => () => {},
      enqueueUserMessage: (id: string, message: unknown) =>
        agent.enqueueUserMessage(id, message as never),
      peekPendingUserMessages: (id: string) => agent.peekPendingUserMessages(id),
      removePendingUserMessage: (id: string, messageId: string) =>
        agent.removePendingUserMessage(id, messageId),
      subscribeToAbortedQueuedMessages: (cb: (messages: unknown) => void) =>
        agent.subscribeToAbortedQueuedMessages(cb as never),
      // web 运行时无后台任务（createWebYoloRuntime 未暴露该订阅）；Chat 主面
      // 会无条件调用，给永不长连的 no-op 订阅（回调不会触发）。
      subscribeToPendingBackgroundTaskResults: () => () => {},
      compactConversation: (input: unknown) => agent.compactConversation(input as never),
      getPromptSourceWatcher: () => promptSourceWatcher,
      getSystemPromptSnapshotStore: () => systemPromptSnapshotStore,
      evictSystemPromptSnapshot: (_id: string) => {
        /* no-op for web */
      },
      clearSystemPromptSnapshots: () => {
        /* no-op for web */
      },
      answerUserQuestion: async (_input: unknown) => ({ kind: 'not_awaiting' as const }),
      cancelAskUserQuestion: (_input: unknown) => {
        /* no-op for web */
      },
    }
    return cachedAgentService
  }

  // 模块聊天模式注册表：web 端不装载模块（模块是 Obsidian 桌面宿主能力），
  // 提供与"零模块注册"等价的空注册表——Chat.tsx / useChatStreamManager /
  // useYoloChatSession 都无条件消费 getSnapshot/subscribe，缺了会直接崩。
  const moduleChatModeRegistry = {
    subscribe: (_listener: () => void) => () => {},
    getSnapshot: () => EMPTY_MODULE_CHAT_MODE_SNAPSHOT,
  }

  // —— 桌面宿主能力：web 端不提供对应子系统，给语义正确的 no-op/null ——
  // 每个成员被调用时 console.warn 一次，便于审计"web 缺了哪个桌面能力"。
  const warnedDesktopOnly = new Set<string>()
  const warnDesktopOnly = (name: string): void => {
    if (warnedDesktopOnly.has(name)) return
    warnedDesktopOnly.add(name)
    console.warn(
      `[YOLO][Web] plugin.${name} is a desktop-only capability; no-op on web.`,
    )
  }
  const desktopOnlyNoop = (name: string) => {
    return (..._args: unknown[]): undefined => {
      warnDesktopOnly(name)
      return undefined
    }
  }
  const desktopOnlyAsyncNoop = (name: string) => {
    return async (..._args: unknown[]): Promise<undefined> => {
      warnDesktopOnly(name)
      return undefined
    }
  }

  return {
    app,
    manifest: {
      id: pluginInfo.id,
      name: pluginInfo.name,
      version: pluginInfo.version,
      dir: pluginInfo.dir,
    },
    getRuntime,
    getMcpManager,
    getAgentService,
    getModuleChatModeRegistry: () => moduleChatModeRegistry,
    openApplyReview: async (_input: unknown) => {
      /* apply-review is a desktop-only feature; no-op on web */
    },
    t: (_key: string, fallback?: string) => fallback ?? _key,
    // 更新/安装完整性：web 端无插件自更新子系统，永远"无待办"。
    installationIncompleteDetail: null,
    isInstallationIncompleteBannerDismissed: () => true,
    dismissInstallationIncompleteBanner: () => {},
    addInstallationIncompleteListener: () => () => {},
    repairIncompleteInstallation: desktopOnlyAsyncNoop('repairIncompleteInstallation'),
    pluginUpdateState: null,
    updateCheckResult: null,
    addPluginUpdateListener: () => () => {},
    addUpdateCheckListener: () => () => {},
    dismissUpdateForSession: desktopOnlyNoop('dismissUpdateForSession'),
    muteUpdateVersion: desktopOnlyNoop('muteUpdateVersion'),
    canSelfUpdatePlugin: () => false,
    applyPluginUpdate: desktopOnlyAsyncNoop('applyPluginUpdate'),
    startPluginUpdateDownload: desktopOnlyAsyncNoop('startPluginUpdateDownload'),
    applyModuleUpdate: desktopOnlyAsyncNoop('applyModuleUpdate'),
    dismissModuleUpdateForSession: desktopOnlyNoop('dismissModuleUpdateForSession'),
    muteModuleUpdate: desktopOnlyNoop('muteModuleUpdate'),
    getModuleUpdateSnapshot: () => null,
    subscribeModuleUpdates: () => () => {},
    getModuleService: () => null,
    getModuleSettingsContributionRegistry: () => null,
    getDbManager: desktopOnlyAsyncNoop('getDbManager'),
    getDatabaseMaintenanceController: () => null,
    getRuntimeComponentService: () => null,
    getVectorBackendStatus: desktopOnlyAsyncNoop('getVectorBackendStatus'),
    tryGetVectorManager: desktopOnlyAsyncNoop('tryGetVectorManager'),
    getRAGEngine: desktopOnlyAsyncNoop('getRAGEngine'),
    getRagIndexSnapshot: () => null,
    subscribeToRagIndexRuns: () => () => {},
    getRetrievalInspectStatus: () => null,
    listRetrievalTraces: async () => [],
    clearRetrievalTraces: desktopOnlyNoop('clearRetrievalTraces'),
    deleteRetrievalTrace: desktopOnlyNoop('deleteRetrievalTrace'),
    openRagLogModal: desktopOnlyNoop('openRagLogModal'),
    getLocalMcpServerState: () => null,
    subscribeLocalMcpServerState: () => () => {},
    getChatGPTOAuthStatus: desktopOnlyAsyncNoop('getChatGPTOAuthStatus'),
    getChatGPTOAuthService: desktopOnlyAsyncNoop('getChatGPTOAuthService'),
    disconnectChatGPTOAuthAccount: desktopOnlyAsyncNoop('disconnectChatGPTOAuthAccount'),
    clearChatGPTOAuthRuntime: desktopOnlyNoop('clearChatGPTOAuthRuntime'),
    getGeminiOAuthStatus: desktopOnlyAsyncNoop('getGeminiOAuthStatus'),
    getGeminiOAuthService: desktopOnlyAsyncNoop('getGeminiOAuthService'),
    disconnectGeminiOAuthAccount: desktopOnlyAsyncNoop('disconnectGeminiOAuthAccount'),
    clearGeminiOAuthRuntime: desktopOnlyNoop('clearGeminiOAuthRuntime'),
    getCachedModelList: () => [],
    setCachedModelList: desktopOnlyNoop('setCachedModelList'),
    getMarkdownInsertionTarget: () => null,
    openChatView: desktopOnlyNoop('openChatView'),
    continueWriting: desktopOnlyAsyncNoop('continueWriting'),
    startSelectionRewrite: desktopOnlyNoop('startSelectionRewrite'),
    warmupAgentService: desktopOnlyAsyncNoop('warmupAgentService'),
  }
}
