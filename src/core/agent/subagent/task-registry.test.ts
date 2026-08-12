import type { ChatMessage } from '../../../types/chat'

import { SubagentTaskRegistry } from './task-registry'
import type { SubagentResult, SubagentTaskRecord } from './types'

const makeTranscript = (id: string): ChatMessage[] => [
  {
    role: 'assistant',
    id,
    content: `assistant ${id}`,
  },
]

const makeRecord = (
  taskId: string,
  overrides: Partial<SubagentTaskRecord> = {},
): SubagentTaskRecord => {
  const createdAt = overrides.createdAt ?? 1
  const status = overrides.status ?? 'completed'
  const transcript = makeTranscript(taskId)
  const result: SubagentResult = {
    taskId,
    status: status === 'running' ? 'completed' : status,
    content: `result ${taskId}`,
    activityLog: `activity ${taskId}`,
    durationMs: 123,
    toolUseCount: 2,
    prompt: `prompt ${taskId}`,
    modelName: 'test-model',
    transcript,
  }

  return {
    taskId,
    conversationId: 'conv-1',
    source: {
      type: 'llm_tool_call',
      toolCallId: `tool-${taskId}`,
      assistantMessageId: `assistant-${taskId}`,
    },
    title: `Task ${taskId}`,
    status,
    createdAt,
    completedAt: status === 'running' ? undefined : createdAt + 1,
    prompt: `prompt ${taskId}`,
    result,
    liveTranscript: transcript,
    activityLog: result.activityLog,
    abortController: new AbortController(),
    ...overrides,
  }
}

describe('SubagentTaskRegistry', () => {
  it('normalizes identity without mutating the runtime record', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('sub_identity', {
      sessionId: undefined,
      runSequence: undefined,
      runKey: undefined,
      mode: undefined,
    })

    registry.register(record)

    expect(record.sessionId).toBeUndefined()
    expect(registry.get('sub_identity')).toMatchObject({
      taskId: 'sub_identity',
      sessionId: 'sub_identity',
      runSequence: 1,
      runKey: 'sub_identity:1',
      mode: 'ephemeral',
    })
  })

  it('uses the stable session id as the index key', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('legacy-task', {
      sessionId: 'session-stable',
      runSequence: 2,
      runKey: 'session-stable:2',
      mode: 'persistent',
    })

    registry.register(record)

    expect(registry.get('session-stable')).toMatchObject({
      taskId: 'session-stable',
      sessionId: 'session-stable',
      runSequence: 2,
      runKey: 'session-stable:2',
    })
    expect(registry.get('legacy-task')).toBeUndefined()
  })

  it('never stores streaming transcript arrays or abort owners in the index', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('projection_task', { status: 'running' })
    const subscriber = jest.fn()
    registry.subscribeTask(record.taskId, subscriber)

    registry.register(record)
    registry.update(record.taskId, {
      liveTranscript: [
        {
          role: 'assistant',
          id: 'live-update',
          content: 'streaming',
        },
      ],
    })

    expect(registry.get(record.taskId)).not.toHaveProperty('liveTranscript')
    expect(registry.get(record.taskId)).not.toHaveProperty('abortController')
    // Task 10 C1：liveTranscript 走侧 map 旁路并通知订阅者（审批块实时重渲染）。
    expect(registry.getLiveTranscript(record.taskId)).toHaveLength(1)
    expect(registry.getLiveTranscript(record.taskId)?.[0]?.id).toBe(
      'live-update',
    )
    expect(subscriber).toHaveBeenCalledTimes(2)
  })

  it('aborts the run owner through the side map without an indexed controller', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('abort_owner', { status: 'running' })
    registry.register(record)

    expect(registry.get(record.taskId)).not.toHaveProperty('abortController')
    expect(record.abortController.signal.aborted).toBe(false)

    registry.abort(record.taskId)

    expect(record.abortController.signal.aborted).toBe(true)
  })

  it('keeps task records immutable when applying summary updates', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('summary_task', { status: 'running' })
    registry.register(record)

    registry.update(record.taskId, {
      status: 'completed',
      completedAt: 4,
      activityLog: 'finished',
    })

    expect(record.status).toBe('running')
    expect(registry.get(record.taskId)).toMatchObject({
      status: 'completed',
      completedAt: 4,
      activityLog: 'finished',
    })
  })

  it('compacts completed summaries without retaining transcript arrays', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('compact_task')
    registry.register(record)

    registry.compactCompleted(record.taskId)

    const compacted = registry.get(record.taskId)
    expect(compacted).toMatchObject({
      taskId: record.taskId,
      status: 'completed',
      prompt: record.prompt,
      activityLog: record.activityLog,
    })
    expect(compacted).not.toHaveProperty('liveTranscript')
    expect(compacted).not.toHaveProperty('abortController')
    expect(compacted?.result?.transcript).toBeUndefined()
  })

  it('keeps running records untouched', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('sub_running', { status: 'running' })
    registry.register(record)

    registry.compactCompleted(record.taskId)

    expect(registry.get(record.taskId)).toMatchObject({
      status: 'running',
    })
    expect(registry.get(record.taskId)?.result?.transcript).toBe(
      record.result?.transcript,
    )
  })

  it('prunes only completed indexed records past the configured bound', () => {
    const registry = new SubagentTaskRegistry(2)
    const running = makeRecord('sub_running', {
      status: 'running',
      createdAt: 0,
    })
    registry.register(running)

    for (let index = 1; index <= 3; index += 1) {
      const record = makeRecord(`sub_${index}`, { createdAt: index })
      registry.register(record)
      registry.compactCompleted(record.taskId)
    }

    expect(registry.get('sub_1')).toBeUndefined()
    expect(registry.get('sub_2')).toBeDefined()
    expect(registry.get('sub_3')).toBeDefined()
    expect(registry.get(running.taskId)).toMatchObject({
      taskId: running.taskId,
      status: 'running',
    })
  })

  it('does not prune completed records that have not been compacted', () => {
    const registry = new SubagentTaskRegistry(1)
    const pendingMergeRecord = makeRecord('sub_pending_merge', { createdAt: 0 })
    registry.register(pendingMergeRecord)

    for (let index = 1; index <= 2; index += 1) {
      const record = makeRecord(`sub_merged_${index}`, { createdAt: index })
      registry.register(record)
      registry.compactCompleted(record.taskId)
    }

    expect(registry.get(pendingMergeRecord.taskId)).toBeDefined()
    expect(registry.get('sub_merged_1')).toBeUndefined()
    expect(registry.get('sub_merged_2')).toBeDefined()
  })

  it('automatically compacts completed records after terminal updates', async () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('sub_auto_compact', { status: 'running' })
    registry.register(record)

    registry.update(record.taskId, {
      status: 'completed',
      completedAt: 2,
      result: {
        ...record.result!,
        status: 'completed',
      },
    })

    expect(registry.get(record.taskId)?.result?.transcript).toBeDefined()
    await Promise.resolve()

    expect(registry.get(record.taskId)).not.toHaveProperty('liveTranscript')
    expect(registry.get(record.taskId)?.result?.transcript).toBeUndefined()
  })

  it('notifies only subscribers for the task that changed', () => {
    const registry = new SubagentTaskRegistry()
    const firstSubscriber = jest.fn()
    const secondSubscriber = jest.fn()
    registry.subscribeTask('sub_1', firstSubscriber)
    registry.subscribeTask('sub_2', secondSubscriber)

    registry.register(makeRecord('sub_1', { status: 'running' }))
    expect(firstSubscriber).toHaveBeenCalledTimes(1)
    expect(secondSubscriber).not.toHaveBeenCalled()

    registry.register(makeRecord('sub_2', { status: 'running' }))
    expect(firstSubscriber).toHaveBeenCalledTimes(1)
    expect(secondSubscriber).toHaveBeenCalledTimes(1)
  })

  it('does not build global snapshots for task-scoped subscribers', () => {
    const registry = new SubagentTaskRegistry()
    const list = jest.spyOn(registry, 'list')
    registry.subscribeTask('sub_1', jest.fn())

    registry.register(makeRecord('sub_1', { status: 'running' }))

    expect(list).not.toHaveBeenCalled()
  })

  it('emits only for actual summary or live-transcript changes', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('noop_update', { status: 'running' })
    const subscriber = jest.fn()
    registry.subscribe(subscriber)
    registry.register(record)
    subscriber.mockClear()

    // 等值 summary patch 不触发 emit。
    registry.update(record.taskId, { activityLog: record.activityLog })
    expect(subscriber).not.toHaveBeenCalled()

    // liveTranscript patch 是真实变更（Task 10 侧 map 旁路）→ emit。
    registry.update(record.taskId, {
      liveTranscript: [{ role: 'assistant', id: 'x', content: 'streaming' }],
    })
    expect(subscriber).toHaveBeenCalledTimes(1)

    // 同一数组引用重复推送不重复 emit。
    const transcript = [
      { role: 'assistant' as const, id: 'x', content: 'streaming' },
    ] as ChatMessage[]
    registry.update(record.taskId, { liveTranscript: transcript })
    registry.update(record.taskId, { liveTranscript: transcript })
    expect(subscriber).toHaveBeenCalledTimes(2)
  })

  it('isolates subscriber failures from later subscribers and compaction', async () => {
    const registry = new SubagentTaskRegistry()
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    let firstNotification = true
    registry.subscribe(() => {
      if (firstNotification) {
        firstNotification = false
        return
      }
      throw new Error('subscriber failed')
    })
    const healthySubscriber = jest.fn()
    registry.subscribe(healthySubscriber)
    const record = makeRecord('sub_completed')

    expect(() => registry.register(record)).not.toThrow()
    expect(healthySubscriber).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    expect(registry.get(record.taskId)?.result?.transcript).toBeUndefined()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
