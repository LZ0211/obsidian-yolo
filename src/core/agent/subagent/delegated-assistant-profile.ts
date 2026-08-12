import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type {
  Assistant,
  AssistantToolPreference,
  AssistantToolServerPreference,
  WorkspaceAccessPolicy,
} from '../../../types/assistant.types'
import { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'
import { resolveAssistantSkillPaths } from '../../skills/assistantSkillPaths'
import {
  getAssistantToolPreferences,
  getEnabledAssistantToolNames,
} from '../tool-preferences'
import type { AgentRuntimeLoopConfig } from '../types'

import { SUBAGENT_MAX_AUTO_ITERATIONS } from './constants'
import {
  type DelegatableAssistantRole,
  resolveDelegatableAssistant,
} from './delegatable-assistant'
import { resolveSubagentModelConfig } from './model-config'
import { filterAllowedToolsForSubagent } from './tool-filter'

export type DelegatedAssistantProfile = {
  assistant: Assistant
  delegatedRole: Readonly<DelegatableAssistantRole>
  modelId: string
  allowedToolNames: string[]
  toolPreferences: Record<string, AssistantToolPreference>
  toolServerPreferences?: Record<string, AssistantToolServerPreference>
  allowedSkillPaths: string[]
  workspaceAccessPolicy?: WorkspaceAccessPolicy
  loopConfig: AgentRuntimeLoopConfig
  requestContextBuilder: RequestContextBuilder
}

export async function resolveDelegatedAssistantProfile({
  app,
  settings,
  assistantId,
  parentWorkspacePolicy,
  memoryAssistantIdOverride,
  availableToolNames,
  parentRequestContextBuilder: _parentRequestContextBuilder,
}: {
  app: App
  settings: YoloSettings
  assistantId: string
  parentWorkspacePolicy: WorkspaceAccessPolicy | undefined
  memoryAssistantIdOverride?: string
  availableToolNames?: readonly string[]
  parentRequestContextBuilder: RequestContextBuilder
}): Promise<DelegatedAssistantProfile> {
  const assistant = resolveDelegatableAssistant(settings, assistantId)
  const modelId = resolveDelegatedModelId(settings, assistant)
  const enableTools = assistant.enableTools !== false
  const allowedToolNames = enableTools
    ? filterAllowedToolsForSubagent(
        getEnabledAssistantToolNames(assistant),
        availableToolNames,
      )
    : []
  const toolPreferences = getAssistantToolPreferences(assistant)
  const allowedSkillPaths = await resolveAssistantSkillPaths({
    app,
    settings,
    assistant,
  })
  const loopConfig: AgentRuntimeLoopConfig = {
    enableTools,
    includeBuiltinTools: enableTools && assistant.includeBuiltinTools !== false,
    maxAutoIterations: SUBAGENT_MAX_AUTO_ITERATIONS,
  }
  // R9: master's RequestContextBuilder has no `withRuntimeOverrides` — derive
  // an equivalent instance via the agent-api.ts construction path instead: a
  // fresh builder whose settings clone points at the delegated assistant.
  // `memoryAssistantIdOverride` (frozen parent memory identity) takes
  // precedence so the child can keep reading the parent's memory; otherwise
  // the context belongs to the delegated role itself. The parent builder
  // carries no master-visible derivation API, so the child context is built
  // standalone (fresh snapshot store => no parent conversation state leaks).
  const requestContextBuilder = new RequestContextBuilder(
    app,
    {
      ...settings,
      currentAssistantId: memoryAssistantIdOverride ?? assistant.id,
    },
    {
      includeSkills: true,
    },
  )

  return {
    assistant,
    delegatedRole: Object.freeze({
      id: assistant.id,
      name: assistant.name,
    }),
    modelId,
    allowedToolNames,
    toolPreferences,
    toolServerPreferences: assistant.toolServerPreferences,
    allowedSkillPaths,
    workspaceAccessPolicy: parentWorkspacePolicy,
    loopConfig,
    requestContextBuilder,
  }
}

function resolveDelegatedModelId(
  settings: YoloSettings,
  assistant: Assistant,
): string {
  const explicitModelId = assistant.modelId?.trim()
  if (explicitModelId) {
    const explicitModel = settings.chatModels.find(
      (model) => model.id === explicitModelId,
    )
    if (!explicitModel) {
      throw new Error(
        `Assistant role "${assistant.id}" selects chat model "${explicitModelId}", but it is not registered. Choose a registered model for this role.`,
      )
    }
    if (explicitModel.enable === false) {
      throw new Error(
        `Assistant role "${assistant.id}" selects chat model "${explicitModelId}", but that model is disabled. Enable it or choose another model for this role.`,
      )
    }
    return explicitModel.id
  }

  const preferredModelId = resolveSubagentModelConfig(settings).preferredModelId
  if (!preferredModelId) {
    throw new Error(
      `Assistant role "${assistant.id}" has no model, and no preferred delegate_subagent model is configured. Configure a preferred model or select one for this role.`,
    )
  }

  const preferredModel = settings.chatModels.find(
    (model) => model.id === preferredModelId,
  )
  if (!preferredModel) {
    throw new Error(
      `Preferred delegate_subagent chat model "${preferredModelId}" is not registered. Configure a registered preferred model.`,
    )
  }
  if (preferredModel.enable === false) {
    throw new Error(
      `Preferred delegate_subagent chat model "${preferredModelId}" is disabled. Enable it or configure another preferred model.`,
    )
  }

  return preferredModel.id
}
