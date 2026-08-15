import type { App } from 'obsidian'

import { DEFAULT_UNTITLED_CONVERSATION_TITLE } from '../../constants'
import type { ChatMode } from '../../components/chat-view/chat-input/ChatModeSelect'
import { resolveChatModeRuntime } from '../../components/chat-view/chat-runtime-profiles'
import type { ChatManager } from '../../database/json/chat/ChatManager'
import type { ChatConversation } from '../../database/json/chat/types'
import type {
  WorkspaceAgentPolicy,
  YoloSettings,
} from '../../settings/schema/setting.types'
import type { AssistantToolPreference } from '../../types/assistant.types'
import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type {
  ChatConversationCompaction,
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import {
  type ReasoningLevel,
  normalizeStoredReasoningLevel,
  resolveRequestReasoningLevel,
} from '../../types/reasoning'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { resolveEffectiveMaxContextTokens } from '../../utils/llm/model-capability-registry'
import {
  type YoloAgentEvent,
  conversationStateToEvents,
} from '../agent/agent-api'
import { DEFAULT_BLOCKED_PREFIXES } from '../agent/bash/command-classifier'
import {
  CONTEXT_COMPACT_TOOL_NAME,
  buildManualCompactionState,
  createConversationCompactionSummary,
  getLastAssistantPromptTokens,
  resolveAutoContextCompactionChatOptions,
} from '../agent/compaction'
import { estimateContextBreakdown } from '../agent/contextBreakdown'
import { estimateContinuationRequestContextTokens } from '../agent/requestContextEstimate'
import type { AgentConversationState, AgentService } from '../agent/service'
import { buildToolCapabilityPrompt } from '../agent/tool-capability-prompt'
import { getEnabledAssistantToolNames } from '../agent/tool-preferences'
import { selectAllowedTools } from '../agent/tool-selection'
import type { AgentRuntimeRunInput } from '../agent/types'
import { LLMModelNotFoundException } from '../llm/exception'
import { getChatModelClient } from '../llm/manager'
import {
  TERMINAL_COMMAND_TOOL_NAME,
  getLocalFileToolServerName,
} from '../mcp/localFileToolNames'
import { McpManager } from '../mcp/mcpManager'
import { getToolName } from '../mcp/tool-name-utils'
import { getMemoryIndexRuntimeHandle } from '../memory/memoryIndexRuntime'
import { augmentWorkspacePolicyWithProtectedPaths } from '../paths/protectedPaths'
import { listLiteSkillEntries } from '../skills/liteSkills'
import { isSkillEnabledForAssistant } from '../skills/skillPolicy'
import { resolveConversationFileScope } from '../workspace/conversationFileScope'

import { createWebAgentStateThrottler } from './WebAgentStateThrottler'
import type { EffectiveWorkspaceAgent } from './webAgentTypes'

export type WebChatRuntimeAdapterOptions = {
  app: App
  /** Master ChatManager 会话仓库（替代 backup 的 ConversationGateway）。 */
  chatManager: ChatManager
  /** 会话读取注入点：web 层提供 ChatManager.load 语义的读取函数。 */
  loadConversation: (conversationId: string) => Promise<ChatConversation | null>
  getSettings: () => YoloSettings
  getAgentService: () => AgentService
  getMcpManager: () => Promise<McpManager>
}

/**
 * Web run 输入（backup 的 RunYoloAgentInput 在 master 不存在；master 没有
 * backup 的 MoA 聚合运行时，故 moa 字段在此层移除）。
 */
export type WebRunInput = {
  conversationId: string
  /** 分支会话传历史（缺省回退 input.messages）。 */
  conversationMessages?: ChatMessage[]
  messages: ChatMessage[]
  requestMessages?: ChatMessage[]
  compaction?: ChatConversationCompactionLike | null
  modelId?: string
  modelIds?: string[]
  reasoningLevel?: ReasoningLevel
  branchTarget?: {
    branchId: string
    sourceUserMessageId: string
    branchLabel?: string
  }
  overrides?: ConversationOverrideSettings | null
}

type PreparedWebAgentRun = {
  conversationId: string
  execute: (input: {
    abortSignal: AbortSignal
    onEvent: (
      event: YoloAgentEvent | (AgentConversationState & { type: 'state' }),
    ) => void
  }) => Promise<void>
  abort: () => boolean
}

export type CompactConversationInput = {
  conversationId: string
  messages: ChatMessage[]
  modelId?: string
  assistantId?: string
  chatMode?: string
  overrides?: ConversationOverrideSettings | null
}

export type ContextBreakdownRouteInput = CompactConversationInput & {
  compaction?: ChatConversationCompactionLike | null
}

// backup 的 compaction 模块导出 CONTEXT_COMPACT_ACTION（'compact'）；master
// 只导出工具名，action 常量在本适配层补齐。
const CONTEXT_COMPACT_ACTION = 'compact'

// Auto-compaction runs through the consolidated `context_manage` tool's
// `compact` action (the legacy `context_compact` name was removed by the 82→83
// migration).
const AUTO_CONTEXT_COMPACT_TOOL_FQN = getToolName(
  getLocalFileToolServerName(),
  CONTEXT_COMPACT_TOOL_NAME,
)

const AUTO_CONTEXT_COMPACT_TOOL_PREFERENCE: AssistantToolPreference = {
  enabled: true,
  approvalMode: 'full_access',
  disclosureMode: 'always',
  actions: {
    [CONTEXT_COMPACT_ACTION]: { enabled: true, approvalMode: 'full_access' },
  },
}

const WEB_AGENT_STATE_INTERVAL_MS = 250

const enableAutoContextCompactionTool = (
  runtime: ReturnType<typeof resolveChatModeRuntime>,
  enabled: boolean,
) => {
  if (!enabled) {
    return runtime
  }

  const allowedToolNames =
    runtime.allowedToolNames === undefined && runtime.loopConfig.enableTools
      ? undefined
      : [
          ...new Set([
            ...(runtime.allowedToolNames ?? []),
            AUTO_CONTEXT_COMPACT_TOOL_FQN,
          ]),
        ]

  return {
    ...runtime,
    loopConfig: {
      ...runtime.loopConfig,
      enableTools: true,
      includeBuiltinTools: true,
    },
    allowedToolNames,
    toolPreferences: {
      ...(runtime.toolPreferences ?? {}),
      [AUTO_CONTEXT_COMPACT_TOOL_FQN]: {
        ...(runtime.toolPreferences?.[AUTO_CONTEXT_COMPACT_TOOL_FQN] ?? {}),
        ...AUTO_CONTEXT_COMPACT_TOOL_PREFERENCE,
      },
    },
  }
}

export function workspaceAgentPolicyToRuntimeAccessPolicy(
  policy: WorkspaceAgentPolicy,
  settings?: YoloSettings,
): WorkspaceAccessPolicy {
  return augmentWorkspacePolicyWithProtectedPaths(
    {
      enabled: true,
      workspaceRoot: policy.workspaceRoot,
      readExtraIncludes: policy.readAllowlist,
      readExcludes: policy.readDenylist,
      writeExcludes: policy.writeDenylist,
    },
    settings,
  )!
}

// 本类不实现 Task 4 的 ChatRuntime 契约：它是 web 层的 run 提交服务（会话
// 落库 + AgentService 分发 + 事件投影），ChatRuntime 由后续 remote adapter
// 在其上补全能力面。
export class WebChatRuntimeAdapter {
  constructor(private readonly options: WebChatRuntimeAdapterOptions) {}

  async prepareRun(
    input: WebRunInput,
    activeAgent: EffectiveWorkspaceAgent,
    rootHash?: string,
  ): Promise<PreparedWebAgentRun> {
    const conversation = await this.ensureConversation(
      input,
      rootHash,
      activeAgent.id,
    )
    const conversationId = conversation.id
    const baseMessages = input.conversationMessages ?? input.messages
    const resolved = await this.resolveRunContext({
      conversationId,
      messages: input.messages,
      requestMessages: input.requestMessages,
      compaction: input.compaction,
      modelId: input.modelId,
      modelIds: input.modelIds,
      activeAgent,
      workingDirectory: conversation.workingDirectory,
      reasoningLevel: input.reasoningLevel,
      branchTarget: input.branchTarget,
      overrides: input.overrides,
    })
    const agentService = this.options.getAgentService()

    return {
      conversationId,
      execute: async ({ abortSignal, onEvent }) => {
        agentService.replaceConversationMessages(
          conversationId,
          baseMessages,
          input.compaction,
          { persistState: true },
        )
        let previous = {
          assistantTextById: new Map(),
          toolStatusById: new Map(),
        } satisfies Parameters<typeof conversationStateToEvents>[0]['previous']
        const sourceUserMessageId =
          resolved.sourceUserMessageId ??
          [...baseMessages].reverse().find((message) => message.role === 'user')
            ?.id ??
          ''
        const stateThrottler = createWebAgentStateThrottler({
          intervalMs: WEB_AGENT_STATE_INTERVAL_MS,
          emit: (state: AgentConversationState) => {
            onEvent({ type: 'state', ...state })
          },
        })
        const unsubscribe = agentService.subscribe(
          conversationId,
          (state) => {
            stateThrottler.publish(state)
            if (!sourceUserMessageId) return
            const projected = conversationStateToEvents({
              state,
              sourceUserMessageId,
              previous,
            })
            previous = projected.nextTracker
            for (const event of projected.events) {
              if (event.type === 'state') continue
              onEvent(event)
            }
            if (
              state.status === 'completed' ||
              state.status === 'aborted' ||
              state.status === 'error'
            ) {
              stateThrottler.flush()
            }
          },
          { emitCurrent: true },
        )
        const onAbort = () => {
          agentService.abortConversation(conversationId)
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })
        try {
          await resolved.execute({ abortSignal })
        } finally {
          abortSignal.removeEventListener('abort', onAbort)
          unsubscribe()
          stateThrottler.flush()
          stateThrottler.dispose()
        }
      },
      abort: () => agentService.abortConversation(conversationId),
    }
  }

  async compactConversation(
    input: CompactConversationInput,
    activeAgent: EffectiveWorkspaceAgent,
  ): Promise<ChatConversationCompaction | null> {
    if (input.messages.length === 0) {
      return null
    }

    const resolved = await this.resolveSharedContext({
      conversationId: input.conversationId,
      messages: input.messages,
      modelId: input.modelId,
      activeAgent,
      chatMode: input.chatMode,
      overrides: input.overrides,
      compaction: null,
    })

    const { settings, requestContextBuilder, mcpManager } = resolved
    const autoContextCompactionOptions =
      resolveAutoContextCompactionChatOptions(settings.chatOptions)
    const chatModeRuntime = enableAutoContextCompactionTool(
      resolved.chatModeRuntime,
      autoContextCompactionOptions.autoContextCompactionEnabled,
    )

    const availableTools = chatModeRuntime.loopConfig.enableTools
      ? await mcpManager.listAvailableTools({
          includeBuiltinTools: chatModeRuntime.loopConfig.includeBuiltinTools,
          chatModelModalities: resolved.model.model.modalities,
        })
      : []
    const { hasTools, hasMemoryTools, hasOnDemandTools, requestTools } =
      await selectAllowedTools({
        availableTools,
        allowedToolNames: chatModeRuntime.allowedToolNames,
        toolPreferences: chatModeRuntime.toolPreferences,
        apiType: resolved.provider?.apiType ?? null,
        enableToolDisclosure: settings.mcp.enableToolDisclosure,
        jsSandboxSettings: mcpManager.getJsSandboxSettings(),
      })
    const runtimeModePrompt = buildToolCapabilityPrompt({
      mode: chatModeRuntime.toolCapabilityMode,
      toolNames: (requestTools ?? []).map((tool) => tool.function.name),
    })
    const requestMessages = await requestContextBuilder.generateRequestMessages(
      {
        messages: input.messages,
        hasTools,
        hasMemoryTools,
        hasOnDemandTools,
        model: resolved.model.model,
        conversationId: input.conversationId,
        compaction: [],
        contextualInjections: [],
        runtimeModePrompt,
        systemPromptSnapshotMode: 'reuse',
      },
    )
    const lastUserMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === 'user')
    const reasoningLevel = resolveRequestReasoningLevel(
      resolved.model.model,
      lastUserMessage?.role === 'user'
        ? (normalizeStoredReasoningLevel(lastUserMessage.reasoningLevel) ??
            undefined)
        : undefined,
    )

    const summary = await createConversationCompactionSummary({
      providerClient: resolved.model.providerClient,
      model: resolved.model.model,
      requestMessages,
      tools: requestTools,
      reasoningLevel,
    })
    const nextCompaction = await buildManualCompactionState({
      messages: input.messages,
      summary,
      summaryModelId: resolved.model.model.id,
    })
    if (!nextCompaction) {
      return null
    }

    try {
      nextCompaction.estimatedNextContextTokens =
        await estimateContinuationRequestContextTokens({
          requestContextBuilder,
          mcpManager,
          model: resolved.model.model,
          messages: input.messages,
          conversationId: input.conversationId,
          compaction: nextCompaction,
          enableTools: chatModeRuntime.loopConfig.enableTools,
          includeBuiltinTools: chatModeRuntime.loopConfig.includeBuiltinTools,
          apiType: resolved.provider?.apiType ?? null,
          allowedToolNames: chatModeRuntime.allowedToolNames,
          enableToolDisclosure: settings.mcp.enableToolDisclosure,
          toolPreferences: chatModeRuntime.toolPreferences,
          toolCapabilityMode: chatModeRuntime.toolCapabilityMode,
          contextualInjections: [],
        })
    } catch (error) {
      console.warn(
        '[YOLO][Web] failed to estimate continuation context tokens',
        error,
      )
    }

    const preCompactionTokens = getLastAssistantPromptTokens(input.messages)
    if (
      typeof preCompactionTokens === 'number' &&
      typeof nextCompaction.estimatedNextContextTokens === 'number'
    ) {
      const saved =
        preCompactionTokens - nextCompaction.estimatedNextContextTokens
      if (saved > 0) {
        nextCompaction.estimatedTokensSaved = saved
      }
    }

    return nextCompaction
  }

  async buildContextBreakdown(
    input: ContextBreakdownRouteInput,
    activeAgent: EffectiveWorkspaceAgent,
  ) {
    if (input.messages.length === 0) {
      return {
        buckets: [],
        total: 0,
        max: null,
        computedAt: Date.now(),
      }
    }

    const resolved = await this.resolveSharedContext({
      conversationId: input.conversationId,
      messages: input.messages,
      modelId: input.modelId,
      activeAgent,
      chatMode: input.chatMode,
      overrides: input.overrides,
      compaction: input.compaction,
    })

    return estimateContextBreakdown({
      requestContextBuilder: resolved.requestContextBuilder,
      mcpManager: resolved.mcpManager,
      model: resolved.model.model,
      messages: input.messages,
      conversationId: input.conversationId,
      compaction: input.compaction,
      enableTools: resolved.chatModeRuntime.loopConfig.enableTools,
      includeBuiltinTools:
        resolved.chatModeRuntime.loopConfig.includeBuiltinTools,
      apiType: resolved.provider?.apiType ?? null,
      allowedToolNames: resolved.chatModeRuntime.allowedToolNames,
      enableToolDisclosure: resolved.settings.mcp.enableToolDisclosure,
      toolPreferences: resolved.chatModeRuntime.toolPreferences,
      toolCapabilityMode: resolved.chatModeRuntime.toolCapabilityMode,
      contextualInjections: [],
    })
  }

  private async ensureConversation(
    input: WebRunInput,
    rootHash?: string,
    agentId?: string,
  ) {
    const existing = await this.options.loadConversation(input.conversationId)
    if (existing) {
      return existing
    }
    const createdAt = Date.now()
    try {
      // backup 走 gateway dispatch（producer 'web'）；master 的 ChatManager
      // createChat 是幂等语义的唯一创建入口（origin 标记外部创建）。
      // 会话一创建就带上 webBinding（rootHash 来自会话 binding）——否则
      // runAgent 的补丁写入与 AgentService 的 persistConversationMessages
      // （每次调用新建 ChatManager、独立写队列）之间是读-改-写竞态：persist
      // 可能读到补丁前的旧状态并在补丁写入后落盘，把 webBinding 覆盖掉，
      // 导致后续工具审批/访问控制 404。创建即带 binding 后竞态无害（任何
      // 读都读到 binding）。
      return await this.options.chatManager.createChat({
        id: input.conversationId,
        // 空串"未命名"哨兵（桌面端语义）：标题为 'New chat' 会让自动命名
        // 判定为"已命名"而跳过（isUntitledConversationTitle 不认该字面量）。
        title: DEFAULT_UNTITLED_CONVERSATION_TITLE,
        messages: [],
        createdAt,
        updatedAt: createdAt,
        origin: 'external-agent',
        ...(rootHash && agentId
          ? {
              agentInstanceId: agentId,
              webBinding: {
                initialAgentId: agentId,
                activeAgentId: agentId,
                rootHash,
              },
            }
          : {}),
      } as never)
    } catch (error) {
      // 并发 web 请求竞争创建：文件已存在时回退到读取（对齐 backup
      // dispatch 的 'already_applied' 容忍语义），否则原样抛出。
      const created = await this.options.loadConversation(input.conversationId)
      if (created) return created
      throw error
    }
  }

  private async resolveRunContext(input: {
    conversationId: string
    messages: ChatMessage[]
    requestMessages?: ChatMessage[]
    compaction?: ChatConversationCompactionLike | null
    modelId?: string
    modelIds?: string[]
    activeAgent: EffectiveWorkspaceAgent
    workingDirectory?: string
    reasoningLevel?: ReasoningLevel
    branchTarget?: WebRunInput['branchTarget']
    overrides?: ConversationOverrideSettings | null
  }): Promise<{
    execute: (run: { abortSignal: AbortSignal }) => Promise<void>
    sourceUserMessageId?: string
  }> {
    const resolved = await this.resolveSharedContext({
      conversationId: input.conversationId,
      messages: input.messages,
      modelId: input.modelId,
      activeAgent: input.activeAgent,
      chatMode: input.overrides?.chatMode ?? undefined,
      overrides: input.overrides,
      compaction: input.compaction,
    })
    const { settings, selectedAssistant } = resolved
    const mcpManager = resolved.mcpManager
    const requestMessages = input.requestMessages
    const targetModelIds =
      input.branchTarget?.branchId && input.modelId
        ? [input.modelId]
        : input.modelIds && input.modelIds.length > 0
          ? input.modelIds
          : [resolved.model.model.id]
    const conversationId = input.conversationId
    const requestParams = {
      deliveryMode:
        input.overrides?.stream === false
          ? ('buffered' as const)
          : ('incremental' as const),
      temperature:
        input.overrides?.temperature ?? resolved.model.model.temperature,
      top_p: input.overrides?.top_p ?? resolved.model.model.topP,
      max_tokens: resolved.model.model.maxOutputTokens,
      primaryRequestTimeoutMs:
        settings.continuationOptions.primaryRequestTimeoutMs,
      streamFallbackRecoveryEnabled:
        settings.continuationOptions.streamFallbackRecoveryEnabled,
    }
    const autoContextCompactionOptions =
      resolveAutoContextCompactionChatOptions(settings.chatOptions)
    const chatModeRuntime = enableAutoContextCompactionTool(
      resolved.chatModeRuntime,
      autoContextCompactionOptions.autoContextCompactionEnabled,
    )
    const buildAutoContextCompactionInput = (
      model: AgentRuntimeRunInput['model'],
    ): AgentRuntimeRunInput['autoContextCompaction'] =>
      autoContextCompactionOptions.autoContextCompactionEnabled
        ? {
            chatOptions: autoContextCompactionOptions,
            maxContextTokens: resolveEffectiveMaxContextTokens(model),
          }
        : undefined

    const fileScope = resolveConversationFileScope(
      workspaceAgentPolicyToRuntimeAccessPolicy(
        input.activeAgent.workspacePolicy,
        settings,
      ),
      input.workingDirectory,
    )
    const baseInput = {
      messages: input.messages,
      assistantId: selectedAssistant?.id,
      requestContextBuilder: resolved.requestContextBuilder,
      mcpManager,
      compaction: normalizeCompaction(input.compaction),
      apiType: resolved.provider?.apiType ?? null,
      reasoningLevel: input.reasoningLevel,
      allowedToolNames: chatModeRuntime.allowedToolNames,
      enableToolDisclosure: settings.mcp.enableToolDisclosure,
      toolPreferences: chatModeRuntime.toolPreferences,
      toolServerPreferences: chatModeRuntime.toolServerPreferences,
      toolCapabilityMode: chatModeRuntime.toolCapabilityMode,
      bypassToolApproval: chatModeRuntime.bypassToolApproval,
      blockedCommandPrefixes: settings.mcp.builtinToolOptions[
        TERMINAL_COMMAND_TOOL_NAME
      ]?.blockedPrefixes ?? [...DEFAULT_BLOCKED_PREFIXES],
      workspaceAccessPolicy: fileScope.workspaceAccessPolicy,
      allowedSkillPaths: resolved.allowedSkillPaths,
      requestParams,
      contextualInjections: [],
      geminiTools: {
        useWebSearch: input.overrides?.useWebSearch ?? false,
        useUrlContext: input.overrides?.useUrlContext ?? false,
      },
    }
    const agentService = this.options.getAgentService()

    return {
      sourceUserMessageId:
        input.branchTarget?.sourceUserMessageId ??
        [...(input.requestMessages ?? input.messages)]
          .reverse()
          .find((message) => message.role === 'user')?.id,
      execute: async ({ abortSignal }) => {
        if (
          input.branchTarget &&
          (requestMessages ?? input.messages).at(-1)?.role === 'user'
        ) {
          await agentService.run({
            conversationId,
            persistState: true,
            loopConfig: chatModeRuntime.loopConfig,
            input: {
              ...baseInput,
              messages: requestMessages ?? input.messages,
              requestMessages,
              providerClient: resolved.model.providerClient,
              model: resolved.model.model,
              conversationId,
              autoContextCompaction: buildAutoContextCompactionInput(
                resolved.model.model,
              ),
              branchId: input.branchTarget.branchId,
              sourceUserMessageId: input.branchTarget.sourceUserMessageId,
              branchLabel:
                input.branchTarget.branchLabel ??
                resolved.model.model.name ??
                resolved.model.model.model ??
                resolved.model.model.id,
              abortSignal,
            },
          })
          return
        }

        if (
          targetModelIds.length <= 1 ||
          (requestMessages ?? input.messages).at(-1)?.role !== 'user'
        ) {
          await agentService.run({
            conversationId,
            loopConfig: chatModeRuntime.loopConfig,
            input: {
              ...baseInput,
              requestMessages,
              providerClient: resolved.model.providerClient,
              model: resolved.model.model,
              conversationId,
              autoContextCompaction: buildAutoContextCompactionInput(
                resolved.model.model,
              ),
              abortSignal,
            },
          })
          return
        }

        await Promise.allSettled(
          targetModelIds.map(async (targetModelId) => {
            const branchResolved = this.resolveModelClient(
              settings,
              targetModelId,
            )
            const branchProvider = settings.providers.find(
              (provider) => provider.id === branchResolved.model.providerId,
            )
            const lastMessage = input.messages.at(-1)
            if (!lastMessage) {
              return
            }
            await agentService.run({
              conversationId,
              persistState: true,
              loopConfig: chatModeRuntime.loopConfig,
              input: {
                ...baseInput,
                requestMessages,
                providerClient: branchResolved.providerClient,
                model: branchResolved.model,
                apiType: branchProvider?.apiType ?? null,
                conversationId,
                autoContextCompaction: buildAutoContextCompactionInput(
                  branchResolved.model,
                ),
                branchId: `${lastMessage.id}:${branchResolved.model.id}`,
                sourceUserMessageId: lastMessage.id,
                branchLabel:
                  branchResolved.model.name?.trim() ||
                  branchResolved.model.model ||
                  branchResolved.model.id,
                abortSignal,
                requestParams: {
                  ...requestParams,
                  temperature:
                    input.overrides?.temperature ??
                    branchResolved.model.temperature,
                  top_p: input.overrides?.top_p ?? branchResolved.model.topP,
                  max_tokens: branchResolved.model.maxOutputTokens,
                },
              },
            })
          }),
        )
      },
    }
  }

  private async resolveSharedContext(input: {
    conversationId: string
    messages: ChatMessage[]
    modelId?: string
    activeAgent: EffectiveWorkspaceAgent
    chatMode?: string
    overrides?: ConversationOverrideSettings | null
    compaction?: ChatConversationCompactionLike | null
  }) {
    const settings = this.options.getSettings()
    const selectedAssistant = input.activeAgent
    const model = this.resolveModelClient(
      settings,
      input.modelId || selectedAssistant.modelId || settings.chatModelId,
    )
    const provider = settings.providers.find(
      (candidate) => candidate.id === model.model.providerId,
    )
    // Accept the legacy 'agent-full' value from external clients (matches
    // src/core/agent/agent-api.ts:308) — convert to agent + yoloEnabled so
    // every callsite uses the new orthogonal representation downstream.
    // master 的 ChatMode 收窄为 'ask' | 'agent'（'plan' 是 CLI 运行时专有），
    // 外部客户端传 'plan' 时显式失败而不是静默降级。
    const requestedMode =
      (input.chatMode as ChatMode | 'agent-full' | 'plan' | undefined) ?? 'ask'
    if (requestedMode === 'plan') {
      throw new Error('chat_mode_unsupported:plan')
    }
    if (
      (requestedMode === 'agent' || requestedMode === 'agent-full') &&
      selectedAssistant.agentModeAllowed === false
    ) {
      throw new Error('agent_mode_not_allowed')
    }
    const chatModeRuntime = resolveChatModeRuntime({
      mode: requestedMode === 'agent-full' ? 'agent' : requestedMode,
      yoloEnabled: requestedMode === 'agent-full',
      assistant: selectedAssistant,
      assistantEnabledToolNames:
        getEnabledAssistantToolNames(selectedAssistant),
    })
    const requestSettings = {
      ...settings,
      currentAssistantId: selectedAssistant.id,
    }
    const requestContextBuilder = new RequestContextBuilder(
      this.options.app,
      requestSettings,
      {
        includeSkills: true,
        systemPromptSnapshotStore: this.options
          .getAgentService()
          .getSystemPromptSnapshotStore(),
        getPromptSourceRevision: () =>
          this.options.getAgentService().getPromptSourceWatcher().getRevision(),
        promptSourcePathsCallback: (paths) =>
          this.options
            .getAgentService()
            .getPromptSourceWatcher()
            .setWatchedPaths(paths),
        memoryIndexRuntime: getMemoryIndexRuntimeHandle(
          this.options.app,
          () => requestSettings,
        ),
      },
    )
    const mcpManager = await this.options.getMcpManager()
    const allowedSkillPaths = await this.resolveAllowedSkillPaths(
      settings,
      selectedAssistant,
    )

    return {
      settings,
      selectedAssistant,
      model,
      provider,
      chatModeRuntime,
      requestContextBuilder,
      mcpManager,
      allowedSkillPaths,
    }
  }

  private resolveModelClient(settings: YoloSettings, requestedModelId: string) {
    try {
      return getChatModelClient({
        settings,
        modelId: requestedModelId,
      })
    } catch (error) {
      if (
        error instanceof LLMModelNotFoundException &&
        settings.chatModels.length > 0
      ) {
        return getChatModelClient({
          settings,
          modelId: settings.chatModels[0].id,
        })
      }
      throw error
    }
  }

  private async resolveAllowedSkillPaths(
    settings: YoloSettings,
    selectedAssistant: YoloSettings['assistants'][number] | null,
  ): Promise<string[]> {
    if (!selectedAssistant) {
      return []
    }
    const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
    const enabledSkillEntries = (
      await listLiteSkillEntries(this.options.app, {
        settings,
      })
    ).filter((skill) =>
      isSkillEnabledForAssistant({
        assistant: selectedAssistant,
        skillName: skill.name,
        disabledSkillNames,
      }),
    )
    return enabledSkillEntries.map((skill) => skill.path)
  }
}

function normalizeCompaction(
  compaction: ChatConversationCompactionLike | null | undefined,
): ChatConversationCompactionState {
  if (!compaction) {
    return []
  }
  return Array.isArray(compaction) ? [...compaction] : [compaction]
}
