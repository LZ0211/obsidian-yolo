import { TaskRunStatus } from './scheduledTasksStore'
import {
  TaskQueue,
  type TaskQueueEvent,
  type TaskQueueItem,
} from './task-queue'

function makeItem(overrides: Partial<TaskQueueItem> = {}): TaskQueueItem {
  return {
    taskId: 'task-1',
    batchId: 'batch-1',
    scheduleTime: Date.now() - 1,
    enqueuedAt: Date.now(),
    priority: 5,
    attempt: 1,
    maxRetries: 3,
    source: 'schedule',
    ...overrides,
  }
}

describe('TaskQueue', () => {
  it('emits task-ready synchronously on enqueue when under the concurrency limit', () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })
    const events: TaskQueueEvent[] = []
    queue.subscribe((e) => events.push(e))

    queue.enqueue(makeItem())

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('task-ready')
    expect(queue.getExecutingTasks()).toHaveLength(1)
    expect(queue.getExecutingTasks()[0].status).toBe(TaskRunStatus.PENDING)
  })

  it('respects maxConcurrent: a second task waits until the first completes', () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })
    const events: TaskQueueEvent[] = []
    queue.subscribe((e) => events.push(e))

    queue.enqueue(makeItem({ taskId: 'task-1' }))
    queue.enqueue(makeItem({ taskId: 'task-2' }))

    expect(events.filter((e) => e.type === 'task-ready')).toHaveLength(1)
    expect(queue.getPendingTasks().map((i) => i.taskId)).toEqual(['task-2'])

    queue.markCompleted('task-1', 'batch-1')

    expect(events.filter((e) => e.type === 'task-ready')).toHaveLength(2)
    expect(queue.getPendingTasks()).toHaveLength(0)
  })

  it('runs tasks in the same queueGroup one after another even under a high concurrency ceiling', () => {
    const queue = new TaskQueue({
      maxConcurrent: 10,
      defaultMode: 'concurrent',
    })
    queue.enqueue(makeItem({ taskId: 'a', queueGroup: 'g' }))
    queue.enqueue(makeItem({ taskId: 'b', queueGroup: 'g' }))

    expect(queue.getExecutingTasks().map((r) => r.taskId)).toEqual(['a'])
    expect(queue.getPendingTasks().map((i) => i.taskId)).toEqual(['b'])

    queue.markCompleted('a', 'batch-1')

    expect(queue.getExecutingTasks().map((r) => r.taskId)).toEqual(['b'])
  })

  it('holds a dependent task until its dependency is marked completed in the same batch', () => {
    const queue = new TaskQueue({
      maxConcurrent: 10,
      defaultMode: 'concurrent',
    })
    queue.registerBatchMembers('batch-1', ['a', 'b'])
    queue.enqueue(makeItem({ taskId: 'a' }))
    queue.enqueue(
      makeItem({
        taskId: 'b',
        dependency: { dependsOn: ['a'], continueOnDependencyFailure: false },
      }),
    )

    expect(queue.getExecutingTasks().map((r) => r.taskId)).toEqual(['a'])
    expect(queue.getPendingTasks().map((i) => i.taskId)).toEqual(['b'])

    queue.markCompleted('a', 'batch-1')

    expect(queue.getExecutingTasks().map((r) => r.taskId)).toEqual(['b'])
  })

  it('emits task-dependency-unresolvable when the dependency is not a member of the batch', () => {
    const queue = new TaskQueue({
      maxConcurrent: 10,
      defaultMode: 'concurrent',
    })
    queue.registerBatchMembers('batch-1', ['b'])
    const events: TaskQueueEvent[] = []
    queue.subscribe((e) => events.push(e))

    queue.enqueue(
      makeItem({
        taskId: 'b',
        dependency: {
          dependsOn: ['missing-task'],
          continueOnDependencyFailure: false,
        },
      }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'task-dependency-unresolvable',
      missingDependencyTaskId: 'missing-task',
    })
    expect(queue.getPendingTasks()).toHaveLength(0)
    expect(queue.getExecutingTasks()).toHaveLength(0)
  })

  it('does not resolve a dependency isolated to a different batchId', () => {
    // Regression: batch-scoped completed/failed sets must not leak across batches for recurring tasks.
    const queue = new TaskQueue({
      maxConcurrent: 10,
      defaultMode: 'concurrent',
    })
    queue.registerBatchMembers('batch-1', ['a'])
    queue.enqueue(makeItem({ taskId: 'a', batchId: 'batch-1' }))
    queue.markCompleted('a', 'batch-1')

    queue.registerBatchMembers('batch-2', ['a', 'b'])
    queue.enqueue(
      makeItem({
        taskId: 'b',
        batchId: 'batch-2',
        dependency: { dependsOn: ['a'], continueOnDependencyFailure: false },
      }),
    )

    // 'a' hasn't completed within batch-2 yet, so 'b' must still be waiting.
    expect(queue.getPendingTasks().map((i) => i.taskId)).toEqual(['b'])
  })

  it('fails a dependent task once its dependency fails when continueOnDependencyFailure is false', () => {
    const queue = new TaskQueue({
      maxConcurrent: 10,
      defaultMode: 'concurrent',
    })
    const events: TaskQueueEvent[] = []
    queue.subscribe((event) => events.push(event))
    queue.registerBatchMembers('batch-1', ['a', 'b'])
    queue.enqueue(makeItem({ taskId: 'a' }))
    queue.enqueue(
      makeItem({
        taskId: 'b',
        dependency: { dependsOn: ['a'], continueOnDependencyFailure: false },
      }),
    )

    queue.markFailed('a', 'batch-1', false)

    expect(queue.getPendingTasks()).toHaveLength(0)
    expect(queue.getExecutingTasks()).toHaveLength(0)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task-dependency-unresolvable',
        missingDependencyTaskId: 'a',
        reason: 'failed',
      }),
    )
  })

  it('proceeds past a failed dependency when continueOnDependencyFailure is true', () => {
    const queue = new TaskQueue({
      maxConcurrent: 10,
      defaultMode: 'concurrent',
    })
    queue.registerBatchMembers('batch-1', ['a', 'b'])
    queue.enqueue(makeItem({ taskId: 'a' }))
    queue.enqueue(
      makeItem({
        taskId: 'b',
        dependency: { dependsOn: ['a'], continueOnDependencyFailure: true },
      }),
    )

    queue.markFailed('a', 'batch-1', false)

    expect(queue.getExecutingTasks().map((r) => r.taskId)).toEqual(['b'])
  })

  it('retries a retryable failure with exponential backoff, re-queuing at a later scheduleTime', () => {
    jest.useFakeTimers().setSystemTime(1_000_000)
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })
    queue.enqueue(makeItem({ taskId: 'a', maxRetries: 2 }))

    queue.markFailed('a', 'batch-1', true)

    expect(queue.getPendingTasks()).toHaveLength(1)
    expect(queue.getPendingTasks()[0].attempt).toBe(2)
    expect(queue.getPendingTasks()[0].scheduleTime).toBeGreaterThan(1_000_000)
    expect(queue.getExecutingTasks()).toHaveLength(0)
    jest.useRealTimers()
  })

  it('stops retrying once maxRetries is exceeded, marking the batch failed instead', () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })
    queue.enqueue(makeItem({ taskId: 'a', maxRetries: 1 }))

    queue.markFailed('a', 'batch-1', true) // attempt(1) is not < maxRetries(1) -> terminal failure

    expect(queue.getPendingTasks()).toHaveLength(0)
    expect(queue.getQueueStatus().failed).toBe(1)
  })

  it('dedups via isTaskQueued for a task already queued or executing', () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })
    queue.enqueue(makeItem({ taskId: 'a' }))
    expect(queue.isTaskQueued('a')).toBe(true)
    expect(queue.isTaskQueued('unknown')).toBe(false)

    queue.enqueue(makeItem({ taskId: 'b' }))
    expect(queue.isTaskQueued('b')).toBe(true)
  })

  it('pause() prevents dequeuing and resume() drains the queue again', () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })
    queue.pause()
    queue.enqueue(makeItem({ taskId: 'a' }))
    expect(queue.getExecutingTasks()).toHaveLength(0)

    queue.resume()
    expect(queue.getExecutingTasks()).toHaveLength(1)
  })

  it('updatePendingPriority reorders a still-queued item and returns false once it started executing', () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })
    queue.enqueue(makeItem({ taskId: 'a', priority: 5 }))
    queue.enqueue(makeItem({ taskId: 'b', priority: 5 }))

    expect(queue.updatePendingPriority('b', 9)).toBe(true)
    expect(queue.getPendingTasks().map((i) => i.taskId)).toEqual(['b'])

    expect(queue.updatePendingPriority('a', 1)).toBe(false)
  })

  it('promotePendingTask jumps a still-queued item to the front without recording the bump for retries', () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })
    queue.enqueue(makeItem({ taskId: 'a', priority: 5 }))
    queue.enqueue(makeItem({ taskId: 'b', priority: 5 }))
    queue.enqueue(makeItem({ taskId: 'c', priority: 5 }))

    // 'c' jumps ahead of 'b' (which is still queued behind the executing 'a').
    expect(queue.promotePendingTask('c')).toBe(true)
    expect(queue.getPendingTasks().map((i) => i.taskId)).toEqual(['c', 'b'])

    // The transient bump is not recorded in latestPriority: when 'a' fails and
    // its retry is scheduled, the retry keeps the item's stored priority (5)
    // rather than inheriting a bump that was meant for one dequeue only.
    queue.markFailed('a', 'batch-1', true)
    const retryItem = queue.getPendingTasks().find((i) => i.taskId === 'a')
    expect(retryItem?.priority).toBe(5)

    // A task with no pending item (never enqueued) → false and no change.
    expect(queue.promotePendingTask('never-enqueued')).toBe(false)
  })

  it('labels the run from the explicit source, not the priority', () => {
    const queue = new TaskQueue({ maxConcurrent: 2, defaultMode: 'concurrent' })
    queue.enqueue(makeItem({ taskId: 'scheduled-high', priority: 10 }))
    queue.enqueue(
      makeItem({ taskId: 'manual-low', priority: 1, source: 'manual' }),
    )

    const runs = queue.getExecutingTasks()
    expect(runs.find((r) => r.taskId === 'scheduled-high')?.triggeredBy).toBe(
      'schedule',
    )
    expect(runs.find((r) => r.taskId === 'manual-low')?.triggeredBy).toBe(
      'manual',
    )
  })

  it('marks a retried run as retry regardless of the original source', () => {
    const queue = new TaskQueue({ maxConcurrent: 2, defaultMode: 'concurrent' })
    queue.enqueue(makeItem({ taskId: 'retry-me', source: 'manual' }))
    expect(queue.getExecutingTasks()[0]?.triggeredBy).toBe('manual')

    queue.markFailed('retry-me', 'batch-1', true)
    const pending = queue.getPendingTasks()
    expect(pending[0]?.taskId).toBe('retry-me')
    expect(pending[0]?.source).toBe('retry')
    expect(pending[0]?.attempt).toBe(2)
  })

  it('reports exact exponential-backoff timings and terminal outcomes from markFailed', () => {
    jest.useFakeTimers().setSystemTime(2_000_000)
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })

    // First retry after attempt 1: 2^1 seconds.
    queue.enqueue(makeItem({ taskId: 'a', attempt: 1, maxRetries: 3 }))
    expect(queue.markFailed('a', 'batch-1', true)).toEqual({
      retried: true,
      attempt: 2,
      nextAttemptAtMs: 2_002_000,
    })

    // maxRetries already consumed -> terminal, no retry.
    queue.enqueue(makeItem({ taskId: 'b', attempt: 1, maxRetries: 1 }))
    expect(queue.markFailed('b', 'batch-1', true)).toEqual({ retried: false })

    // Deterministic failure (non-retryable) -> terminal, no retry.
    queue.enqueue(makeItem({ taskId: 'c', attempt: 1, maxRetries: 3 }))
    expect(queue.markFailed('c', 'batch-1', false)).toEqual({ retried: false })

    jest.useRealTimers()
  })

  it('caps the exponential retry backoff at 5 minutes', () => {
    jest.useFakeTimers().setSystemTime(1_000_000)
    const queue = new TaskQueue({ maxConcurrent: 1, defaultMode: 'concurrent' })

    // 2^9 s = 512 s would exceed the 300 s cap — the retry must be scheduled
    // at most 5 minutes after the failed attempt.
    queue.enqueue(makeItem({ taskId: 'a', attempt: 9, maxRetries: 20 }))
    expect(queue.markFailed('a', 'batch-1', true)).toEqual({
      retried: true,
      attempt: 10,
      nextAttemptAtMs: 1_300_000,
    })
    expect(queue.getPendingTasks()[0]?.scheduleTime).toBe(1_300_000)

    jest.useRealTimers()
  })
})
