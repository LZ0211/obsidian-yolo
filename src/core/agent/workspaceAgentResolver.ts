import type {
  WorkspaceAgent,
  WorkspaceAgentBehaviorOverrides,
  YoloSettings,
} from '../../settings/schema/setting.types'
import type {
  Assistant,
  AssistantSkillOverridePreference,
  AssistantSkillPreference,
  AssistantToolApprovalMode,
  AssistantToolDisclosureMode,
  AssistantToolOverridePreference,
  AssistantToolPreference,
  WorkspaceAccessPolicy,
} from '../../types/assistant.types'

import { DEFAULT_ASSISTANT_ID, isDefaultAssistantId } from './default-assistant'
import {
  buildDefaultBuiltinCapabilityPreferences,
  getAssistantToolPreferences,
} from './tool-preferences'

/**
 * Workspace agent resolution (migrated from the local fork, simplified): a
 * workspace agent inherits an upstream Assistant template and overrides
 * selected behavior + a workspace home-directory policy. The upstream
 * assistant editor stays untouched — the merged view only exists here.
 */

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

const APPROVAL_MODE_RANK: Record<AssistantToolApprovalMode, number> = {
  full_access: 0,
  dangerous_only: 1,
  require_approval: 2,
}

const DISCLOSURE_MODE_RANK: Record<AssistantToolDisclosureMode, number> = {
  always: 0,
  on_demand: 1,
}

function narrowerValue<T extends string>(
  templateValue: T | undefined,
  overrideValue: T | undefined,
  rank: Record<T, number>,
): T | undefined {
  if (!templateValue) return overrideValue
  if (!overrideValue) return templateValue
  return rank[overrideValue] > rank[templateValue]
    ? overrideValue
    : templateValue
}

export function mergeBuiltinCapabilityPreferences(
  template: Pick<Assistant, 'builtinCapabilityPreferences'>,
  disabledCapabilityIds: readonly string[],
  configOverrides?: Record<string, AssistantToolOverridePreference>,
): Record<string, AssistantToolPreference> {
  const disabledSet = new Set(disabledCapabilityIds)
  const preferences = {
    ...buildDefaultBuiltinCapabilityPreferences(),
    ...(template.builtinCapabilityPreferences ?? {}),
  }

  return Object.fromEntries(
    Object.entries(preferences).map(([capabilityId, preference]) => {
      const override = configOverrides?.[capabilityId]
      return [
        capabilityId,
        {
          ...preference,
          enabled:
            (preference.enabled ?? false) && !disabledSet.has(capabilityId),
          approvalMode: narrowerValue(
            preference.approvalMode,
            override?.approvalMode,
            APPROVAL_MODE_RANK,
          ),
          disclosureMode: narrowerValue(
            preference.disclosureMode,
            override?.disclosureMode,
            DISCLOSURE_MODE_RANK,
          ),
        },
      ]
    }),
  )
}

export function getTemplateEnabledRemoteToolNames(
  template: Assistant,
): string[] {
  const prefs = getAssistantToolPreferences(template)
  return Object.entries(prefs)
    .filter(([, preference]) => preference.enabled)
    .map(([toolName]) => toolName)
    .filter((toolName) => !toolName.startsWith('yolo_local__'))
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
  const template = templates.find(
    (candidate) => candidate.id === agent.templateId,
  )
  if (!template) return null
  const overrides = agent.behaviorOverrides ?? {}

  const templateEnabledToolNames = getTemplateEnabledRemoteToolNames(template)
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

  const builtinCapabilityPreferences = mergeBuiltinCapabilityPreferences(
    template,
    overrides.disabledBuiltinCapabilityIds ?? [],
    overrides.builtinCapabilityConfigOverrides,
  )
  const hasEnabledBuiltinCapability =
    template.includeBuiltinTools !== false &&
    Object.values(builtinCapabilityPreferences).some(
      (preference) => preference.enabled,
    )

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
      (template.enableTools ?? true) &&
      (enabledToolNames.length > 0 || hasEnabledBuiltinCapability),
    enabledToolNames,
    toolPreferences,
    builtinCapabilityPreferences,
    enabledSkills,
    skillPreferences,
    workspaceAccessPolicy: toWorkspaceAccessPolicy(agent),
  }
}

export function buildWorkspaceAgentBehaviorOverrides(
  template: Assistant,
  effective: Assistant,
  agentModeAllowed: boolean,
): WorkspaceAgentBehaviorOverrides {
  const overrides: WorkspaceAgentBehaviorOverrides = {}

  if (effective.systemPrompt !== (template.systemPrompt ?? '')) {
    overrides.systemPromptOverride = effective.systemPrompt
  }

  const templateRemoteTools = getTemplateEnabledRemoteToolNames(template)
  const effectiveToolPreferences = getAssistantToolPreferences(effective)
  const disabledToolNames = templateRemoteTools.filter(
    (toolName) => effectiveToolPreferences[toolName]?.enabled === false,
  )
  if (disabledToolNames.length > 0) {
    overrides.disabledToolNames = disabledToolNames
  }

  const toolConfigOverrides: NonNullable<
    WorkspaceAgentBehaviorOverrides['toolConfigOverrides']
  > = {}
  const templateToolPreferences = getAssistantToolPreferences(template)
  for (const toolName of templateRemoteTools) {
    const templatePreference = templateToolPreferences[toolName]
    const effectivePreference = effectiveToolPreferences[toolName]
    const config: AssistantToolOverridePreference = {}
    if (
      effectivePreference?.approvalMode &&
      templatePreference?.approvalMode &&
      APPROVAL_MODE_RANK[effectivePreference.approvalMode] >
        APPROVAL_MODE_RANK[templatePreference.approvalMode]
    ) {
      config.approvalMode = effectivePreference.approvalMode
    }
    if (
      effectivePreference?.disclosureMode &&
      templatePreference?.disclosureMode &&
      DISCLOSURE_MODE_RANK[effectivePreference.disclosureMode] >
        DISCLOSURE_MODE_RANK[templatePreference.disclosureMode]
    ) {
      config.disclosureMode = effectivePreference.disclosureMode
    }
    if (Object.keys(config).length > 0) {
      toolConfigOverrides[toolName] = config
    }
  }
  if (Object.keys(toolConfigOverrides).length > 0) {
    overrides.toolConfigOverrides = toolConfigOverrides
  }

  const templateBuiltinPreferences = mergeBuiltinCapabilityPreferences(
    template,
    [],
  )
  const effectiveBuiltinPreferences =
    effective.builtinCapabilityPreferences ?? {}
  const disabledBuiltinCapabilityIds: string[] = []
  const builtinCapabilityConfigOverrides: NonNullable<
    WorkspaceAgentBehaviorOverrides['builtinCapabilityConfigOverrides']
  > = {}
  for (const [capabilityId, templatePreference] of Object.entries(
    templateBuiltinPreferences,
  )) {
    if (!templatePreference.enabled) continue
    const effectivePreference = effectiveBuiltinPreferences[capabilityId]
    if (effectivePreference?.enabled === false) {
      disabledBuiltinCapabilityIds.push(capabilityId)
      continue
    }
    if (
      effectivePreference?.approvalMode &&
      templatePreference.approvalMode &&
      APPROVAL_MODE_RANK[effectivePreference.approvalMode] >
        APPROVAL_MODE_RANK[templatePreference.approvalMode]
    ) {
      builtinCapabilityConfigOverrides[capabilityId] = {
        approvalMode: effectivePreference.approvalMode,
      }
    }
  }
  if (disabledBuiltinCapabilityIds.length > 0) {
    overrides.disabledBuiltinCapabilityIds = disabledBuiltinCapabilityIds
  }
  if (Object.keys(builtinCapabilityConfigOverrides).length > 0) {
    overrides.builtinCapabilityConfigOverrides =
      builtinCapabilityConfigOverrides
  }

  const templateSkills = unique(template.enabledSkills ?? [])
  const effectiveSkills = new Set(effective.enabledSkills ?? [])
  const disabledSkillIds = templateSkills.filter(
    (skillName) => !effectiveSkills.has(skillName),
  )
  if (disabledSkillIds.length > 0) {
    overrides.disabledSkillIds = disabledSkillIds
  }

  const skillConfigOverrides: NonNullable<
    WorkspaceAgentBehaviorOverrides['skillConfigOverrides']
  > = {}
  for (const skillName of templateSkills) {
    const templateMode = template.skillPreferences?.[skillName]?.loadMode
    const effectiveMode = effective.skillPreferences?.[skillName]?.loadMode
    if (templateMode === 'always' && effectiveMode === 'lazy') {
      skillConfigOverrides[skillName] = { loadMode: 'lazy' }
    }
  }
  if (Object.keys(skillConfigOverrides).length > 0) {
    overrides.skillConfigOverrides = skillConfigOverrides
  }

  if (!agentModeAllowed) {
    overrides.agentModeAllowed = false
  }

  return overrides
}

/**
 * Unified agent list: upstream templates plus resolved workspace agents.
 * Downstream code that displays, selects, or looks up agents should use this.
 *
 * A template covered by a workspace agent is hidden from the list (backup
 * semantics) so selectors show exactly one entry per runnable agent. The
 * default assistant template always stays in the list, even if a workspace
 * agent happens to reference it as its templateId — otherwise a stale or
 * orphaned workspace agent silently hides the default assistant from every
 * selector.
 */
export function getUnifiedAgentList(settings: YoloSettings): Assistant[] {
  const templates = settings.assistants ?? []
  const agents = (settings.workspaceAgents ?? []).filter((a) => !a.disabled)
  const covered = new Set(
    agents
      .filter((wa) => !isDefaultAssistantId(wa.templateId))
      .map((wa) => wa.templateId),
  )
  const merged: Assistant[] = templates
    .filter((tpl) => !covered.has(tpl.id))
    .map((tpl) => ({ ...tpl }))
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

/**
 * Resolve the active "Assistant" the chat should run with (backup
 * `resolveActiveAssistant` semantics). Workspace agents take priority; a
 * workspace agent whose template is missing (orphaned) or an id that matches
 * nothing falls back to the default assistant instead of resolving to null —
 * a null active assistant would silently run the chat without any workspace
 * boundary. Returns null only when no assistant template exists at all.
 */
export function resolveActiveAssistant(
  settings: YoloSettings,
  override?: { assistantId?: string },
): Assistant | null {
  const requestedId =
    override?.assistantId ?? settings.currentAssistantId ?? DEFAULT_ASSISTANT_ID

  // Workspace agents take priority — they're the "real" runnable entities.
  const workspaceAgent = (settings.workspaceAgents ?? []).find(
    (agent) => agent.id === requestedId,
  )
  if (workspaceAgent) {
    const resolved = resolveWorkspaceAgentAssistant(
      workspaceAgent,
      settings.assistants ?? [],
    )
    if (resolved) return resolved
    // No template → workspace agent is orphaned. Don't surface the template
    // as the active assistant — that would let the chat run a config the
    // workspace agent didn't intend. Fall back to default.
  }

  // Not a workspace agent id (or workspace agent was orphaned). Treat the id
  // as a direct assistant template selection.
  const assistants = settings.assistants ?? []
  const fallback =
    assistants.find((assistant) => assistant.id === requestedId) ??
    assistants.find((assistant) => isDefaultAssistantId(assistant.id)) ??
    assistants[0] ??
    null

  return fallback ?? null
}
