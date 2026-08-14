/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import {
  type AgentEventStore,
  createAgentEventStore,
} from '../agent/agentEventStore'
import type { AgentConversationState } from '../agent/service'

import { WebAgentRunBridge } from './WebAgentRunBridge'
import { WebSseHub } from './WebSseHub'

describe('WebAgentRunBridge', () => {
  let tempDir: string
  let eventStore: AgentEventStore | null = null

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'smart-rag-web-run-'))
  })

  afterEach(() => {
    eventStore?.close()
    eventStore = null
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates a durable run and publishes ordered SSE replay events', async () => {
    eventStore = createAgentEventStore(tempDir)
    const sseHub = new WebSseHub({ now: () => 10 })
    const states: AgentConversationState[] = [
      {
        conversationId: 'conv-1',
        status: 'running',
        runId: 1,
        messages: [],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      },
      {
        conversationId: 'conv-1',
        status: 'completed',
        runId: 1,
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: null,
            promptContent: 'hello',
            mentionables: [],
          },
          { id: 'a1', role: 'assistant', content: 'hello' },
        ],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      },
    ]
    const bridge = new WebAgentRunBridge({
      eventStore,
      sseHub,
      now: () => 10,
    })
    const receivedSequences: number[] = []
    sseHub.subscribe('run-1', (event) => {
      receivedSequences.push(event.sequence)
    })

    bridge.start({
      runId: 'run-1',
      conversationId: 'conv-1',
      workspaceId: null,
      agentInstanceId: null,
      startedAtMs: 1,
      abort: jest.fn(() => false),
      execute: async ({ onEvent }) => {
        for (const state of states) {
          onEvent({ type: 'state', ...state })
        }
      },
    })

    await waitFor(() => eventStore?.getRun('run-1')?.status === 'completed')

    expect(
      eventStore.getRunEvents('run-1').map((event) => event.sequence),
    ).toEqual([1, 2])
    // 完成后桥主动关闭该 run 的 SSE 订阅并清空 hub 回放（事件已落
    // eventStore，迟到连接走 eventStore 回放）；这里断言订阅者曾实时收到事件。
    expect(receivedSequences).toEqual([1, 2])
    expect(sseHub.getReplayEvents('run-1')).toEqual([])
    expect(eventStore.getRunEvents('run-1')[0]?.eventJson).toMatchObject({
      type: 'state',
      conversationId: 'conv-1',
    })
    expect(eventStore.getRunEvents('run-1')[1]?.eventJson).toMatchObject({
      type: 'state',
      status: 'completed',
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: null,
          promptContent: 'hello',
          mentionables: [],
        },
        { id: 'a1', role: 'assistant', content: 'hello' },
      ],
    })
  })

  it('persists and publishes non-state stream events', async () => {
    eventStore = createAgentEventStore(tempDir)
    const sseHub = new WebSseHub({ now: () => 10 })
    const bridge = new WebAgentRunBridge({
      eventStore,
      sseHub,
      now: () => 10,
    })
    const receivedTypes: string[] = []
    sseHub.subscribe('run-1', (event) => {
      receivedTypes.push(event.eventType)
    })

    bridge.start({
      runId: 'run-1',
      conversationId: 'conv-1',
      workspaceId: null,
      agentInstanceId: null,
      startedAtMs: 1,
      abort: jest.fn(() => false),
      execute: async ({ onEvent }) => {
        onEvent({
          type: 'text',
          conversationId: 'conv-1',
          messageId: 'a1',
          text: 'hello',
          delta: 'hello',
          streaming: true,
        })
        onEvent({
          type: 'completed',
          conversationId: 'conv-1',
          text: 'hello',
        })
      },
    })

    await waitFor(() => eventStore?.getRun('run-1')?.status === 'completed')

    expect(
      eventStore.getRunEvents('run-1').map((event) => event.eventType),
    ).toEqual(['text', 'completed'])
    expect(receivedTypes).toEqual(['text', 'completed'])
    expect(sseHub.getReplayEvents('run-1')).toEqual([])
  })

  it('resolves start only after the execution callback settles', async () => {
    eventStore = createAgentEventStore(tempDir)
    const bridge = new WebAgentRunBridge({
      eventStore,
      sseHub: new WebSseHub(),
    })
    const execution = deferred<void>()

    const completion = bridge.start({
      runId: 'run-1',
      conversationId: 'conv-1',
      workspaceId: null,
      agentInstanceId: null,
      abort: jest.fn(() => false),
      execute: async () => execution.promise,
    })

    expect(completion).toBeInstanceOf(Promise)
    execution.resolve()
    await completion
    expect(eventStore.getRun('run-1')?.status).toBe('completed')
  })

  it('keeps an aborted run aborted when execution resolves afterward', async () => {
    eventStore = createAgentEventStore(tempDir)
    const execution = deferred<void>()
    const bridge = new WebAgentRunBridge({
      eventStore,
      sseHub: new WebSseHub(),
    })

    const completion = bridge.start({
      runId: 'run-1',
      conversationId: 'conv-1',
      workspaceId: null,
      agentInstanceId: null,
      abort: jest.fn(() => true),
      execute: async () => execution.promise,
    })

    expect(bridge.abort('run-1')).toEqual({
      found: true,
      status: 'aborted',
    })
    execution.resolve()
    await completion

    expect(eventStore.getRun('run-1')?.status).toBe('aborted')
  })

  it('does not reject when terminal status persistence fails', async () => {
    eventStore = createAgentEventStore(tempDir)
    const logError = jest.spyOn(console, 'error').mockImplementation(() => {})
    jest
      .spyOn(eventStore, 'updateRunStatus')
      .mockImplementation(() => {
        throw new Error('terminal status write failed')
      })
    const bridge = new WebAgentRunBridge({
      eventStore,
      sseHub: new WebSseHub(),
    })

    await expect(
      bridge.start({
        runId: 'run-1',
        conversationId: 'conv-1',
        workspaceId: null,
        agentInstanceId: null,
        abort: jest.fn(() => false),
        execute: async () => undefined,
      }),
    ).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledWith(
      '[YOLO] Failed to persist web agent run status:',
      expect.any(Error),
    )
    logError.mockRestore()
  })

  it('bounds dispose when an execution ignores abort', async () => {
    jest.useFakeTimers()
    eventStore = createAgentEventStore(tempDir)
    const execution = deferred<void>()
    const bridge = new WebAgentRunBridge({
      eventStore,
      sseHub: new WebSseHub(),
    })
    const completion = bridge.start({
      runId: 'run-1',
      conversationId: 'conv-1',
      workspaceId: null,
      agentInstanceId: null,
      abort: jest.fn(() => true),
      execute: async () => execution.promise,
    })
    let disposed = false
    const disposePromise = bridge.dispose().then(() => {
      disposed = true
    })

    try {
      await jest.advanceTimersByTimeAsync(5000)
      expect(disposed).toBe(true)
    } finally {
      execution.resolve()
      await completion
      await disposePromise
      jest.useRealTimers()
    }
  })

  it('does not write a late terminal state after the event store closes', async () => {
    eventStore = createAgentEventStore(tempDir)
    const execution = deferred<void>()
    const bridge = new WebAgentRunBridge({
      eventStore,
      sseHub: new WebSseHub(),
    })

    const completion = bridge.start({
      runId: 'run-1',
      conversationId: 'conv-1',
      workspaceId: null,
      agentInstanceId: null,
      abort: jest.fn(() => false),
      execute: async () => execution.promise,
    })

    eventStore.close()
    execution.resolve()

    await expect(completion).resolves.toBeUndefined()
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition not met')
}
