/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as fs from 'node:fs'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'

import { createAgentEventStore } from './agentEventStore'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-event-store-'))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  })
}

describe('AgentEventStore', () => {
  it('defers Node path loading until the event store opens', () => {
    const source = readFileSync(
      path.join(__dirname, 'agentEventStore.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:path'/)
    expect(source).toContain(
      "loadDesktopNodeModuleSync<typeof import('node:path')>",
    )
  })

  it('keeps the SQLite native runtime free of module-level Node imports', () => {
    const source = readFileSync(
      path.join(__dirname, '../../database/sqlite/sqliteNativeRuntime.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:(fs|module|path)'/)
    expect(source).toContain('loadDesktopNodeModuleSync')
  })

  it('creates a run and appends ordered events', () => {
    const dir = makeTempDir()
    try {
      const store = createAgentEventStore(dir)

      store.createRun({
        runId: 'run-1',
        conversationId: 'conv-1',
        workspaceId: null,
        agentInstanceId: null,
        status: 'running',
        startedAtMs: 1,
      })
      store.insertEvent({
        runId: 'run-1',
        sequence: 1,
        eventType: 'text',
        eventJson: { type: 'text', conversationId: 'conv-1', text: 'hello' },
        createdAtMs: 2,
      })

      expect(store.getRunEvents('run-1')).toEqual([
        {
          eventId: 1,
          runId: 'run-1',
          sequence: 1,
          eventType: 'text',
          eventJson: {
            type: 'text',
            conversationId: 'conv-1',
            text: 'hello',
          },
          createdAtMs: 2,
        },
      ])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('filters run events by exclusive sequence cursor', () => {
    const dir = makeTempDir()
    try {
      const store = createAgentEventStore(dir)
      store.createRun({
        runId: 'run-1',
        conversationId: 'conv-1',
        workspaceId: 'ws-a',
        agentInstanceId: 'agent-a',
        status: 'running',
        startedAtMs: 1,
      })
      store.insertEvent({
        runId: 'run-1',
        sequence: 1,
        eventType: 'state',
        eventJson: { type: 'state' },
        createdAtMs: 2,
      })
      store.insertEvent({
        runId: 'run-1',
        sequence: 2,
        eventType: 'completed',
        eventJson: { type: 'completed' },
        createdAtMs: 3,
      })

      expect(
        store.getRunEvents('run-1', 1).map((event) => event.sequence),
      ).toEqual([2])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('lists and deletes runs by workspace', () => {
    const dir = makeTempDir()
    try {
      const store = createAgentEventStore(dir)
      store.createRun({
        runId: 'run-a',
        conversationId: 'conv-a',
        workspaceId: 'ws-a',
        agentInstanceId: 'agent-a',
        status: 'running',
        startedAtMs: 10,
      })
      store.createRun({
        runId: 'run-b',
        conversationId: 'conv-b',
        workspaceId: 'ws-b',
        agentInstanceId: 'agent-b',
        status: 'completed',
        startedAtMs: 20,
        finishedAtMs: 30,
        toolCallCount: 2,
      })
      store.insertEvent({
        runId: 'run-a',
        sequence: 1,
        eventType: 'text',
        eventJson: { text: 'a' },
        createdAtMs: 11,
      })

      expect(store.listRuns({ workspaceId: 'ws-a' })).toEqual([
        {
          runId: 'run-a',
          conversationId: 'conv-a',
          workspaceId: 'ws-a',
          agentInstanceId: 'agent-a',
          status: 'running',
          startedAtMs: 10,
          finishedAtMs: null,
          toolCallCount: 0,
        },
      ])

      store.deleteRunsByWorkspace('ws-a')
      expect(store.listRuns().map((run) => run.runId)).toEqual(['run-b'])
      expect(store.getRunEvents('run-a')).toEqual([])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('deletes all runs for a conversation with their events', () => {
    const dir = makeTempDir()
    try {
      const store = createAgentEventStore(dir)
      store.createRun({
        runId: 'run-a',
        conversationId: 'conv-a',
        workspaceId: 'ws-a',
        agentInstanceId: 'agent-a',
        status: 'completed',
        startedAtMs: 10,
        finishedAtMs: 20,
      })
      store.insertEvent({
        runId: 'run-a',
        sequence: 1,
        eventType: 'tool_call',
        eventJson: {},
        createdAtMs: 15,
      })
      store.createRun({
        runId: 'run-b',
        conversationId: 'conv-b',
        workspaceId: 'ws-a',
        agentInstanceId: 'agent-a',
        status: 'completed',
        startedAtMs: 30,
        finishedAtMs: 40,
      })

      store.deleteRunsByConversation('conv-a')
      expect(store.listRuns().map((run) => run.runId)).toEqual(['run-b'])
      expect(store.getRunEvents('run-a')).toEqual([])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('gets and deletes a single run without affecting other runs', () => {
    const dir = makeTempDir()
    try {
      const store = createAgentEventStore(dir)
      store.createRun({
        runId: 'run-a',
        conversationId: 'conv-a',
        workspaceId: 'ws-a',
        agentInstanceId: 'agent-a',
        status: 'running',
        startedAtMs: 10,
      })
      store.createRun({
        runId: 'run-b',
        conversationId: 'conv-b',
        workspaceId: null,
        agentInstanceId: null,
        status: 'completed',
        startedAtMs: 20,
        finishedAtMs: 30,
      })
      store.insertEvent({
        runId: 'run-a',
        sequence: 1,
        eventType: 'text',
        eventJson: { text: 'a' },
        createdAtMs: 11,
      })

      expect(store.getRun('run-a')).toEqual({
        runId: 'run-a',
        conversationId: 'conv-a',
        workspaceId: 'ws-a',
        agentInstanceId: 'agent-a',
        status: 'running',
        startedAtMs: 10,
        finishedAtMs: null,
        toolCallCount: 0,
      })
      expect(store.getRun('missing')).toBeNull()

      store.deleteRun('run-a')

      expect(store.getRun('run-a')).toBeNull()
      expect(store.getRunEvents('run-a')).toEqual([])
      expect(store.listRuns().map((run) => run.runId)).toEqual(['run-b'])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('lists runs by workspaceId for undefined, null, and string filters', () => {
    const dir = makeTempDir()
    try {
      const store = createAgentEventStore(dir)
      store.createRun({
        runId: 'run-global',
        conversationId: 'conv-global',
        workspaceId: null,
        agentInstanceId: null,
        status: 'running',
        startedAtMs: 10,
      })
      store.createRun({
        runId: 'run-a',
        conversationId: 'conv-a',
        workspaceId: 'ws-a',
        agentInstanceId: 'agent-a',
        status: 'completed',
        startedAtMs: 20,
        finishedAtMs: 25,
      })

      expect(store.listRuns().map((run) => run.runId)).toEqual([
        'run-a',
        'run-global',
      ])
      expect(
        store.listRuns({ workspaceId: null }).map((run) => run.runId),
      ).toEqual(['run-global'])
      expect(
        store.listRuns({ workspaceId: 'ws-a' }).map((run) => run.runId),
      ).toEqual(['run-a'])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('lists and deletes runs by agent instance id without using workspace_id as web selector', () => {
    const dir = makeTempDir()
    let store: ReturnType<typeof createAgentEventStore> | null = null
    try {
      store = createAgentEventStore(dir)
      store.createRun({
        runId: 'run-a',
        conversationId: 'chat-a',
        workspaceId: null,
        agentInstanceId: 'agent-a',
        status: 'running',
        startedAtMs: 1,
      })
      store.createRun({
        runId: 'run-b',
        conversationId: 'chat-b',
        workspaceId: 'legacy-ws',
        agentInstanceId: 'agent-b',
        status: 'running',
        startedAtMs: 2,
      })
      store.createRun({
        runId: 'run-c',
        conversationId: 'chat-c',
        workspaceId: 'legacy-ws',
        agentInstanceId: 'agent-a',
        status: 'completed',
        startedAtMs: 3,
        finishedAtMs: 4,
      })

      expect(store.listRunsByAgent('agent-a').map((run) => run.runId)).toEqual([
        'run-c',
        'run-a',
      ])

      store.deleteRunsByAgent('agent-a')

      expect(store.listRuns().map((run) => run.runId)).toEqual(['run-b'])
    } finally {
      store?.close()
      cleanup(dir)
    }
  })

  it('throws a clear corruption error for invalid event JSON', () => {
    const dir = makeTempDir()
    try {
      const store = createAgentEventStore(dir)
      store.createRun({
        runId: 'run-1',
        conversationId: 'conv-1',
        workspaceId: null,
        agentInstanceId: null,
        status: 'running',
        startedAtMs: 1,
      })
      store.close()

      const runtime = openSqliteRuntime({
        dbPath: path.join(dir, 'agent.sqlite'),
      })
      runtime.exec(
        `
          insert into agent_events(run_id, sequence, event_type, event_json, created_at_ms)
          values (?, ?, ?, ?, ?)
        `,
        ['run-1', 1, 'text', '{bad json', 2],
      )
      runtime.close()

      const reopened = createAgentEventStore(dir)
      expect(() => reopened.getRunEvents('run-1')).toThrow(
        /corrupt agent event row/,
      )
      reopened.close()
    } finally {
      cleanup(dir)
    }
  })
})
