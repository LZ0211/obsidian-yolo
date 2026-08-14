import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'

export type AgentShareTokenScope =
  | { kind: 'agent'; agentId: string }
  | { kind: 'workspaceRoot'; rootHash: string; issuedForAgentId: string }

export type WebSessionClosedCode =
  | 'token_revoked'
  | 'session_expired'
  | 'agent_unavailable'

export type WebSessionClosedEvent = {
  sessionId: string
  code: WebSessionClosedCode
}

export type WebSession = {
  id: string
  tokenRecordId: string
  tokenScope: AgentShareTokenScope
  activeAgentId: string
  rootHash: string
  createdAt: number
  lastSeenAt: number
  idleTimeoutMs: number
  absoluteExpiresAt: number
}

export type CreateWebSessionInput = {
  tokenRecordId: string
  tokenScope: AgentShareTokenScope
  activeAgentId: string
  rootHash: string
  idleTimeoutMs: number
  absoluteTimeoutMs: number
}

export type WebSessionStoreOptions = {
  now?: () => number
}

type SessionClosedListener = (event: WebSessionClosedEvent) => void

const getCrypto = () =>
  loadDesktopNodeModuleSync<typeof import('node:crypto')>('node:crypto')

/** F4：定期清理过期会话的间隔。 */
const SESSION_SWEEP_INTERVAL_MS = 60_000

export class WebSessionStore {
  private readonly now: () => number
  private readonly sessions = new Map<string, WebSession>()
  private readonly sessionsByTokenRecordId = new Map<string, Set<string>>()
  private readonly closedListeners = new Set<SessionClosedListener>()
  private readonly sweepTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(options: WebSessionStoreOptions = {}) {
    this.now = options.now ?? Date.now
    // F4：sweepExpired 此前零调用，过期会话只在被 resolve 时惰性清理——
    // 定期清扫确保 idle/absolute 过期的会话关闭（closeSession 幂等）。
    if (typeof setInterval === 'function') {
      const timer = setInterval(() => {
        if (this.disposed) return
        this.sweepExpired()
      }, SESSION_SWEEP_INTERVAL_MS)
      if (typeof (timer as { unref?: unknown }).unref === 'function') {
        ;(timer as { unref: () => void }).unref()
      }
      this.sweepTimer = timer
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.sweepTimer != null) {
      clearInterval(this.sweepTimer)
    }
  }

  create(input: CreateWebSessionInput): WebSession {
    const now = this.now()
    const session: WebSession = {
      id: getCrypto().randomBytes(32).toString('base64url'),
      tokenRecordId: input.tokenRecordId,
      tokenScope: cloneTokenScope(input.tokenScope),
      activeAgentId: input.activeAgentId,
      rootHash: input.rootHash,
      createdAt: now,
      lastSeenAt: now,
      idleTimeoutMs: input.idleTimeoutMs,
      absoluteExpiresAt: now + input.absoluteTimeoutMs,
    }

    this.sessions.set(session.id, session)
    this.indexSession(session)
    return this.cloneSession(session)
  }

  resolve(sessionId: string): WebSession | null {
    const session = this.getActiveSession(sessionId)
    return session ? this.cloneSession(session) : null
  }

  switchActiveAgent(
    sessionId: string,
    activeAgentId: string,
  ): WebSession | null {
    const session = this.getActiveSession(sessionId)
    if (!session) return null

    session.activeAgentId = activeAgentId
    return this.cloneSession(session)
  }

  revokeTokenSessions(tokenRecordId: string): number {
    const sessionIds = [
      ...(this.sessionsByTokenRecordId.get(tokenRecordId) ?? new Set<string>()),
    ]

    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId)
      if (session) this.closeSession(session, 'token_revoked')
    }

    return sessionIds.length
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    this.closeSession(session, 'session_expired')
    return true
  }

  closeAgentSessions(agentId: string): number {
    const sessions = [...this.sessions.values()].filter((session) =>
      this.referencesAgent(session, agentId),
    )

    for (const session of sessions) {
      this.closeSession(session, 'agent_unavailable')
    }

    return sessions.length
  }

  sweepExpired(): number {
    const expired = [...this.sessions.values()].filter((session) =>
      this.isExpired(session),
    )

    for (const session of expired) {
      this.closeSession(session, 'session_expired')
    }

    return expired.length
  }

  onSessionClosed(listener: SessionClosedListener): () => void {
    this.closedListeners.add(listener)
    return () => {
      this.closedListeners.delete(listener)
    }
  }

  private indexSession(session: WebSession): void {
    let tokenSessions = this.sessionsByTokenRecordId.get(session.tokenRecordId)
    if (!tokenSessions) {
      tokenSessions = new Set<string>()
      this.sessionsByTokenRecordId.set(session.tokenRecordId, tokenSessions)
    }
    tokenSessions.add(session.id)
  }

  private closeSession(session: WebSession, code: WebSessionClosedCode): void {
    if (!this.sessions.delete(session.id)) return

    const tokenSessions = this.sessionsByTokenRecordId.get(
      session.tokenRecordId,
    )
    tokenSessions?.delete(session.id)
    if (tokenSessions?.size === 0) {
      this.sessionsByTokenRecordId.delete(session.tokenRecordId)
    }

    for (const listener of this.closedListeners) {
      listener({ sessionId: session.id, code })
    }
  }

  private isExpired(session: WebSession): boolean {
    const now = this.now()
    return (
      now >= session.absoluteExpiresAt ||
      now - session.lastSeenAt >= session.idleTimeoutMs
    )
  }

  private referencesAgent(session: WebSession, agentId: string): boolean {
    if (session.activeAgentId === agentId) return true
    if (session.tokenScope.kind === 'agent') {
      return session.tokenScope.agentId === agentId
    }
    return session.tokenScope.issuedForAgentId === agentId
  }

  private getActiveSession(sessionId: string): WebSession | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    if (this.isExpired(session)) {
      this.closeSession(session, 'session_expired')
      return null
    }

    session.lastSeenAt = this.now()
    return session
  }

  private cloneSession(session: WebSession): WebSession {
    return {
      ...session,
      tokenScope: cloneTokenScope(session.tokenScope),
    }
  }
}

function cloneTokenScope(
  tokenScope: AgentShareTokenScope,
): AgentShareTokenScope {
  return tokenScope.kind === 'agent' ? { ...tokenScope } : { ...tokenScope }
}
