import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { WebSessionStore } from './webSessionStore'

describe('WebSessionStore', () => {
  it('defers Node crypto loading until a desktop session is created', () => {
    const source = readFileSync(
      path.join(__dirname, 'webSessionStore.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:crypto'/)
    expect(source).toContain('loadDesktopNodeModuleSync')
  })

  it('creates high entropy sessions and resolves active sessions', () => {
    const store = new WebSessionStore({ now: () => 1000 })
    const session = store.create({
      tokenRecordId: 'token-1',
      tokenScope: { kind: 'agent', agentId: 'agent-1' },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })

    expect(Buffer.from(session.id, 'base64url')).toHaveLength(32)
    expect(store.resolve(session.id)?.activeAgentId).toBe('agent-1')
  })

  it('switches active agents without changing token scope or root hash', () => {
    const store = new WebSessionStore({ now: () => 1000 })
    const session = store.create({
      tokenRecordId: 'token-1',
      tokenScope: {
        kind: 'workspaceRoot',
        rootHash: 'root-1',
        issuedForAgentId: 'agent-1',
      },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })

    expect(store.switchActiveAgent(session.id, 'agent-2')?.activeAgentId).toBe(
      'agent-2',
    )
    expect(store.resolve(session.id)?.tokenScope).toEqual({
      kind: 'workspaceRoot',
      rootHash: 'root-1',
      issuedForAgentId: 'agent-1',
    })
    expect(store.resolve(session.id)?.rootHash).toBe('root-1')
  })

  it('expires idle and absolute sessions and emits closure events', () => {
    let now = 1000
    const closed: Array<{ sessionId: string; code: string }> = []
    const store = new WebSessionStore({ now: () => now })
    store.onSessionClosed((event) => closed.push(event))
    const idle = store.create({
      tokenRecordId: 'token-1',
      tokenScope: { kind: 'agent', agentId: 'agent-1' },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })
    const absolute = store.create({
      tokenRecordId: 'token-2',
      tokenScope: { kind: 'agent', agentId: 'agent-2' },
      activeAgentId: 'agent-2',
      rootHash: 'root-1',
      idleTimeoutMs: 10000,
      absoluteTimeoutMs: 1000,
    })

    now = 2501

    expect(store.resolve(idle.id)).toBeNull()
    expect(store.resolve(absolute.id)).toBeNull()
    expect(closed).toEqual([
      { sessionId: idle.id, code: 'session_expired' },
      { sessionId: absolute.id, code: 'session_expired' },
    ])
  })

  it('expires sessions at the exact idle timeout boundary', () => {
    let now = 1000
    const store = new WebSessionStore({ now: () => now })
    const session = store.create({
      tokenRecordId: 'token-1',
      tokenScope: { kind: 'agent', agentId: 'agent-1' },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })

    now = 2000

    expect(store.resolve(session.id)).toBeNull()
  })

  it('expires sessions at the exact absolute timeout boundary', () => {
    let now = 1000
    const store = new WebSessionStore({ now: () => now })
    const session = store.create({
      tokenRecordId: 'token-1',
      tokenScope: { kind: 'agent', agentId: 'agent-1' },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 5000,
      absoluteTimeoutMs: 1000,
    })

    now = 2000

    expect(store.resolve(session.id)).toBeNull()
  })

  it('returns defensive copies so external mutation does not change stored sessions', () => {
    const now = 1000
    const store = new WebSessionStore({ now: () => now })
    const created = store.create({
      tokenRecordId: 'token-1',
      tokenScope: {
        kind: 'workspaceRoot',
        rootHash: 'root-1',
        issuedForAgentId: 'agent-1',
      },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 5000,
      absoluteTimeoutMs: 5000,
    })

    created.activeAgentId = 'mutated-agent'
    created.tokenScope = { kind: 'agent', agentId: 'mutated-agent' }

    const resolved = store.resolve(created.id)
    expect(resolved).toEqual(
      expect.objectContaining({
        activeAgentId: 'agent-1',
        tokenScope: {
          kind: 'workspaceRoot',
          rootHash: 'root-1',
          issuedForAgentId: 'agent-1',
        },
      }),
    )

    resolved!.activeAgentId = 'mutated-again'
    resolved!.tokenScope = { kind: 'agent', agentId: 'mutated-again' }

    const switched = store.switchActiveAgent(created.id, 'agent-2')
    expect(switched).toEqual(
      expect.objectContaining({
        activeAgentId: 'agent-2',
        tokenScope: {
          kind: 'workspaceRoot',
          rootHash: 'root-1',
          issuedForAgentId: 'agent-1',
        },
      }),
    )

    switched!.activeAgentId = 'mutated-after-switch'

    expect(store.resolve(created.id)).toEqual(
      expect.objectContaining({
        activeAgentId: 'agent-2',
        tokenScope: {
          kind: 'workspaceRoot',
          rootHash: 'root-1',
          issuedForAgentId: 'agent-1',
        },
      }),
    )
  })

  it('clones token scope on create so input mutation cannot change stored authorization scope', () => {
    const store = new WebSessionStore({ now: () => 1000 })
    const tokenScope = {
      kind: 'workspaceRoot' as const,
      rootHash: 'root-1',
      issuedForAgentId: 'agent-1',
    }

    const session = store.create({
      tokenRecordId: 'token-1',
      tokenScope,
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 5000,
      absoluteTimeoutMs: 5000,
    })

    tokenScope.rootHash = 'mutated-root'
    tokenScope.issuedForAgentId = 'mutated-agent'

    expect(store.resolve(session.id)?.tokenScope).toEqual({
      kind: 'workspaceRoot',
      rootHash: 'root-1',
      issuedForAgentId: 'agent-1',
    })
  })

  it('revokes all sessions created from a token record id', () => {
    const closed: Array<{ sessionId: string; code: string }> = []
    const store = new WebSessionStore({ now: () => 1000 })
    store.onSessionClosed((event) => closed.push(event))
    const first = store.create({
      tokenRecordId: 'token-1',
      tokenScope: { kind: 'agent', agentId: 'agent-1' },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })
    const second = store.create({
      tokenRecordId: 'token-1',
      tokenScope: { kind: 'agent', agentId: 'agent-1' },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })
    const other = store.create({
      tokenRecordId: 'token-2',
      tokenScope: { kind: 'agent', agentId: 'agent-1' },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })

    expect(store.revokeTokenSessions('token-1')).toBe(2)
    expect(store.resolve(first.id)).toBeNull()
    expect(store.resolve(second.id)).toBeNull()
    expect(store.resolve(other.id)).not.toBeNull()
    expect(closed).toEqual([
      { sessionId: first.id, code: 'token_revoked' },
      { sessionId: second.id, code: 'token_revoked' },
    ])
  })

  it('closes sessions for unavailable agents', () => {
    const closed: Array<{ sessionId: string; code: string }> = []
    const store = new WebSessionStore({ now: () => 1000 })
    store.onSessionClosed((event) => closed.push(event))
    const first = store.create({
      tokenRecordId: 'token-1',
      tokenScope: { kind: 'agent', agentId: 'agent-1' },
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })
    const second = store.create({
      tokenRecordId: 'token-2',
      tokenScope: { kind: 'agent', agentId: 'agent-2' },
      activeAgentId: 'agent-2',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })

    expect(store.closeAgentSessions('agent-1')).toBe(1)
    expect(store.resolve(first.id)).toBeNull()
    expect(store.resolve(second.id)).not.toBeNull()
    expect(closed).toEqual([{ sessionId: first.id, code: 'agent_unavailable' }])
  })
})
