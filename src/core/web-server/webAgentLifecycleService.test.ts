/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createAgentEventStore } from '../agent/agentEventStore'

import {
  type DeleteAgentResult,
  type RevokeShareTokenResult,
  WebAgentLifecycleService,
} from './webAgentLifecycleService'
import { WebSessionStore } from './webSessionStore'

type TestSettings = {
  assistants: Array<{ id: string; name?: string }>
  workspaceAgents: Array<{
    id: string
    templateId: string
    tokenRecordIds?: string[]
    tokenRecords?: Array<{ id: string }>
    shareTokens?: Array<{ id: string; revokedAt?: number }>
  }>
  currentWorkspaceAgentId?: string
}

describe('WebAgentLifecycleService', () => {
  it('deletes an agent revoking sessions, orphaning conversations, and deleting agent runs', async () => {
    const settings: TestSettings = {
      assistants: [{ id: 'template-1' }],
      workspaceAgents: [
        {
          id: 'agent-1',
          templateId: 'template-1',
          tokenRecordIds: ['token-1'],
          tokenRecords: [{ id: 'token-2' }],
        },
        {
          id: 'agent-2',
          templateId: 'template-1',
          tokenRecordIds: ['token-3'],
        },
      ],
      currentWorkspaceAgentId: 'agent-2',
    }
    const saveSnapshots: TestSettings[] = []
    const revokedCalls: Array<{ tokenRecordId: string; code?: string }> = []
    const abortCalls: string[] = []
    const orphanCalls: Array<{ agentId: string; reason: string }> = []
    const store = {
      listRunsByAgent: jest.fn(() => [
        {
          runId: 'run-1',
          conversationId: 'conv-1',
          workspaceId: 'legacy-a',
          agentInstanceId: 'agent-1',
          status: 'running' as const,
          startedAtMs: 1,
          finishedAtMs: null,
          toolCallCount: 0,
        },
        {
          runId: 'run-2',
          conversationId: 'conv-2',
          workspaceId: null,
          agentInstanceId: 'agent-1',
          status: 'completed' as const,
          startedAtMs: 2,
          finishedAtMs: 3,
          toolCallCount: 1,
        },
      ]),
      deleteRunsByAgent: jest.fn(),
    }

    const service = new WebAgentLifecycleService({
      getSettings: () => settings,
      saveSettings: async (next) => {
        saveSnapshots.push(next as TestSettings)
        settings.assistants = [...(next.assistants ?? [])]
        settings.workspaceAgents = [
          ...((next as TestSettings).workspaceAgents ?? []),
        ]
        settings.currentWorkspaceAgentId = next.currentWorkspaceAgentId
      },
      sessionStore: {
        closeAgentSessions: jest.fn(() => 0),
        revokeTokenSessions: (tokenRecordId, code) => {
          revokedCalls.push({ tokenRecordId, code })
          return 1
        },
      },
      orphanConversations: async (agentId, reason) => {
        orphanCalls.push({ agentId, reason })
        return 3
      },
      agentEventStore: store,
      abortAgentRuns: async (agentId) => {
        abortCalls.push(agentId)
      },
    })

    const result = await service.deleteAgent('agent-1')

    expect(result).toEqual<DeleteAgentResult>({
      revokedSessionIds: [],
      revokedSessionCount: 2,
      orphanedConversationCount: 3,
      deletedRunCount: 2,
    })
    expect(abortCalls).toEqual(['agent-1'])
    expect(revokedCalls).toEqual([
      { tokenRecordId: 'token-1', code: 'agent_unavailable' },
      { tokenRecordId: 'token-2', code: 'agent_unavailable' },
    ])
    expect(orphanCalls).toEqual([
      { agentId: 'agent-1', reason: 'agent_deleted' },
    ])
    expect(store.listRunsByAgent).toHaveBeenCalledWith('agent-1')
    expect(store.deleteRunsByAgent).toHaveBeenCalledWith('agent-1')
    expect(settings.workspaceAgents.map((agent) => agent.id)).toEqual([
      'agent-2',
    ])
    expect(settings.currentWorkspaceAgentId).toBe('agent-2')
    expect(saveSnapshots).toHaveLength(1)
  })

  it('clears currentWorkspaceAgentId when deleting the selected agent', async () => {
    const settings: TestSettings = {
      assistants: [{ id: 'template-1' }],
      workspaceAgents: [{ id: 'agent-1', templateId: 'template-1' }],
      currentWorkspaceAgentId: 'agent-1',
    }

    const service = new WebAgentLifecycleService({
      getSettings: () => settings,
      saveSettings: async (next) => {
        settings.assistants = [...(next.assistants ?? [])]
        settings.workspaceAgents = [
          ...((next as TestSettings).workspaceAgents ?? []),
        ]
        settings.currentWorkspaceAgentId = next.currentWorkspaceAgentId
      },
      sessionStore: {},
      orphanConversations: async () => 0,
    })

    await service.deleteAgent('agent-1')

    expect(settings.currentWorkspaceAgentId).toBeUndefined()
    expect(settings.workspaceAgents).toEqual([])
  })

  it('deletes a template by running deleteAgent cleanup for every referencing agent first', async () => {
    const settings: TestSettings = {
      assistants: [{ id: 'template-1' }, { id: 'template-2' }],
      workspaceAgents: [
        {
          id: 'agent-1',
          templateId: 'template-1',
          tokenRecordIds: ['token-1'],
        },
        {
          id: 'agent-2',
          templateId: 'template-1',
          tokenRecordIds: ['token-2'],
        },
        {
          id: 'agent-3',
          templateId: 'template-2',
          tokenRecordIds: ['token-3'],
        },
      ],
      currentWorkspaceAgentId: 'agent-2',
    }
    const orphanCalls: Array<{ agentId: string; reason: string }> = []
    const revoked: string[] = []

    const service = new WebAgentLifecycleService({
      getSettings: () => settings,
      saveSettings: async (next) => {
        settings.assistants = [...(next.assistants ?? [])]
        settings.workspaceAgents = [
          ...((next as TestSettings).workspaceAgents ?? []),
        ]
        settings.currentWorkspaceAgentId = next.currentWorkspaceAgentId
      },
      sessionStore: {
        revokeTokenSessions: (tokenRecordId) => {
          revoked.push(tokenRecordId)
          return 1
        },
      },
      orphanConversations: async (agentId, reason) => {
        orphanCalls.push({ agentId, reason })
        return 0
      },
    })

    await service.deleteTemplate('template-1')

    expect(orphanCalls).toEqual([
      { agentId: 'agent-1', reason: 'template_deleted' },
      { agentId: 'agent-2', reason: 'template_deleted' },
    ])
    expect(revoked).toEqual(['token-1', 'token-2'])
    expect(settings.assistants.map((item) => item.id)).toEqual(['template-2'])
    expect(settings.workspaceAgents.map((agent) => agent.id)).toEqual([
      'agent-3',
    ])
    expect(settings.currentWorkspaceAgentId).toBeUndefined()
  })

  it('revokes a share token through the lifecycle service and asks the session store to close token sessions', async () => {
    const settings: TestSettings = {
      assistants: [{ id: 'template-1' }],
      workspaceAgents: [
        {
          id: 'agent-1',
          templateId: 'template-1',
          tokenRecords: [{ id: 'token-1' }],
          shareTokens: [{ id: 'token-1' }],
        },
      ],
    }
    const revokeTokenSessions = jest.fn(() => 2)

    const service = new WebAgentLifecycleService({
      getSettings: () => settings,
      saveSettings: async (next) => {
        settings.assistants = [...(next.assistants ?? [])]
        settings.workspaceAgents = [
          ...((next as TestSettings).workspaceAgents ?? []),
        ]
        settings.currentWorkspaceAgentId = next.currentWorkspaceAgentId
      },
      sessionStore: {
        revokeTokenSessions,
      },
      orphanConversations: async () => 0,
    })

    const result = await service.revokeShareToken('agent-1', 'token-1', 555)

    expect(result).toEqual<RevokeShareTokenResult>({
      revokedSessionIds: [],
      revokedSessionCount: 2,
    })
    expect(revokeTokenSessions).toHaveBeenCalledWith('token-1', 'token_revoked')
    expect(settings.workspaceAgents[0]?.shareTokens).toEqual([
      { id: 'token-1', revokedAt: 555 },
    ])
  })

  it('saves settings before destructive cleanup and stops if saveSettings fails', async () => {
    const settings: TestSettings = {
      assistants: [{ id: 'template-1', name: 'Template' }],
      workspaceAgents: [
        {
          id: 'agent-1',
          templateId: 'template-1',
          tokenRecordIds: ['token-1'],
        },
      ],
      currentWorkspaceAgentId: 'agent-1',
    }
    const abortAgentRuns = jest.fn()
    const closeAgentSessions = jest.fn()
    const revokeTokenSessions = jest.fn()
    const markAgentConversationsOrphaned = jest.fn()
    const listRunsByAgent = jest.fn(() => [{ runId: 'run-1' }])
    const deleteRunsByAgent = jest.fn()

    const service = new WebAgentLifecycleService({
      getSettings: () => settings,
      saveSettings: async () => {
        throw new Error('save failed')
      },
      sessionStore: {
        closeAgentSessions,
        revokeTokenSessions,
      },
      orphanConversations: markAgentConversationsOrphaned,
      agentEventStore: {
        listRunsByAgent,
        deleteRunsByAgent,
      },
      abortAgentRuns,
    })

    await expect(service.deleteAgent('agent-1')).rejects.toThrow('save failed')

    expect(settings).toEqual({
      assistants: [{ id: 'template-1', name: 'Template' }],
      workspaceAgents: [
        {
          id: 'agent-1',
          templateId: 'template-1',
          tokenRecordIds: ['token-1'],
        },
      ],
      currentWorkspaceAgentId: 'agent-1',
    })
    expect(abortAgentRuns).not.toHaveBeenCalled()
    expect(closeAgentSessions).not.toHaveBeenCalled()
    expect(revokeTokenSessions).not.toHaveBeenCalled()
    expect(markAgentConversationsOrphaned).not.toHaveBeenCalled()
    expect(listRunsByAgent).not.toHaveBeenCalled()
    expect(deleteRunsByAgent).not.toHaveBeenCalled()
  })

  it('retries cleanup for an absent agent after save succeeds then cleanup fails', async () => {
    const settings: TestSettings = {
      assistants: [{ id: 'template-1' }],
      workspaceAgents: [{ id: 'agent-1', templateId: 'template-1' }],
    }
    const saveSnapshots: TestSettings[] = []
    const closeAgentSessions = jest.fn(() => 2)
    const markAgentConversationsOrphaned = jest
      .fn()
      .mockRejectedValueOnce(new Error('orphan failed'))
      .mockResolvedValueOnce(4)
    const listRunsByAgent = jest.fn(() => [{ runId: 'run-1' }])
    const deleteRunsByAgent = jest.fn()
    const abortAgentRuns = jest.fn(async () => {})

    const service = new WebAgentLifecycleService({
      getSettings: () => settings,
      saveSettings: async (next) => {
        saveSnapshots.push(next as TestSettings)
        settings.assistants = [...(next.assistants ?? [])]
        settings.workspaceAgents = [
          ...((next as TestSettings).workspaceAgents ?? []),
        ]
        settings.currentWorkspaceAgentId = next.currentWorkspaceAgentId
      },
      sessionStore: {
        closeAgentSessions,
      },
      orphanConversations: markAgentConversationsOrphaned,
      agentEventStore: {
        listRunsByAgent,
        deleteRunsByAgent,
      },
      abortAgentRuns,
    })

    await expect(service.deleteAgent('agent-1')).rejects.toThrow(
      'orphan failed',
    )

    expect(settings.workspaceAgents).toEqual([])

    const result = await service.deleteAgent('agent-1')

    expect(result).toEqual<DeleteAgentResult>({
      revokedSessionIds: [],
      revokedSessionCount: 2,
      orphanedConversationCount: 4,
      deletedRunCount: 1,
    })
    expect(closeAgentSessions).toHaveBeenCalledTimes(2)
    expect(markAgentConversationsOrphaned).toHaveBeenNthCalledWith(
      1,
      'agent-1',
      'agent_deleted',
    )
    expect(markAgentConversationsOrphaned).toHaveBeenNthCalledWith(
      2,
      'agent-1',
      'agent_deleted',
    )
    expect(listRunsByAgent).toHaveBeenCalledWith('agent-1')
    expect(deleteRunsByAgent).toHaveBeenCalledWith('agent-1')
    expect(abortAgentRuns).toHaveBeenNthCalledWith(1, 'agent-1')
    expect(abortAgentRuns).toHaveBeenNthCalledWith(2, 'agent-1')
    expect(saveSnapshots).toHaveLength(1)
  })

  it('uses the real agent event store helper semantics during cleanup', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-agent-lifecycle-'))
    try {
      const eventStore = createAgentEventStore(dir)
      eventStore.createRun({
        runId: 'run-a',
        conversationId: 'conv-a',
        workspaceId: 'legacy-a',
        agentInstanceId: 'agent-a',
        status: 'running',
        startedAtMs: 1,
      })
      eventStore.createRun({
        runId: 'run-b',
        conversationId: 'conv-b',
        workspaceId: 'legacy-b',
        agentInstanceId: 'agent-b',
        status: 'running',
        startedAtMs: 2,
      })

      const settings: TestSettings = {
        assistants: [{ id: 'template-1' }],
        workspaceAgents: [{ id: 'agent-a', templateId: 'template-1' }],
      }
      const service = new WebAgentLifecycleService({
        getSettings: () => settings,
        saveSettings: async (next) => {
          settings.assistants = [...(next.assistants ?? [])]
          settings.workspaceAgents = [
            ...((next as TestSettings).workspaceAgents ?? []),
          ]
          settings.currentWorkspaceAgentId = next.currentWorkspaceAgentId
        },
        sessionStore: {},
        orphanConversations: async () => 0,
        agentEventStore: eventStore,
      })

      const result = await service.deleteAgent('agent-a')

      expect(result.deletedRunCount).toBe(1)
      expect(eventStore.listRuns().map((run) => run.runId)).toEqual(['run-b'])
      eventStore.close()
    } finally {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      })
    }
  })

  it('closes workspaceRoot sessions issued for a deleted agent via the real session store', async () => {
    const settings: TestSettings = {
      assistants: [{ id: 'template-1' }],
      workspaceAgents: [{ id: 'agent-1', templateId: 'template-1' }],
    }
    const sessionStore = new WebSessionStore({ now: () => 1000 })
    const issuedForDeletedAgent = sessionStore.create({
      tokenRecordId: 'token-1',
      tokenScope: {
        kind: 'workspaceRoot',
        rootHash: 'root-1',
        issuedForAgentId: 'agent-1',
      },
      activeAgentId: 'agent-2',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })
    const unrelated = sessionStore.create({
      tokenRecordId: 'token-2',
      tokenScope: {
        kind: 'workspaceRoot',
        rootHash: 'root-1',
        issuedForAgentId: 'agent-2',
      },
      activeAgentId: 'agent-2',
      rootHash: 'root-1',
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 5000,
    })

    const service = new WebAgentLifecycleService({
      getSettings: () => settings,
      saveSettings: async (next) => {
        settings.assistants = [...(next.assistants ?? [])]
        settings.workspaceAgents = [
          ...((next as TestSettings).workspaceAgents ?? []),
        ]
        settings.currentWorkspaceAgentId = next.currentWorkspaceAgentId
      },
      sessionStore,
      orphanConversations: async () => 0,
    })

    const result = await service.deleteAgent('agent-1')

    expect(result.revokedSessionCount).toBe(1)
    expect(result.revokedSessionIds).toEqual([])
    expect(sessionStore.resolve(issuedForDeletedAgent.id)).toBeNull()
    expect(sessionStore.resolve(unrelated.id)).not.toBeNull()
  })
})
