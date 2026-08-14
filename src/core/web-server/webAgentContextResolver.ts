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
} from '../../types/assistant.types'
import { getEnabledAssistantToolNames } from '../agent/tool-preferences'
import { getUnifiedAgentList } from '../agent/workspaceAgentResolver'

import { hashWorkspaceRoot, normalizeVaultRootPath } from './shareTokenCrypto'
import type {
  EffectiveWorkspaceAgent,
  PublicWorkspaceAgentSummary,
  ResolveWebAgentContextResult,
  WebSession,
} from './webAgentTypes'

type EffectiveAgentResult =
  | {
      ok: true
      agent: EffectiveWorkspaceAgent
    }
  | {
      ok: false
      code: 'agent_unavailable'
      message: string
    }

const normalizeWorkspaceRoot = (input: string): string => {
  if (input.trim().length === 0) {
    throw new Error('Workspace root cannot be blank.')
  }
  return normalizeVaultRootPath(input)
}

const tryNormalizeWorkspaceRoot = (workspaceRoot: string): string | null => {
  try {
    return normalizeWorkspaceRoot(workspaceRoot)
  } catch {
    return null
  }
}

const tryHashWorkspaceRoot = (
  workspaceRoot: string,
  vaultIdentity: string,
): string | null => {
  try {
    return hashWorkspaceRoot(workspaceRoot, vaultIdentity)
  } catch {
    return null
  }
}

const unique = <T>(items: T[]): T[] => [...new Set(items)]

const clampToolPreferenceOverride = (
  templatePreference: AssistantToolPreference | undefined,
  overridePreference: AssistantToolOverridePreference | undefined,
  enabled: boolean,
): AssistantToolPreference => {
  const basePreference = templatePreference ?? {}
  const nextPreference: AssistantToolPreference = {
    ...basePreference,
    enabled,
  }

  if (!overridePreference) {
    return nextPreference
  }

  if (
    basePreference.approvalMode === 'full_access' &&
    overridePreference.approvalMode === 'require_approval'
  ) {
    nextPreference.approvalMode = 'require_approval'
  }

  if (
    basePreference.disclosureMode === 'always' &&
    overridePreference.disclosureMode === 'on_demand'
  ) {
    nextPreference.disclosureMode = 'on_demand'
  }

  return nextPreference
}

const clampSkillPreferenceOverride = (
  templatePreference: AssistantSkillPreference | undefined,
  overridePreference: AssistantSkillOverridePreference | undefined,
  enabled: boolean,
): AssistantSkillPreference => {
  const nextPreference: AssistantSkillPreference = {
    ...(templatePreference ?? {}),
    enabled,
  }

  if (
    templatePreference?.loadMode === 'always' &&
    overridePreference?.loadMode === 'lazy'
  ) {
    nextPreference.loadMode = 'lazy'
  }

  return nextPreference
}

const buildToolPreferences = (
  template: Assistant,
  disabledToolNames: string[],
  toolConfigOverrides?: Record<string, AssistantToolOverridePreference>,
): {
  enableTools: boolean
  includeBuiltinTools: boolean
  enabledToolNames: string[]
  toolPreferences: Record<string, AssistantToolPreference>
  toolServerPreferences: Assistant['toolServerPreferences']
} => {
  const templateEnabledToolNames = getEnabledAssistantToolNames(template)
  const templateToolSet = new Set(templateEnabledToolNames)
  const disabledSet = new Set(disabledToolNames)
  const enabledToolNames = templateEnabledToolNames.filter(
    (toolName) => !disabledSet.has(toolName),
  )

  const toolPreferences: Record<string, AssistantToolPreference> = {}
  for (const toolName of templateEnabledToolNames) {
    toolPreferences[toolName] = clampToolPreferenceOverride(
      template.toolPreferences?.[toolName],
      toolConfigOverrides?.[toolName],
      !disabledSet.has(toolName),
    )
  }

  for (const [toolName] of Object.entries(toolConfigOverrides ?? {})) {
    if (templateToolSet.has(toolName)) {
      continue
    }
    toolPreferences[toolName] = {
      enabled: false,
    }
  }

  return {
    enableTools: (template.enableTools ?? true) && enabledToolNames.length > 0,
    includeBuiltinTools: template.includeBuiltinTools ?? true,
    enabledToolNames,
    toolPreferences,
    toolServerPreferences: template.toolServerPreferences ?? {},
  }
}

const buildSkillPreferences = (
  template: Assistant,
  disabledSkillIds: string[],
  skillConfigOverrides?: Record<string, AssistantSkillOverridePreference>,
): {
  enabledSkills: string[]
  skillPreferences: Record<string, AssistantSkillPreference>
} => {
  const templateEnabledSkills = unique(template.enabledSkills ?? [])
  const templateSkillSet = new Set(templateEnabledSkills)
  const disabledSet = new Set(disabledSkillIds)
  const enabledSkills = templateEnabledSkills.filter(
    (skillName) => !disabledSet.has(skillName),
  )
  const skillPreferences: Record<string, AssistantSkillPreference> = {}

  for (const skillName of templateEnabledSkills) {
    skillPreferences[skillName] = clampSkillPreferenceOverride(
      template.skillPreferences?.[skillName],
      skillConfigOverrides?.[skillName],
      !disabledSet.has(skillName),
    )
  }

  for (const [skillName] of Object.entries(skillConfigOverrides ?? {})) {
    if (templateSkillSet.has(skillName)) {
      continue
    }
    skillPreferences[skillName] = {
      enabled: false,
    }
  }

  return {
    enabledSkills,
    skillPreferences,
  }
}

const authorizeAgentForSession = (
  session: WebSession,
  agent: WorkspaceAgent,
  vaultIdentity: string,
):
  | { ok: true; rootHash: string; normalizedWorkspaceRoot: string }
  | { ok: false; code: 'invalid_root' | 'forbidden'; message: string } => {
  const normalizedWorkspaceRoot = tryNormalizeWorkspaceRoot(
    agent.workspacePolicy.workspaceRoot,
  )
  if (!normalizedWorkspaceRoot) {
    return {
      ok: false,
      code: 'invalid_root',
      message: `Workspace Agent ${agent.id} has an invalid workspace root.`,
    }
  }

  const agentRootHash = hashWorkspaceRoot(
    normalizedWorkspaceRoot,
    vaultIdentity,
  )

  if (session.tokenScope.kind === 'agent') {
    if (session.tokenScope.agentId !== agent.id) {
      return {
        ok: false,
        code: 'forbidden',
        message:
          'The current session token scope does not authorize the active Agent.',
      }
    }
    return {
      ok: true,
      rootHash: agentRootHash,
      normalizedWorkspaceRoot,
    }
  }

  if (
    agentRootHash !== session.rootHash ||
    agentRootHash !== session.tokenScope.rootHash
  ) {
    return {
      ok: false,
      code: 'forbidden',
      message:
        'The current session token scope does not authorize the active Agent workspace root.',
    }
  }

  return {
    ok: true,
    rootHash: agentRootHash,
    normalizedWorkspaceRoot,
  }
}

export function resolveEffectiveAgent(
  agent: WorkspaceAgent,
  template: Assistant,
): EffectiveAgentResult {
  if (agent.templateId !== template.id) {
    return {
      ok: false,
      code: 'agent_unavailable',
      message: `Workspace Agent ${agent.id} references template ${agent.templateId}, but ${template.id} was provided.`,
    }
  }

  const behaviorOverrides = agent.behaviorOverrides ?? {}
  const agentModeAllowed = behaviorOverrides.agentModeAllowed ?? true

  const toolState = buildToolPreferences(
    template,
    behaviorOverrides.disabledToolNames ?? [],
    behaviorOverrides.toolConfigOverrides,
  )
  const skillState = buildSkillPreferences(
    template,
    behaviorOverrides.disabledSkillIds ?? [],
    behaviorOverrides.skillConfigOverrides,
  )

  return {
    ok: true,
    agent: {
      ...agent,
      name: behaviorOverrides.name ?? agent.name ?? template.name,
      description: template.description,
      systemPrompt:
        behaviorOverrides.systemPromptOverride ??
        behaviorOverrides.promptOverride ??
        template.systemPrompt ??
        '',
      modelId: template.modelId,
      persona: template.persona,
      enableProjectInstructions: template.enableProjectInstructions,
      includeCurrentFileContent: template.includeCurrentFileContent,
      timeContextEnabled: template.timeContextEnabled,
      ...toolState,
      ...skillState,
      agentModeAllowed,
    },
  }
}

export function createWebAgentContextResolver(input: {
  getSettings: () => YoloSettings
  getSession: (sessionId: string | null | undefined) => WebSession | null
  vaultIdentity: string
}): {
  resolve(request: { sessionId?: string | null }): ResolveWebAgentContextResult
  canSwitch(
    session: WebSession,
    targetAgentId: string,
  ): ResolveWebAgentContextResult
} {
  const buildContext = (
    session: WebSession,
    activeAgentId: string,
  ): ResolveWebAgentContextResult => {
    const settings = input.getSettings()
    const agent = settings.workspaceAgents.find(
      (candidate) => candidate.id === activeAgentId,
    )
    if (!agent) {
      // A token-scoped web session must never activate a standalone template:
      // templates carry no workspace policy, so they would escape the token
      // scope and reach the whole vault.
      const tpl = (settings.assistants ?? []).find(
        (c) => c.id === activeAgentId,
      )
      if (tpl) {
        return {
          ok: false,
          code: 'forbidden',
          message:
            'Templates are not available in shared web sessions. Only workspace agents can be activated.',
        }
      }
      return {
        ok: false,
        code: 'agent_unavailable',
        message: `Agent ${activeAgentId} is unavailable.`,
      }
    }
    if (agent.disabled) {
      return {
        ok: false,
        code: 'agent_unavailable',
        message: `Workspace Agent ${activeAgentId} is disabled.`,
      }
    }

    const authorization = authorizeAgentForSession(
      session,
      agent,
      input.vaultIdentity,
    )
    if (!authorization.ok) {
      if (authorization.code === 'invalid_root') {
        return {
          ok: false,
          code: 'agent_unavailable',
          message: authorization.message,
        }
      }

      return {
        ok: false,
        code: 'forbidden',
        message: authorization.message,
      }
    }

    const template = settings.assistants.find(
      (candidate) => candidate.id === agent.templateId,
    )
    if (!template) {
      return {
        ok: false,
        code: 'agent_unavailable',
        message: `Template ${agent.templateId} for Workspace Agent ${agent.id} is unavailable.`,
      }
    }

    const effective = resolveEffectiveAgent(agent, template)
    if (!effective.ok) {
      return effective
    }

    const activeRootHash = authorization.rootHash
    const allowedAgents = buildAllowedAgents(
      settings,
      session,
      input.vaultIdentity,
      activeRootHash,
    )

    return {
      ok: true,
      context: {
        sessionId: session.id,
        tokenScope: session.tokenScope,
        activeAgent: effective.agent,
        template,
        rootHash: activeRootHash,
        allowedAgents,
      },
    }
  }

  function buildAllowedAgents(
    settings: ReturnType<typeof input.getSettings>,
    session: WebSession,
    vaultIdentity: string,
    scopeRootHash: string,
  ): PublicWorkspaceAgentSummary[] {
    const unified = getUnifiedAgentList(settings)
    return (settings.workspaceAgents ?? [])
      .filter((agent) => {
        if (agent.disabled) {
          return false
        }
        if (session.tokenScope.kind === 'agent') {
          return agent.id === session.tokenScope.agentId
        }
        const hash = tryHashWorkspaceRoot(
          agent.workspacePolicy.workspaceRoot,
          vaultIdentity,
        )
        return hash === scopeRootHash
      })
      .map((agent) => {
        const resolved = unified.find((candidate) => candidate.id === agent.id)
        if (!resolved) {
          return null
        }
        const template = settings.assistants.find(
          (candidate) => candidate.id === agent.templateId,
        )
        const effective = template
          ? resolveEffectiveAgent(agent, template)
          : undefined
        return {
          id: agent.id,
          name: resolved.name ?? agent.name,
          agentModeAllowed:
            effective?.ok === true ? effective.agent.agentModeAllowed : true,
        }
      })
      .filter((agent): agent is PublicWorkspaceAgentSummary => agent != null)
  }

  return {
    resolve(request) {
      const session = input.getSession(request.sessionId)
      if (!session) {
        return {
          ok: false,
          code: 'unauthenticated',
          message: 'No authenticated web session was found.',
        }
      }

      return buildContext(session, session.activeAgentId)
    },
    canSwitch(session, targetAgentId) {
      if (session.tokenScope.kind === 'agent') {
        if (session.tokenScope.agentId !== targetAgentId) {
          return {
            ok: false,
            code: 'forbidden',
            message:
              'The current token scope does not permit switching to another Agent.',
          }
        }
        return buildContext(session, targetAgentId)
      }

      const settings = input.getSettings()
      const targetAgent = settings.workspaceAgents.find(
        (candidate) => candidate.id === targetAgentId,
      )
      if (!targetAgent) {
        return {
          ok: false,
          code: 'forbidden',
          message:
            'Templates are not available in shared web sessions. Only workspace agents can be activated.',
        }
      }
      if (targetAgent.disabled) {
        return {
          ok: false,
          code: 'agent_unavailable',
          message: `Workspace Agent ${targetAgentId} is disabled.`,
        }
      }

      const targetRootHash = tryHashWorkspaceRoot(
        targetAgent.workspacePolicy.workspaceRoot,
        input.vaultIdentity,
      )
      if (!targetRootHash) {
        return {
          ok: false,
          code: 'agent_unavailable',
          message: `Workspace Agent ${targetAgentId} has an invalid workspace root.`,
        }
      }
      if (targetRootHash !== session.rootHash) {
        return {
          ok: false,
          code: 'forbidden',
          message:
            'The requested Agent is outside the current workspace-root token scope.',
        }
      }

      return buildContext(session, targetAgentId)
    },
  }
}
