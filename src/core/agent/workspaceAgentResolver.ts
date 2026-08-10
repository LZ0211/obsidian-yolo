import type {
  WorkspaceAgent,
  YoloSettings,
} from '../../settings/schema/setting.types'
import type {
  Assistant,
  AssistantSkillOverridePreference,
  AssistantSkillPreference,
  AssistantToolOverridePreference,
  AssistantToolPreference,
  WorkspaceAccessPolicy,
} from '../../types/assistant.types'

/**
 * Workspace agent resolution (migrated from the local fork, simplified): a
 * workspace agent inherits an upstream Assistant template and overrides
 * selected behavior + a workspace home-directory policy. The upstream
 * assistant editor stays untouched — the merged view only exists here.
 */

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function getTemplateEnabledToolNames(
  template: Assistant,
): string[] {
  const prefs = template.toolPreferences ?? {}
  const includeBuiltinTools = template.includeBuiltinTools !== false
  return Object.entries(prefs)
    .filter(([, preference]) => preference.enabled)
    .map(([toolName]) => toolName)
    .filter(
      (toolName) => includeBuiltinTools || !toolName.startsWith('yolo_local__'),
    )
}

function clampToolPreferenceOverride(
  templatePreference: AssistantToolPreference | undefined,
  overridePreference: AssistantToolOverridePreference | undefined,
  enabled: boolean,
): AssistantToolPreference {
  if (!templatePreference) {
    return {
      ...(overridePreference?.approvalMode
        ? { approvalMode: overridePreference.approvalMode }
        : {}),
      ...(overridePreference?.disclosureMode
        ? { disclosureMode: overridePreference.disclosureMode }
        : {}),
      enabled,
    }
  }
  return {
    ...templatePreference,
    ...(overridePreference?.approvalMode
      ? { approvalMode: overridePreference.approvalMode }
      : {}),
    ...(overridePreference?.disclosureMode
      ? { disclosureMode: overridePreference.disclosureMode }
      : {}),
    enabled,
  }
}

function clampSkillPreferenceOverride(
  templatePreference: AssistantSkillPreference | undefined,
  overridePreference: AssistantSkillOverridePreference | undefined,
  enabled: boolean,
): AssistantSkillPreference {
  if (!templatePreference) {
    return {
      ...(overridePreference?.loadMode
        ? { loadMode: overridePreference.loadMode }
        : {}),
      enabled,
    }
  }
  return {
    ...templatePreference,
    ...(overridePreference?.loadMode
      ? { loadMode: overridePreference.loadMode }
      : {}),
    enabled,
  }
}

export function toWorkspaceAccessPolicy(
  agent: WorkspaceAgent,
): WorkspaceAccessPolicy {
  return {
    enabled: true,
    workspaceRoot: agent.workspacePolicy.workspaceRoot,
    readExtraIncludes: agent.workspacePolicy.readAllowlist,
    readExcludes: agent.workspacePolicy.readDenylist,
    writeExcludes: agent.workspacePolicy.writeDenylist,
  }
}

/**
 * Merge a workspace agent with its template into an effective Assistant.
 * Returns null when the template is missing or the agent is disabled.
 */
export function resolveWorkspaceAgentAssistant(
  agent: WorkspaceAgent,
  templates: readonly Assistant[],
): Assistant | null {
  if (agent.disabled) return null
  const template = templates.find((candidate) => candidate.id === agent.templateId)
  if (!template) return null
  const overrides = agent.behaviorOverrides ?? {}
  const agentModeAllowed = overrides.agentModeAllowed ?? true

  const templateEnabledToolNames = getTemplateEnabledToolNames(template)
  const templateToolSet = new Set(templateEnabledToolNames)
  const disabledSet = new Set(overrides.disabledToolNames ?? [])
  const enabledToolNames = templateEnabledToolNames.filter(
    (toolName) => !disabledSet.has(toolName),
  )
  const toolPreferences: Record<string, AssistantToolPreference> = {}
  for (const toolName of templateEnabledToolNames) {
    toolPreferences[toolName] = clampToolPreferenceOverride(
      template.toolPreferences?.[toolName],
      overrides.toolConfigOverrides?.[toolName],
      !disabledSet.has(toolName),
    )
  }
  for (const toolName of Object.keys(overrides.toolConfigOverrides ?? {})) {
    if (templateToolSet.has(toolName)) continue
    toolPreferences[toolName] = { enabled: false }
  }

  const templateEnabledSkills = unique(template.enabledSkills ?? [])
  const templateSkillSet = new Set(templateEnabledSkills)
  const disabledSkillSet = new Set(overrides.disabledSkillIds ?? [])
  const enabledSkills = templateEnabledSkills.filter(
    (skillName) => !disabledSkillSet.has(skillName),
  )
  const skillPreferences: Record<string, AssistantSkillPreference> = {}
  for (const skillName of templateEnabledSkills) {
    skillPreferences[skillName] = clampSkillPreferenceOverride(
      template.skillPreferences?.[skillName],
      overrides.skillConfigOverrides?.[skillName],
      !disabledSkillSet.has(skillName),
    )
  }
  for (const skillName of Object.keys(overrides.skillConfigOverrides ?? {})) {
    if (templateSkillSet.has(skillName)) continue
    skillPreferences[skillName] = { enabled: false }
  }

  return {
    ...template,
    id: agent.id,
    name: overrides.name ?? agent.name,
    description: template.description,
    systemPrompt:
      overrides.systemPromptOverride ??
      overrides.promptOverride ??
      template.systemPrompt ??
      '',
    enableTools:
      (template.enableTools ?? true) && enabledToolNames.length > 0,
    enabledToolNames,
    toolPreferences,
    enabledSkills,
    skillPreferences,
    workspaceAccessPolicy: toWorkspaceAccessPolicy(agent),
  }
}

/**
 * Unified agent list: upstream templates plus resolved workspace agents.
 * Downstream code that displays, selects, or looks up agents should use this.
 */
export function getUnifiedAgentList(settings: YoloSettings): Assistant[] {
  const templates = settings.assistants ?? []
  const agents = settings.workspaceAgents ?? []
  const merged: Assistant[] = [...templates]
  for (const agent of agents) {
    const resolved = resolveWorkspaceAgentAssistant(agent, templates)
    if (resolved) merged.push(resolved)
  }
  return merged
}

export function findUnifiedAgentById(
  settings: YoloSettings,
  assistantId: string,
): Assistant | undefined {
  return getUnifiedAgentList(settings).find(
    (assistant) => assistant.id === assistantId,
  )
}
