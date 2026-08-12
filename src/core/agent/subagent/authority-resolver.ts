import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type {
  AssistantToolPreference,
  AssistantToolServerPreference,
  WorkspaceAccessPolicy,
} from '../../../types/assistant.types'
import type { ChatModel } from '../../../types/chat-model.types'
import type {
  LLMProvider,
  LLMProviderApiType,
} from '../../../types/provider.types'
import type { ReasoningLevel } from '../../../types/reasoning'
import { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'
import type { BaseLLMProvider } from '../../llm/base'
import type { McpManager } from '../../mcp/mcpManager'
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

export type SubagentAuthorityResolverDependencies = {
  app: App
  getSettings: () => YoloSettings
  loadConversationMeta: (
    conversationId: string,
  ) =>
    | Promise<SubagentParentConversationMeta | null>
    | SubagentParentConversationMeta
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
  return conversationMeta
}
