type SessionCloseCode =
  | 'token_revoked'
  | 'session_expired'
  | 'agent_unavailable'

type AgentTemplateRecord = {
  id: string
}

type AgentTokenRecord = {
  id: string
  revokedAt?: number
}

type WorkspaceAgentRecord = {
  id: string
  templateId: string
  tokenRecordIds?: string[]
  tokenRecords?: AgentTokenRecord[]
  shareTokens?: AgentTokenRecord[]
}

type LifecycleSettings = {
  assistants?: AgentTemplateRecord[]
  workspaceAgents?: WorkspaceAgentRecord[]
  currentWorkspaceAgentId?: string
  currentAssistantId?: string
  quickAskAssistantId?: string
  [key: string]: unknown
}

type SessionScope = {
  kind?: string
  agentId?: string
  issuedForAgentId?: string
}

type SessionRow = {
  id: string
  tokenRecordId: string
  tokenScope?: SessionScope
  activeAgentId?: string
}

type SessionStoreLike = {
  revokeAgentSessions?: (
    agentId: string,
    code?: SessionCloseCode,
  ) => string[] | number | undefined
  closeAgentSessions?: (agentId: string) => number | undefined
  revokeTokenSessions?: (
    tokenRecordId: string,
    code?: SessionCloseCode,
  ) => string[] | number | undefined
  listSessions?: () => SessionRow[]
  delete?: (sessionId: string, code?: SessionCloseCode) => boolean
}

type AgentEventStoreLike = {
  listRunsByAgent: (agentInstanceId: string) => Array<{ runId: string }>
  deleteRunsByAgent: (agentInstanceId: string) => void
}

export type DeleteAgentResult = {
  revokedSessionIds: string[]
  revokedSessionCount: number
  orphanedConversationCount: number
  deletedRunCount: number
}

export type RevokeShareTokenResult = {
  revokedSessionIds: string[]
  revokedSessionCount: number
}

export class WebAgentLifecycleService {
  constructor(
    private readonly deps: {
      getSettings: () => LifecycleSettings
      saveSettings: (next: LifecycleSettings) => Promise<void>
      sessionStore: SessionStoreLike
      orphanConversations: (
        agentId: string,
        reason: 'agent_deleted' | 'template_deleted',
      ) => Promise<number>
      agentEventStore?: AgentEventStoreLike
      abortAgentRuns?: (agentId: string) => Promise<void>
    },
  ) {}

  async deleteAgent(agentId: string): Promise<DeleteAgentResult> {
    return this.deleteAgentWithReason(agentId, 'agent_deleted')
  }

  async revokeShareToken(
    agentId: string,
    tokenRecordId: string,
    revokedAt = Date.now(),
  ): Promise<RevokeShareTokenResult> {
    const settings = this.deps.getSettings()
    const nextSettings = cloneSettings(settings)
    let tokenFound = false

    nextSettings.workspaceAgents = (nextSettings.workspaceAgents ?? []).map(
      (agent) => {
        if (agent.id !== agentId) return agent

        const nextShareTokens = (agent.shareTokens ?? []).map((token) => {
          if (token.id !== tokenRecordId) return token
          tokenFound = true
          return token.revokedAt == null ? { ...token, revokedAt } : token
        })

        return {
          ...agent,
          shareTokens: nextShareTokens,
        }
      },
    )

    if (tokenFound) {
      await this.deps.saveSettings(nextSettings)
    }

    const revoked = this.revokeTokenSessions(tokenRecordId, 'token_revoked')
    return {
      revokedSessionIds: revoked.ids,
      revokedSessionCount: revoked.count,
    }
  }

  async deleteTemplate(templateId: string): Promise<void> {
    const settings = this.deps.getSettings()
    const agentIds = (settings.workspaceAgents ?? [])
      .filter((agent) => agent.templateId === templateId)
      .map((agent) => agent.id)

    for (const agentId of agentIds) {
      await this.deleteAgentWithReason(agentId, 'template_deleted')
    }

    const latest = this.deps.getSettings()
    const nextSettings = cloneSettings(latest)
    nextSettings.assistants = (nextSettings.assistants ?? []).filter(
      (template) => template.id !== templateId,
    )
    const fallbackTemplateId = nextSettings.assistants[0]?.id
    if (nextSettings.currentAssistantId === templateId) {
      nextSettings.currentAssistantId = fallbackTemplateId
    }
    if (nextSettings.quickAskAssistantId === templateId) {
      nextSettings.quickAskAssistantId = fallbackTemplateId
    }
    await this.deps.saveSettings(nextSettings)
  }

  private async deleteAgentWithReason(
    agentId: string,
    orphanReason: 'agent_deleted' | 'template_deleted',
  ): Promise<DeleteAgentResult> {
    const settings = this.deps.getSettings()
    const agent = (settings.workspaceAgents ?? []).find(
      (item) => item.id === agentId,
    )

    if (agent) {
      const nextSettings = cloneSettings(settings)
      nextSettings.workspaceAgents = (
        nextSettings.workspaceAgents ?? []
      ).filter((item) => item.id !== agentId)
      if (nextSettings.currentWorkspaceAgentId === agentId) {
        delete nextSettings.currentWorkspaceAgentId
      }
      await this.deps.saveSettings(nextSettings)
    }

    await this.deps.abortAgentRuns?.(agentId)

    const revoked = agent
      ? this.revokeAgentSessions(agent)
      : this.closeAgentSessionsForRetry(agentId)
    const orphanedConversationCount = await this.deps.orphanConversations(
      agentId,
      orphanReason,
    )
    const deletedRunCount = this.deleteAgentRuns(agentId)

    return {
      revokedSessionIds: revoked.ids,
      revokedSessionCount: revoked.count,
      orphanedConversationCount,
      deletedRunCount,
    }
  }

  private revokeAgentSessions(agent: WorkspaceAgentRecord): {
    ids: string[]
    count: number
  } {
    const revoked = new Set<string>()
    let count = 0

    const direct = this.deps.sessionStore.revokeAgentSessions?.(
      agent.id,
      'agent_unavailable',
    )
    count += collectRevokedSessions(direct, revoked)

    const closed = this.deps.sessionStore.closeAgentSessions?.(agent.id)
    count += collectRevokedSessions(closed, revoked)

    for (const tokenRecordId of collectTokenRecordIds(agent)) {
      const byToken = this.revokeTokenSessions(
        tokenRecordId,
        'agent_unavailable',
      )
      byToken.ids.forEach((sessionId) => revoked.add(sessionId))
      count += byToken.count
    }

    if (revoked.size === 0 && count === 0) {
      for (const session of this.deps.sessionStore.listSessions?.() ?? []) {
        if (!sessionMatchesAgent(session, agent.id)) continue
        this.deps.sessionStore.delete?.(session.id, 'agent_unavailable')
        revoked.add(session.id)
        count += 1
      }
    }

    return {
      ids: Array.from(revoked),
      count: count || revoked.size,
    }
  }

  private revokeTokenSessions(
    tokenRecordId: string,
    code: SessionCloseCode,
  ): { ids: string[]; count: number } {
    const revoked = new Set<string>()
    const result = this.deps.sessionStore.revokeTokenSessions?.(
      tokenRecordId,
      code,
    )
    const count = collectRevokedSessions(result, revoked)
    return {
      ids: Array.from(revoked),
      count: count || revoked.size,
    }
  }

  private closeAgentSessionsForRetry(agentId: string): {
    ids: string[]
    count: number
  } {
    const count = this.deps.sessionStore.closeAgentSessions?.(agentId) ?? 0
    return { ids: [], count }
  }

  private deleteAgentRuns(agentId: string): number {
    const store = this.deps.agentEventStore
    if (!store) return 0
    const deletedRunCount = store.listRunsByAgent(agentId).length
    store.deleteRunsByAgent(agentId)
    return deletedRunCount
  }
}

function collectTokenRecordIds(agent: WorkspaceAgentRecord): string[] {
  const ids = new Set<string>()
  for (const tokenRecordId of agent.tokenRecordIds ?? []) {
    if (tokenRecordId) ids.add(tokenRecordId)
  }
  for (const token of agent.tokenRecords ?? []) {
    if (token.id) ids.add(token.id)
  }
  for (const token of agent.shareTokens ?? []) {
    if (token.id) ids.add(token.id)
  }
  return Array.from(ids)
}

function collectRevokedSessions(
  result: string[] | number | undefined,
  revoked: Set<string>,
): number {
  if (Array.isArray(result)) {
    result.forEach((sessionId) => revoked.add(sessionId))
    return result.length
  }
  return result ?? 0
}

function sessionMatchesAgent(session: SessionRow, agentId: string): boolean {
  return (
    session.activeAgentId === agentId ||
    (session.tokenScope?.kind === 'agent' &&
      session.tokenScope.agentId === agentId) ||
    session.tokenScope?.issuedForAgentId === agentId
  )
}

function cloneSettings(settings: LifecycleSettings): LifecycleSettings {
  return {
    ...settings,
    assistants:
      settings.assistants == null ? undefined : [...settings.assistants],
    workspaceAgents:
      settings.workspaceAgents == null
        ? undefined
        : [...settings.workspaceAgents],
  }
}
