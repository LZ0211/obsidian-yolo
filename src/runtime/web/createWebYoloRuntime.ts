// master 的序列化工具位于 hooks/useChatHistory（Task 9 已加 serializeChatMessage
// export）；agent 状态类型位于 core/agent/service。
import type {
  AgentConversationRunSummary,
  AgentConversationState,
} from '../../core/agent/service'
import {
  deserializeChatMessage,
  serializeChatMessage,
} from '../../hooks/useChatHistory'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'
import {
  type ChatConversation,
  type ChatConversationCompactionLike,
  type ChatMessage,
  normalizeChatConversationCompactionState,
} from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import type {
  AppendYoloChatInput,
  RunYoloAgentInput,
  YoloFileStat,
  YoloRuntime,
  YoloVaultIndexEntry,
} from '../yoloRuntime.types'

import { createWebCompatApp } from './createWebCompatApp'
import { createWebCompatibilityBridge } from './createWebCompatibilityBridge'
import { createWebCompatPlugin } from './createWebCompatPlugin'
import { createWebMcpManager } from './createWebMcpManager'
import { Notice } from './obsidianCompat'
import type { WebApiClient, WebBootstrapPayload } from './WebApiClient'
import { createWebConversationGateway } from './WebConversationGateway'

export type { WebBootstrapPayload }

const idleState = (conversationId: string): AgentConversationState => ({
  conversationId,
  status: 'idle',
  messages: [],
  compaction: [],
  pendingCompactionAnchorMessageId: null,
})

const hasPendingApproval = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) =>
      message.role === 'tool' &&
      message.toolCalls.some(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.PendingApproval,
      ),
  )

const hasAwaitingUserInput = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) =>
      message.role === 'tool' &&
      message.toolCalls.some(
        (toolCall) =>
          toolCall.response.status ===
          ToolCallResponseStatus.AwaitingUserInput,
      ),
  )

const buildWebAgentConversationRunSummary = (
  state: AgentConversationState,
  options: { canQueueUserMessages?: boolean } = {},
): AgentConversationRunSummary => {
  const isWaitingUserInput = hasAwaitingUserInput(state.messages)
  const isWaitingApproval =
    hasPendingApproval(state.messages) || isWaitingUserInput
  const isRuntimeRunning = state.status === 'running'
  const isActive = isRuntimeRunning || isWaitingApproval
  let anchorMessageId = state.anchorMessageId
  if (!anchorMessageId && isActive) {
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index]
      if (message.role === 'user') {
        anchorMessageId = message.id
        break
      }
    }
  }

  return {
    conversationId: state.conversationId,
    anchorMessageId,
    status: state.status,
    isRunning: isRuntimeRunning && !isWaitingApproval,
    isActive,
    isAbortable: isActive,
    isQueueable:
      isRuntimeRunning &&
      !isWaitingApproval &&
      (options.canQueueUserMessages ?? true),
    isWaitingApproval,
    isWaitingUserInput,
    activity: state.activity,
  }
}

const normalizeWebChatMessage = (message: ChatMessage): ChatMessage => {
  if (message.role !== 'user') {
    return message
  }

  return {
    ...message,
    mentionables: message.mentionables ?? [],
    selectedSkills: message.selectedSkills ?? [],
    selectedModelIds: message.selectedModelIds ?? [],
  }
}

const normalizeWebChatMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map(normalizeWebChatMessage)

export function createWebYoloRuntime({
  api,
  bootstrap,
  initialSettings,
  initialAgents = [],
  initialVaultIndex = [],
}: {
  api: WebApiClient
  bootstrap: WebBootstrapPayload
  initialSettings: YoloSettings
  // Pre-resolved, session-scoped agent list from GET /api/agents — the server
  // merges workspace agents with their templates (and filters by token scope)
  // using the same id space end to end, so the web client never needs to
  // re-derive this list from the raw (and differently-scoped) settings
  // payload. Consumers should always read agents via runtime.getAgents(),
  // never by deriving them from settings.assistants/workspaceAgents directly.
  initialAgents?: Assistant[]
  initialVaultIndex?: YoloVaultIndexEntry[]
}): YoloRuntime {
  let currentSettings = initialSettings
  const currentAgents = initialAgents
  const settingsListeners = new Set<(settings: YoloSettings) => void>()
  const agentStates = new Map<string, AgentConversationState>()
  const stateListeners = new Map<
    string,
    Set<(state: AgentConversationState) => void>
  >()
  const runSummaryListeners = new Set<
    (summaries: Map<string, AgentConversationRunSummary>) => void
  >()
  const pendingResultListeners = new Set<(conversationId: string) => void>()
  const abortedQueueListeners = new Set<
    (conversationId: string, messages: ChatMessage[]) => void
  >()
  const activeRunIdsByConversation = new Map<string, string>()
  let queueEventStreamStarted = false
  let disposed = false
  const runtimeAbortController = new AbortController()

  const app = createWebCompatApp({
    api,
    vaultName: bootstrap.vaultName ?? 'Remote vault',
    initialIndex: initialVaultIndex,
    // Web file selection is per browser tab. Do not seed it from the desktop
    // workspace; the UI updates this compat app instance when the tab selects
    // a file, without writing that choice to server/session state.
    initialActiveFile: null,
    getAssistantId: () => null,
  })
  const mcpManager = createWebMcpManager({
    api,
    // 与桌面 McpManager 的 settings getter 一致：getSettingsSnapshot /
    // getJsSandboxSettings 读当前设置快照（跟随 settings.update 更新）。
    getSettings: () => currentSettings,
  })
  const pluginInfo = bootstrap.pluginInfo ?? {
    id: 'smart-rag',
    name: 'Smart RAG',
    version: 'web',
  }
  const plugin = createWebCompatPlugin({
    app,
    pluginInfo,
    getRuntime: () => runtime,
    getMcpManager: () => Promise.resolve(mcpManager),
  })
  const compatibility = createWebCompatibilityBridge({ app, plugin })
  // eslint-disable-next-line prefer-const -- runtime 需 let 延迟赋值（闭包环形引用），const 无法编译
  let runtime!: YoloRuntime
  const conversationGateway = createWebConversationGateway({
    getChat: () => runtime.chat,
  })

  const buildRunSummaryMap = () =>
    new Map(
      Array.from(agentStates.entries()).map(([conversationId, state]) => [
        conversationId,
        buildWebAgentConversationRunSummary(state),
      ]),
    )

  const emitState = (conversationId: string, state: AgentConversationState) => {
    if (disposed) return
    agentStates.set(conversationId, state)
    stateListeners.get(conversationId)?.forEach((listener) => listener(state))
    const summaries = buildRunSummaryMap()
    runSummaryListeners.forEach((listener) => listener(summaries))
  }

  const normalizeAgentState = (
    state: AgentConversationState,
  ): AgentConversationState => ({
    ...state,
    messages: state.messages.map((message) =>
      normalizeWebChatMessage(
        deserializeChatMessage(message as never, app as never),
      ),
    ),
  })

  const refreshAgentState = async (conversationId: string) => {
    if (disposed) return
    const state = await api.getJson<AgentConversationState>(
      `/api/agent/state?conversationId=${encodeURIComponent(conversationId)}`,
    )
    emitState(conversationId, normalizeAgentState(state))
  }

  const ensureQueueEventStream = () => {
    if (queueEventStreamStarted) return
    queueEventStreamStarted = true
    void consumeQueueEventStream({
      api,
      signal: runtimeAbortController.signal,
      onTerminated: () => {
        queueEventStreamStarted = false
      },
      onPendingResults: async (conversationId) => {
        if (disposed) return
        await refreshAgentState(conversationId)
        pendingResultListeners.forEach((listener) => listener(conversationId))
      },
      onAbortedQueuedMessages: (conversationId, messages) => {
        if (disposed) return
        const deserialized = messages.map((message) =>
          deserializeChatMessage(message as never, app as never),
        )
        abortedQueueListeners.forEach((listener) =>
          listener(conversationId, deserialized),
        )
      },
      onPendingUserMessagesChanged: (conversationId) => {
        if (disposed) return
        // 入队/出队变化：重发当前 agent 状态，驱动 useChatRunActivity 的
        // 订阅回调重新 peekPendingUserMessages，排队气泡才能出现/消失。
        const current = agentStates.get(conversationId)
        if (current) {
          emitState(conversationId, normalizeAgentState(current))
        } else {
          void refreshAgentState(conversationId)
        }
      },
    })
  }

  runtime = {
    mode: 'web',
    ...compatibility,
    pluginInfo,
    settings: {
      get: () => currentSettings,
      update: async (next) => {
        currentSettings = next
        settingsListeners.forEach((listener) => listener(currentSettings))
      },
      subscribe: (listener) => {
        settingsListeners.add(listener)
        return () => settingsListeners.delete(listener)
      },
    },
    getLanguage: () => {
      const raw = String(bootstrap.language ?? '').trim().toLowerCase()
      if (raw.startsWith('zh')) return 'zh'
      if (raw.startsWith('it')) return 'it'
      return 'en'
    },
    getAgents: () => currentAgents,
    getConversationGateway: () => conversationGateway,
    chat: {
      list: () => api.getJson('/api/chat/list'),
      get: async (id) => {
        const conversation = await api.getJsonOrNull<ChatConversation>(
          `/api/chat/get/${encodeURIComponent(id)}`,
        )
        if (!conversation) return null
        return {
          ...conversation,
          messages: conversation.messages.map((message) =>
            deserializeChatMessage(message, app as never),
          ),
        }
      },
      save: (input) => {
        const { workspaceId: _w, agentInstanceId: _a, ...rest } = input
        return api.postJson('/api/chat/save', {
          ...rest,
          messages: rest.messages.map(serializeChatMessage),
        })
      },
      appendMessages: async (input: AppendYoloChatInput) => {
        const { id, baseCount, newMessages, ...rest } = input
        try {
          await api.postJson('/api/chat/append-messages', {
            id,
            baseCount,
            newMessages: newMessages.map(serializeChatMessage),
            ...rest,
          })
          return { conflict: false }
        } catch {
          return { conflict: true }
        }
      },
      editHistoricalTurn: async (input) => {
        const conversation = await api.postJson<ChatConversation>(
          '/api/chat/edit-history',
          {
            ...input,
            replacement: serializeChatMessage(input.replacement),
          },
        )
        return {
          ...conversation,
          messages: conversation.messages.map((message) =>
            deserializeChatMessage(message, app as never),
          ),
        }
      },
      deleteHistoricalGroup: async (input) => {
        const conversation = await api.postJson<ChatConversation>(
          '/api/chat/delete-history',
          input,
        )
        return {
          ...conversation,
          messages: conversation.messages.map((message) =>
            deserializeChatMessage(message, app as never),
          ),
        }
      },
      claimHistoricalRetry: async (input) => {
        const conversation = await api.postJson<ChatConversation>(
          '/api/chat/claim-retry',
          input,
        )
        return {
          ...conversation,
          messages: conversation.messages.map((message) =>
            deserializeChatMessage(message, app as never),
          ),
        }
      },
      delete: (id) => api.postJson('/api/chat/delete', { conversationId: id }),
      togglePinned: (id) => api.postJson('/api/chat/toggle-pinned', { id }),
      updateTitle: (id, title, options) =>
        api.postJson('/api/chat/update-title', { id, title, ...options }),
      patchMetadata: (id, patch) =>
        api.postJson('/api/chat/patch-metadata', { id, patch }),
      generateTitle: async (id, messages, options) => {
        const result = await api.postJson<{ title?: string | null }>('/api/chat/generate-title', {
          conversationId: id,
          messages: messages.map(serializeChatMessage),
          force: options?.force,
        })
        return result.title ?? null
      },
      exportToVault: (id) =>
        api.postJson('/api/chat/export', { conversationId: id }),
    },
    agent: {
      run: async (input: RunYoloAgentInput) => {
        const primedMessages = normalizeWebChatMessages(
          input.conversationMessages ?? input.messages,
        )
        const primedCompaction =
          input.compaction == null
            ? []
            : normalizeChatConversationCompactionState(input.compaction)
        emitState(input.conversationId, {
          conversationId: input.conversationId,
          status: 'running',
          messages: primedMessages,
          compaction: primedCompaction,
          pendingCompactionAnchorMessageId: null,
        })
        // /api/agent/run 受保护：会话所属 agent/workspace 一律由服务端从
        // session binding 派生，客户端不得携带 selector 字段（否则 400）。
        // assistantId 在 web 会话里始终等于 activeAgentId，这里直接剥离。
        // 注意：Chat 主面（useChatStreamManager）传进来的是桌面形态的
        // AgentRuntimeRunInput（携带 providerClient/model/requestContextBuilder
        // 等不可序列化对象）——只能投影 WebRunInput 协议字段，其余一律丢弃，
        // 否则 JSON.stringify 在 providerClient（OpenAI SDK 客户端）上循环引用。
        const {
          conversationId,
          conversationMessages,
          messages,
          requestMessages,
          compaction,
          modelId,
          modelIds,
          reasoningLevel,
          branchTarget,
          overrides,
        } = input
        const response = await api.postJson<{
          conversationId: string
          runId: string
        }>('/api/agent/run', {
          conversationId,
          conversationMessages,
          messages,
          requestMessages,
          compaction,
          modelId,
          modelIds,
          reasoningLevel,
          branchTarget,
          overrides,
        })
        activeRunIdsByConversation.set(response.conversationId, response.runId)
        void consumeRunStream({
          api,
          signal: runtimeAbortController.signal,
          runId: response.runId,
          conversationId: response.conversationId,
          emitState,
          refreshAgentState,
          normalizeAgentState,
          getPreviousState: () =>
            agentStates.get(response.conversationId) ??
            idleState(response.conversationId),
        })
      },
      abort: async (conversationId) => {
        const runId = activeRunIdsByConversation.get(conversationId)
        if (runId) {
          await api.postJson(`/api/agent/abort/${encodeURIComponent(runId)}`, {})
        }
      },
      subscribe: (conversationId, listener, options) => {
        const listeners =
          stateListeners.get(conversationId) ??
          new Set<(state: AgentConversationState) => void>()
        listeners.add(listener)
        stateListeners.set(conversationId, listeners)
        if (options?.emitCurrent !== false) {
          listener(agentStates.get(conversationId) ?? idleState(conversationId))
        }
        return () => {
          listeners.delete(listener)
        }
      },
      getState: (conversationId) =>
        agentStates.get(conversationId) ?? idleState(conversationId),
      getConversationRunSummary: (conversationId) =>
        buildWebAgentConversationRunSummary(
          agentStates.get(conversationId) ?? idleState(conversationId),
        ),
      getMessages: (conversationId) =>
        agentStates.get(conversationId)?.messages ?? [],
      replaceConversationMessages: (conversationId, messages, compaction) => {
        const previous = agentStates.get(conversationId) ?? idleState(conversationId)
        emitState(conversationId, {
          ...previous,
          messages,
          compaction:
            compaction == null
              ? previous.compaction
              : normalizeChatConversationCompactionState(
                  compaction as ChatConversationCompactionLike,
                ),
        })
      },
      approveToolCall: async (input) => {
        const response = await api.postJson<{
          approved: boolean
          state?: AgentConversationState
        }>('/api/agent/tool/approve', input)
        if (response.state) {
          emitState(input.conversationId, normalizeAgentState(response.state))
        }
        return response.approved
      },
      rejectToolCall: async (input) => {
        const response = await api.postJson<{ rejected: boolean }>(
          '/api/agent/tool/reject',
          input,
        )
        return response.rejected
      },
      abortToolCall: async (input) => {
        const response = await api.postJson<{ aborted: boolean }>(
          '/api/agent/tool/abort',
          input,
        )
        return response.aborted
      },
      isRunning: (conversationId) =>
        buildWebAgentConversationRunSummary(
          agentStates.get(conversationId) ?? idleState(conversationId),
        ).isRunning,
      subscribeToRunSummaries: (callback) => {
        runSummaryListeners.add(callback)
        callback(buildRunSummaryMap())
        return () => runSummaryListeners.delete(callback)
      },
      subscribeToPendingExternalAgentResults: (callback) => {
        ensureQueueEventStream()
        pendingResultListeners.add(callback)
        return () => pendingResultListeners.delete(callback)
      },
      peekPendingUserMessages: async (conversationId) => {
        const response = await api.getJson<{ messages: ChatMessage[] }>(
          `/api/agent/queue/peek?conversationId=${encodeURIComponent(
            conversationId,
          )}`,
        )
        return response.messages.map((message) =>
          deserializeChatMessage(message as never, app as never),
        ) as never
      },
      enqueueUserMessage: async (conversationId, message) => {
        const response = await api.postJson<{
          result: Awaited<
            ReturnType<YoloRuntime['agent']['enqueueUserMessage']>
          >
        }>('/api/agent/queue/enqueue', {
          conversationId,
          message: serializeChatMessage(message),
        })
        return response.result
      },
      removePendingUserMessage: async (conversationId, messageId) => {
        const response = await api.postJson<{ message: ChatMessage | null }>(
          '/api/agent/queue/remove',
          { conversationId, messageId },
        )
        return response.message
          ? (deserializeChatMessage(response.message as never, app as never) as never)
          : null
      },
      subscribeToAbortedQueuedMessages: (callback) => {
        ensureQueueEventStream()
        abortedQueueListeners.add(callback as never)
        return () => abortedQueueListeners.delete(callback as never)
      },
      compactConversation: (input) =>
        api.postJson('/api/agent/compact', input),
      buildContextBreakdownInputs: (input) =>
        api.postJson('/api/agent/context-breakdown', input),
    },
    vault: {
      getActiveFile: () => app.workspace.getActiveFile(),
      read: async (file) => app.vault.read(file),
      readBinary: async (file) => app.vault.readBinary(file),
      search: (query) =>
        api.getJson(`/api/vault/search?query=${encodeURIComponent(query)}`),
      listIndex: async () => fetchRemoteVaultIndex({ api, app }),
      getAbstractFileByPath: (path) => toYoloFileRef(app.vault.getAbstractFileByPath(path)),
      getFileByPath: (path) => app.vault.getFileByPath(path),
      createFolder: (path) => app.vault.createFolder(path),
      modify: (file, content) =>
        app.vault.modify(
          typeof file === 'string' ? app.vault.getFileByPath(file) : file,
          content,
        ),
      create: async (path, content) => {
        await app.vault.create(path, content)
      },
      trashFile: (file) =>
        app.fileManager.trashFile(
          typeof file === 'string' ? app.vault.getAbstractFileByPath(file) : file,
        ),
      getLeavesOfType: (type) => app.workspace.getLeavesOfType(type),
      getLeaf: (split) => app.workspace.getLeaf(split),
    },
    ui: {
      notice: (message, timeoutMs) => {
        new Notice(message, timeoutMs)
      },
      openSettings: () => {
        new Notice('Web runtime settings are managed in Obsidian.', 5000)
      },
      openApplyReview: async (state) => {
        const response = await api.postJson<{ applied: boolean }>(
          '/api/ui/apply-review',
          { state },
        )
        return response.applied
      },
    },
  }

  return Object.assign(runtime, {
    __yoloDispose: () => {
      disposed = true
      runtimeAbortController.abort()
      settingsListeners.clear()
      stateListeners.clear()
      runSummaryListeners.clear()
      pendingResultListeners.clear()
      abortedQueueListeners.clear()
    },
  })
}

const MAX_RUN_STREAM_RETRIES = 3
const STREAM_RETRY_BASE_MS = 1_000
const STREAM_RETRY_MAX_MS = 15_000

const sleepWithAbort = (
  ms: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
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

/** 提取 SSE 帧的 `id:` 行（服务端写的是 event sequence，供 cursor 重放）。 */
const parseSseEventId = (rawEvent: string): number | null => {
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('id:')) {
      const raw = line.slice(3).trim()
      const value = Number.parseInt(raw, 10)
      if (Number.isFinite(value)) return value
    }
  }
  return null
}

function toYoloFileRef(file: {
  path: string
  name: string
  stat?: { ctime: number; mtime: number; size: number }
  basename?: string
  extension?: string
} | null): YoloVaultIndexEntry | null {
  if (!file) return null
  const name = file.name
  const dot = name.lastIndexOf('.')
  return {
    kind: 'children' in file ? 'folder' : 'file',
    path: file.path,
    name,
    basename: file.basename ?? (dot > 0 ? name.slice(0, dot) : name),
    extension: file.extension ?? (dot > 0 ? name.slice(dot + 1) : ''),
    stat: file.stat,
  }
}

async function consumeRunStream({
  api,
  signal,
  runId,
  conversationId,
  emitState,
  refreshAgentState,
  normalizeAgentState,
  getPreviousState,
}: {
  api: WebApiClient
  signal?: AbortSignal
  runId: string
  conversationId: string
  emitState: (conversationId: string, state: AgentConversationState) => void
  refreshAgentState: (conversationId: string) => Promise<void>
  normalizeAgentState: (state: AgentConversationState) => AgentConversationState
  getPreviousState: () => AgentConversationState
}): Promise<void> {
  let attempt = 0
  let cursor: number | null = null
  while (!signal?.aborted) {
    try {
      const cursorQuery = cursor == null ? '' : `?cursor=${cursor}`
      const response = await api.openSseFetch(
        `/api/agent/stream/${encodeURIComponent(runId)}${cursorQuery}`,
        signal,
      )
      if (!response.ok || !response.body) {
        throw new Error(`SSE stream failed with ${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          applySsePayload({
            rawEvent,
            conversationId,
            emitState,
            normalizeAgentState,
            getPreviousState,
          })
          const eventId = parseSseEventId(rawEvent)
          if (eventId != null) cursor = eventId
          boundary = buffer.indexOf('\n\n')
        }
      }
      if (buffer.trim().length > 0) {
        applySsePayload({
          rawEvent: buffer,
          conversationId,
          emitState,
          normalizeAgentState,
          getPreviousState,
        })
        const eventId = parseSseEventId(buffer)
        if (eventId != null) cursor = eventId
      }
      // 服务端在 run 终态后关闭流：拉全量状态收尾（正常完成路径）。
      await refreshAgentState(conversationId)
      return
    } catch (error) {
      if (signal?.aborted) return
      attempt += 1
      if (attempt > MAX_RUN_STREAM_RETRIES) {
        const previous = getPreviousState()
        emitState(conversationId, {
          ...previous,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        return
      }
      // 断线重连（E2）：退避后按 cursor 重放，避免整个 run 落入 error 态。
      await sleepWithAbort(
        Math.min(STREAM_RETRY_BASE_MS * 2 ** (attempt - 1), STREAM_RETRY_MAX_MS),
        signal,
      )
    }
  }
}

async function consumeQueueEventStream({
  api,
  signal,
  onPendingResults,
  onAbortedQueuedMessages,
  onPendingUserMessagesChanged,
  onTerminated,
}: {
  api: WebApiClient
  signal?: AbortSignal
  onPendingResults: (conversationId: string) => void | Promise<void>
  onAbortedQueuedMessages: (
    conversationId: string,
    messages: ChatMessage[],
  ) => void
  onPendingUserMessagesChanged: (conversationId: string) => void
  /** 流结束/放弃时回调，让调用方复位 started 标记以便未来重启（E2）。 */
  onTerminated: () => void
}): Promise<void> {
  let attempt = 0
  try {
    while (!signal?.aborted) {
      try {
        const response = await api.openSseFetch('/api/agent/queue/events', signal)
        if (!response.ok || !response.body) {
          throw new Error(`Queue SSE stream failed with ${response.status}`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            applyQueueSsePayload({
              rawEvent: buffer.slice(0, boundary),
              onPendingResults,
              onAbortedQueuedMessages,
              onPendingUserMessagesChanged,
            })
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
          }
        }
        if (buffer.trim().length > 0) {
          applyQueueSsePayload({
            rawEvent: buffer,
            onPendingResults,
            onAbortedQueuedMessages,
            onPendingUserMessagesChanged,
          })
        }
        // 服务端关闭 queue 流：正常收尾。
        return
      } catch (error) {
        if (signal?.aborted) return
        attempt += 1
        console.warn(
          `[YOLO][Web] queue event stream failed (retry ${attempt})`,
          error,
        )
        await sleepWithAbort(
          Math.min(
            STREAM_RETRY_BASE_MS * 2 ** (attempt - 1),
            STREAM_RETRY_MAX_MS,
          ),
          signal,
        )
      }
    }
  } finally {
    onTerminated()
  }
}

function applyQueueSsePayload({
  rawEvent,
  onPendingResults,
  onAbortedQueuedMessages,
  onPendingUserMessagesChanged,
}: {
  rawEvent: string
  onPendingResults: (conversationId: string) => void | Promise<void>
  onAbortedQueuedMessages: (
    conversationId: string,
    messages: ChatMessage[],
  ) => void
  onPendingUserMessagesChanged: (conversationId: string) => void
}): void {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return

  const parsed = JSON.parse(data) as {
    type?: string
    conversationId?: string
    messages?: ChatMessage[]
  }
  if (typeof parsed.conversationId !== 'string') return
  if (parsed.type === 'pending_background_task_results') {
    void Promise.resolve(onPendingResults(parsed.conversationId)).catch(
      (error) => {
        console.warn('[YOLO][Web] failed to handle pending results event', error)
      },
    )
    return
  }
  if (
    parsed.type === 'aborted_queued_messages' &&
    Array.isArray(parsed.messages)
  ) {
    onAbortedQueuedMessages(parsed.conversationId, parsed.messages)
    return
  }
  if (parsed.type === 'user_message_enqueued') {
    onPendingUserMessagesChanged(parsed.conversationId)
  }
}

function applySsePayload({
  rawEvent,
  conversationId,
  emitState,
  normalizeAgentState,
  getPreviousState,
}: {
  rawEvent: string
  conversationId: string
  emitState: (conversationId: string, state: AgentConversationState) => void
  normalizeAgentState: (state: AgentConversationState) => AgentConversationState
  getPreviousState: () => AgentConversationState
}): void {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return
  const parsed = JSON.parse(data) as unknown
  if (isAgentConversationState(parsed)) {
    emitState(parsed.conversationId, normalizeAgentState(parsed))
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const event = parsed as {
    type?: string
    status?: AgentConversationState['status']
    message?: string
  }
  const previous = getPreviousState()
  if (event.type === 'state' && event.status) {
    emitState(conversationId, {
      ...previous,
      status: event.status,
    })
  } else if (event.type === 'error') {
    emitState(conversationId, {
      ...previous,
      status: 'error',
      errorMessage: event.message,
    })
  }
}

function isAgentConversationState(value: unknown): value is AgentConversationState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AgentConversationState>
  return (
    typeof candidate.conversationId === 'string' &&
    typeof candidate.status === 'string' &&
    Array.isArray(candidate.messages)
  )
}

async function fetchRemoteVaultIndex({
  api,
  app,
}: {
  api: WebApiClient
  app: ReturnType<typeof createWebCompatApp>
}): Promise<YoloVaultIndexEntry[]> {
  const items: Array<{
    kind: 'file' | 'folder'
    path: string
    name: string
    basename?: string
    extension?: string
    stat?: YoloFileStat
  }> = []
  let cursor: string | undefined

  while (true) {
    const response = await api.listVaultIndex({ limit: 5000, cursor })
    items.push(...response.items)
    if (!response.hasMore || !response.nextCursor) {
      break
    }
    cursor = response.nextCursor
  }

  const index = items.map((item) => ({
    kind: item.kind,
    path: item.path,
    name: item.name,
    basename: item.basename ?? item.name.replace(/\.[^.]*$/, ''),
    extension: item.extension ?? '',
    stat: item.stat,
  }))
  const refreshIndex = (app as unknown as {
    __yoloRefreshIndex?: (nextIndex: YoloVaultIndexEntry[]) => void
  }).__yoloRefreshIndex
  refreshIndex?.(index)
  return index
}
