import { WebRunScheduler } from './WebRunScheduler'

describe('WebRunScheduler', () => {
  it('starts no more than the configured number of runs', async () => {
    const scheduler = new WebRunScheduler({ maxConcurrent: 1 })
    const first = deferred<void>()
    const started: string[] = []

    scheduler.enqueue({
      runId: 'run-1',
      conversationId: 'conversation-1',
      execute: async () => {
        started.push('run-1')
        await first.promise
      },
    })
    scheduler.enqueue({
      runId: 'run-2',
      conversationId: 'conversation-2',
      execute: async () => {
        started.push('run-2')
      },
    })

    expect(started).toEqual(['run-1'])
    expect(scheduler.getRun('run-2')).toMatchObject({ status: 'queued' })

    first.resolve()
    await waitFor(() => scheduler.getRun('run-2')?.status === 'completed')

    expect(started).toEqual(['run-1', 'run-2'])
  })

  it('does not run two queued entries for one conversation together', async () => {
    const scheduler = new WebRunScheduler({ maxConcurrent: 2 })
    const first = deferred<void>()
    const started: string[] = []

    scheduler.enqueue({
      runId: 'run-1',
      conversationId: 'conversation-1',
      execute: async () => {
        started.push('run-1')
        await first.promise
      },
    })
    scheduler.enqueue({
      runId: 'run-2',
      conversationId: 'conversation-1',
      execute: async () => {
        started.push('run-2')
      },
    })

    expect(started).toEqual(['run-1'])
    first.resolve()
    await waitFor(() => scheduler.getRun('run-2')?.status === 'completed')

    expect(started).toEqual(['run-1', 'run-2'])
  })

  it('cancels a queued run without executing it', () => {
    const scheduler = new WebRunScheduler({ maxConcurrent: 1 })
    const first = deferred<void>()
    const execute = jest.fn(async () => undefined)

    scheduler.enqueue({
      runId: 'run-1',
      conversationId: 'conversation-1',
      execute: async () => first.promise,
    })
    scheduler.enqueue({
      runId: 'run-2',
      conversationId: 'conversation-2',
      execute,
    })

    expect(scheduler.abort('run-2')).toEqual({ found: true, status: 'aborted' })
    expect(execute).not.toHaveBeenCalled()
    expect(scheduler.getRun('run-2')).toMatchObject({ status: 'aborted' })
  })

  it('notifies terminal observers when a queued run is aborted', () => {
    const terminalRuns: string[] = []
    const scheduler = new WebRunScheduler({
      maxConcurrent: 1,
      onTerminal: (run) => terminalRuns.push(`${run.runId}:${run.status}`),
    })
    const first = deferred<void>()

    scheduler.enqueue({
      runId: 'run-1',
      conversationId: 'conversation-1',
      execute: async () => first.promise,
    })
    scheduler.enqueue({
      runId: 'run-2',
      conversationId: 'conversation-2',
      execute: async () => undefined,
    })

    scheduler.abort('run-2')

    expect(terminalRuns).toEqual(['run-2:aborted'])
    first.resolve()
  })

  it('releases capacity after a run fails', async () => {
    const scheduler = new WebRunScheduler({ maxConcurrent: 1 })
    const started: string[] = []

    scheduler.enqueue({
      runId: 'run-1',
      conversationId: 'conversation-1',
      execute: async () => {
        throw new Error('failed')
      },
    })
    scheduler.enqueue({
      runId: 'run-2',
      conversationId: 'conversation-2',
      execute: async () => {
        started.push('run-2')
      },
    })

    await waitFor(() => scheduler.getRun('run-2')?.status === 'completed')

    expect(scheduler.getRun('run-1')).toMatchObject({ status: 'error' })
    expect(started).toEqual(['run-2'])
  })

  it('starts queued runs when the concurrency limit increases', () => {
    const scheduler = new WebRunScheduler({ maxConcurrent: 1 })
    const first = deferred<void>()
    const second = deferred<void>()
    const started: string[] = []

    scheduler.enqueue({
      runId: 'run-1',
      conversationId: 'conversation-1',
      execute: async () => {
        started.push('run-1')
        await first.promise
      },
    })
    scheduler.enqueue({
      runId: 'run-2',
      conversationId: 'conversation-2',
      execute: async () => {
        started.push('run-2')
        await second.promise
      },
    })

    scheduler.setMaxConcurrent(2)

    expect(started).toEqual(['run-1', 'run-2'])
    first.resolve()
    second.resolve()
  })

  it('expires terminal entries after the retention TTL (E4)', async () => {
    let now = 1_000
    const scheduler = new WebRunScheduler({
      maxConcurrent: 1,
      now: () => now,
      finishedEntryTtlMs: 5_000,
    })

    scheduler.enqueue({
      runId: 'run-1',
      conversationId: 'conversation-1',
      execute: async () => undefined,
    })
    await waitFor(() => scheduler.getRun('run-1')?.status === 'completed')
    expect(scheduler.getRun('run-1')).not.toBeNull()

    // 未超 TTL：仍在。
    now = 5_999
    expect(scheduler.getRun('run-1')).not.toBeNull()

    // 超过 TTL：getRun 惰性清理并返回 null。
    now = 6_001
    expect(scheduler.getRun('run-1')).toBeNull()
  })

  it('keeps running entries regardless of elapsed time (E4)', async () => {
    let now = 1_000
    const scheduler = new WebRunScheduler({
      maxConcurrent: 1,
      now: () => now,
      finishedEntryTtlMs: 5_000,
    })
    const gate = deferred<void>()

    scheduler.enqueue({
      runId: 'run-1',
      conversationId: 'conversation-1',
      execute: async () => gate.promise,
    })
    now = 1_000_000
    expect(scheduler.getRun('run-1')?.status).toBe('running')
    gate.resolve()
    await waitFor(() => scheduler.getRun('run-1')?.status === 'completed')
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
