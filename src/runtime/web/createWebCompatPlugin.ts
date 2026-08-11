import type { YoloPluginInfo, YoloRuntime } from '../yoloRuntime.types'

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
    openApplyReview: async (_input: unknown) => {
      /* apply-review is a desktop-only feature; no-op on web */
    },
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }
}
