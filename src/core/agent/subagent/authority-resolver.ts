import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type {
  AssistantToolPreference,
  AssistantToolServerPreference,
  WorkspaceAccessPolicy,
} from '../../../types/assistant.types'
import type {
  SerializedChatAssistantMessage,
  SerializedChatMessage,
} from '../../../types/chat'
import type { ChatModel } from '../../../types/chat-model.types'
import type {
  LLMProvider,
  LLMProviderApiType,
} from '../../../types/provider.types'
import type { ReasoningLevel } from '../../../types/reasoning'
import { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'
import type { BaseLLMProvider } from '../../llm/base'
import { getLocalFileToolServerName } from '../../mcp/localFileToolNames'
import type { McpManager } from '../../mcp/mcpManager'
import { getToolName } from '../../mcp/tool-name-utils'
import { resolveConversationFileScope } from '../../workspace/conversationFileScope'
import {
  getAssistantToolPreferences,
  getEnabledAssistantToolNames,
} from '../tool-preferences'
import type { AgentRuntimeLoopConfig } from '../types'
import type { AgentRuntimeRunInput } from '../types'
import {
  findUnifiedAgentById,
  getUnifiedAgentList,
} from '../workspaceAgentResolver'
import { resolveAssistantWorkspaceAccessPolicy } from '../workspaceScope'

import { SUBAGENT_MAX_AUTO_ITERATIONS } from './constants'
import { DELEGATE_SUBAGENT_TOOL_SHORT_NAME } from './tool-name-utils'
import {
  type DelegatedAssistantProfile,
  resolveDelegatedAssistantProfile,
} from './delegated-assistant-profile'
import { resolveSubagentModelConfig } from './model-config'
import type { SubagentParentContext } from './parent-context'
import type {
  ResolvedSubagentRunPolicySnapshot,
  SubagentControlErrorCode,
  SubagentSession,
} from './session-types'
import { filterAllowedToolsForSubagent } from './tool-filter'

/** Narrow owning-conversation binding the resolver consumes at run time.
 * Master has no `ConversationProjection` (src/core/conversation/projection/)
 * — the chat metadata layer (ChatManager) only carries the assistant id, so
 * the owning conversation is loaded as this meta instead (migration brief
 * Task 3). Only `assistantId` / `conversationId` are consumed; model, tools
 * and workspace permissions come from the `SubagentParentContext` runtime
 * input and the re-resolved parent assistant. */
export type SubagentParentConversationMeta = {
  conversationId: string
  assistantId?: string
}

/**
 * Task 3 Important 投递加载域重建的输入：父会话消息时间线。authority 解析时
 * 校验 origin 上下文仍有效（origin 消息存在性 / delegate 工具调用归属 /
 * branch 匹配，backup loadOwningConversation 语义）。master 的聊天元数据层
 * 不携带消息时间线，由调用方（main.ts）经 ChatManager.findById 提供。
 */
export type SubagentParentConversationMessages = {
  conversationId: string
  assistantId?: string
  messages: readonly SerializedChatMessage[]
}

export type SubagentAuthorityResolverDependencies = {
  app: App
  getSettings: () => YoloSettings
  loadConversationMeta: (
    conversationId: string,
  ) =>
    | Promise<SubagentParentConversationMeta | null>
    | SubagentParentConversationMeta
    | null
  /**
   * Task 3 Important：可选。提供父会话消息时间线时，loadOwningConversationMeta
   * 额外校验 origin 消息存在性 / delegate 工具调用归属 / branch 匹配（backup
   * 语义）；缺失时仅做 conversationId 匹配的元数据级校验（旧行为）。
   */
  loadParentConversation?: (
    conversationId: string,
  ) =>
    | Promise<SubagentParentConversationMessages | null>
    | SubagentParentConversationMessages
    | null
  createProviderClient: (input: {
    settings: YoloSettings
    model: ChatModel
  }) => BaseLLMProvider<LLMProvider>
  createMcpManager: (input: {
    app: App
    settings: YoloSettings
  }) => Promise<McpManager> | McpManager
  now?: () => number
}

export type ResolvedCurrentSubagentParentAuthority = {
  conversation?: SubagentParentConversationMeta
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  apiType?: LLMProviderApiType | null
  mcpManager: McpManager
  requestContextBuilder: RequestContextBuilder
  workspaceAccessPolicy?: WorkspaceAccessPolicy
  delegatedProfile?: DelegatedAssistantProfile
  allowedToolNames: string[]
  toolPreferences?: Record<string, AssistantToolPreference>
  toolServerPreferences?: Record<string, AssistantToolServerPreference>
  allowedSkillPaths: string[]
  enableToolDisclosure?: boolean
  reasoningLevel?: ReasoningLevel
  requestParams?: AgentRuntimeRunInput['requestParams']
  blockedCommandPrefixes?: string[]
  loopConfig: AgentRuntimeLoopConfig
  bypassToolApproval: false
  rejectToolApproval: false
  temporaryApprovedToolNames: []
  auditSnapshot: ResolvedSubagentRunPolicySnapshot
}

export class SubagentAuthorityResolutionError extends Error {
  readonly accepted = false

  constructor(
    readonly errorCode: SubagentControlErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'SubagentAuthorityResolutionError'
  }
}

export async function resolveCurrentSubagentParentAuthority(
  deps: SubagentAuthorityResolverDependencies,
  session: Readonly<SubagentSession>,
  parent: SubagentParentContext,
): Promise<ResolvedCurrentSubagentParentAuthority> {
  const conversationMeta = await loadOwningConversationMeta(deps, session)
  const settings = deps.getSettings()

  try {
    const parentAssistantId = conversationMeta.assistantId
    const parentAssistant =
      parentAssistantId &&
      getUnifiedAgentList(settings).some(
        (assistant) => assistant.id === parentAssistantId,
      )
        ? findUnifiedAgentById(settings, parentAssistantId)
        : null
    if (!parentAssistant) {
      throw new Error('The conversation parent assistant is unavailable.')
    }
    // Projection replacement: backup derived the workspace ceiling from the
    // projection's working directory. Master has no projection — the parent
    // context's resolved policy root (which IS the conversation directory the
    // parent last ran under) stands in as the directory input, while the
    // CURRENT parent assistant policy is still re-applied fresh.
    const parentWorkspacePolicy = resolveConversationFileScope(
      resolveAssistantWorkspaceAccessPolicy(parentAssistant),
      parent.workspaceAccessPolicy?.workspaceRoot,
    ).workspaceAccessPolicy

    let delegatedProfile = session.delegatedRoleId
      ? await resolveDelegatedAssistantProfile({
          app: deps.app,
          settings,
          assistantId: session.delegatedRoleId,
          parentWorkspacePolicy,
          memoryAssistantIdOverride: session.memoryAssistantId,
          // R9: backup passed a `withRuntimeOverrides` wrapper over the parent
          // context builder; master's RequestContextBuilder has no such API and
          // the delegated profile builds its own standalone builder (see
          // delegated-assistant-profile.ts:76-97), so the parent context's own
          // builder is passed through (currently unused by the profile).
          parentRequestContextBuilder: parent.requestContextBuilder,
        })
      : undefined
    const modelConfig = resolveSubagentModelConfig(settings)
    const genericModelId =
      session.modelPreferenceId ?? modelConfig.preferredModelId
    if (
      !delegatedProfile &&
      !modelConfig.allowedModelIds.includes(genericModelId)
    ) {
      throw new Error('The selected generic subagent model is unavailable.')
    }
    const modelId = delegatedProfile?.modelId ?? genericModelId
    const model = settings.chatModels.find(
      (candidate) => candidate.id === modelId && candidate.enable !== false,
    )
    if (!model) {
      throw new Error('The selected subagent model is unavailable.')
    }

    const providerClient = deps.createProviderClient({ settings, model })
    const provider = settings.providers.find(
      (candidate) => candidate.id === model.providerId,
    )
    if (!provider) {
      throw new Error('The selected subagent provider is unavailable.')
    }
    const mcpManager = await deps.createMcpManager({ app: deps.app, settings })
    const availableToolNames = (
      await mcpManager.listAvailableTools({
        includeBuiltinTools: true,
        chatModelModalities: model.modalities,
      })
    ).map((tool) => tool.name)

    if (delegatedProfile) {
      delegatedProfile = {
        ...delegatedProfile,
        allowedToolNames: filterAllowedToolsForSubagent(
          delegatedProfile.allowedToolNames,
          availableToolNames,
        ),
      }
    }

    const allowedToolNames = delegatedProfile
      ? delegatedProfile.allowedToolNames
      : filterAllowedToolsForSubagent(
          parentAssistant?.enableTools === false
            ? []
            : getEnabledAssistantToolNames(parentAssistant),
          availableToolNames,
        )
    const allowedSkillPaths = delegatedProfile?.allowedSkillPaths ?? []
    const loopConfig = delegatedProfile?.loopConfig ?? {
      enableTools: parentAssistant?.enableTools !== false,
      includeBuiltinTools: parentAssistant?.includeBuiltinTools !== false,
      maxAutoIterations: SUBAGENT_MAX_AUTO_ITERATIONS,
    }
    // R9: backup derived this builder via `withRuntimeOverrides` (parent
    // assistant identity + frozen memory id + workspace policy + fixed
    // instructions). Master's RequestContextBuilder has no such API — build
    // per the agent-api.ts construction path instead
    // (`new RequestContextBuilder(app, {...settings, currentAssistantId}, ...)`,
    // same mapping as delegated-assistant-profile.ts:76-97). Master couples
    // the assistant identity and the memory identity in `currentAssistantId`;
    // the frozen memory id takes precedence so the child keeps reading the
    // parent's memory across config changes. Fixed instructions are carried by
    // the run input `systemPromptOverride` (runner.ts), not by the builder.
    const requestContextBuilder =
      delegatedProfile?.requestContextBuilder ??
      new RequestContextBuilder(
        deps.app,
        {
          ...settings,
          currentAssistantId: session.memoryAssistantId ?? parentAssistant.id,
        },
        {
          includeSkills: true,
        },
      )
    const auditSnapshot: ResolvedSubagentRunPolicySnapshot = {
      modelId: model.id,
      ...(delegatedProfile
        ? { delegatedRoleId: delegatedProfile.delegatedRole.id }
        : {}),
      allowedToolNames: [...allowedToolNames],
      allowedSkillPaths: [...allowedSkillPaths],
      toolApprovalMode: 'require_approval',
      resolvedAt: deps.now?.() ?? Date.now(),
    }

    return {
      conversation: conversationMeta,
      providerClient,
      model,
      apiType: provider.apiType ?? null,
      mcpManager,
      requestContextBuilder,
      workspaceAccessPolicy: parentWorkspacePolicy,
      delegatedProfile,
      allowedToolNames,
      toolPreferences:
        delegatedProfile?.toolPreferences ??
        getAssistantToolPreferences(parentAssistant),
      toolServerPreferences:
        delegatedProfile?.toolServerPreferences ??
        parentAssistant?.toolServerPreferences,
      allowedSkillPaths,
      enableToolDisclosure: settings.mcp.enableToolDisclosure,
      reasoningLevel: parent.reasoningLevel,
      loopConfig,
      bypassToolApproval: false,
      rejectToolApproval: false,
      temporaryApprovedToolNames: [],
      auditSnapshot,
    }
  } catch (error) {
    if (error instanceof SubagentAuthorityResolutionError) throw error
    throw new SubagentAuthorityResolutionError(
      'policy_unavailable',
      true,
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function loadOwningConversationMeta(
  deps: SubagentAuthorityResolverDependencies,
  session: Readonly<SubagentSession>,
): Promise<SubagentParentConversationMeta> {
  let conversationMeta: SubagentParentConversationMeta | null
  try {
    conversationMeta = await deps.loadConversationMeta(
      session.parentConversationId,
    )
  } catch {
    conversationMeta = null
  }
  if (
    !conversationMeta ||
    conversationMeta.conversationId !== session.parentConversationId
  ) {
    throw new SubagentAuthorityResolutionError(
      'parent_orphaned',
      false,
      'The owning conversation is unavailable.',
    )
  }
  // Task 3 Important（投递加载域重建）：提供消息时间线时校验 origin 上下文
  // 仍有效——origin 消息在父会话存在、delegate_subagent 工具调用归属匹配、
  // branch 匹配（backup loadOwningConversation 语义）。任一失效 → parent_orphaned，
  // 调用方（续跑）据 R13 同款语义把会话置 ORPHANED。
  if (deps.loadParentConversation) {
    await validateOriginContext(deps, session)
  }
  return conversationMeta
}

/**
 * Task 3 Important：origin 上下文校验（backup authority-resolver.ts:283-321
 * 的 loadOwningConversation 移植，master 用消息时间线替代投影 timelineIds）。
 * 父会话加载失败视为孤儿（与元数据层一致）；originAssistantMessageId 必须
 * 是父会话中的 assistant 消息，且其 toolCallRequests 含 originToolCallId 且
 * 工具名是 delegate_subagent（归属校验）；originBranchId 设置时须与 origin
 * 消息的 branchId 一致。
 */
async function validateOriginContext(
  deps: SubagentAuthorityResolverDependencies,
  session: Readonly<SubagentSession>,
): Promise<void> {
  const loadParentConversation = deps.loadParentConversation
  if (!loadParentConversation) return
  let conversation: SubagentParentConversationMessages | null
  try {
    conversation = await loadParentConversation(session.parentConversationId)
  } catch {
    conversation = null
  }
  if (
    !conversation ||
    conversation.conversationId !== session.parentConversationId
  ) {
    throw new SubagentAuthorityResolutionError(
      'parent_orphaned',
      false,
      'The owning conversation is unavailable.',
    )
  }
  const assistantMessage = conversation.messages.find(
    (message): message is SerializedChatAssistantMessage =>
      message.role === 'assistant' &&
      message.id === session.originAssistantMessageId,
  )
  const ownsToolCall = assistantMessage?.toolCallRequests?.some(
    (request) =>
      request.id === session.originToolCallId &&
      isDelegateSubagentToolName(request.name),
  )
  if (!ownsToolCall) {
    throw new SubagentAuthorityResolutionError(
      'parent_orphaned',
      false,
      'The owning delegate_subagent tool call is unavailable.',
    )
  }
  if (
    session.originBranchId !== undefined &&
    assistantMessage?.metadata?.branchId !== session.originBranchId
  ) {
    throw new SubagentAuthorityResolutionError(
      'parent_orphaned',
      false,
      'The owning conversation branch is unavailable.',
    )
  }
}

function isDelegateSubagentToolName(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value === DELEGATE_SUBAGENT_TOOL_SHORT_NAME ||
      value ===
        getToolName(
          getLocalFileToolServerName(),
          DELEGATE_SUBAGENT_TOOL_SHORT_NAME,
        ))
  )
}
