import { MemoryExtractionQueue } from './memoryExtractionQueue'

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('MemoryExtractionQueue', () => {
  it('serializes extraction work for one assistant', async () => {
    const first = deferred()
    const started: string[] = []
    const queue = new MemoryExtractionQueue(async (task) => {
      started.push(task.id)
      if (task.id === 'first') await first.promise
    })

    queue.enqueue({ assistantId: 'a', id: 'first' })
    queue.enqueue({ assistantId: 'a', id: 'second' })
    await Promise.resolve()
    expect(started).toEqual(['first'])

    first.resolve()
    await queue.drain()
    expect(started).toEqual(['first', 'second'])
  })

  it('preserves pending work for the same assistant in FIFO order', async () => {
    const first = deferred()
    const started: string[] = []
    const queue = new MemoryExtractionQueue(async (task) => {
      started.push(task.id)
      if (task.id === 'first') await first.promise
    })

    queue.enqueue({ assistantId: 'a', id: 'first' })
    queue.enqueue({ assistantId: 'a', id: 'stale' })
    queue.enqueue({ assistantId: 'a', id: 'latest' })
    await Promise.resolve()
    first.resolve()
    await queue.drain()

    expect(started).toEqual(['first', 'stale', 'latest'])
  })

  it('does not make a foreground completion wait for extraction work', async () => {
    const extraction = deferred()
    const started: string[] = []
    const queue = new MemoryExtractionQueue(async (task) => {
      started.push(task.id)
      await extraction.promise
    })

    queue.enqueue({ assistantId: 'assistant-a', id: 'after-turn' })
    await Promise.resolve()

    await expect(Promise.resolve('foreground-complete')).resolves.toBe(
      'foreground-complete',
    )
    expect(started).toEqual(['after-turn'])

    extraction.resolve()
    await queue.drain()
  })

  it('runs different assistants independently', async () => {
    const first = deferred()
    const started: string[] = []
    const queue = new MemoryExtractionQueue(async (task) => {
      started.push(task.id)
      if (task.id === 'a') await first.promise
    })

    queue.enqueue({ assistantId: 'assistant-a', id: 'a' })
    queue.enqueue({ assistantId: 'assistant-b', id: 'b' })
    await Promise.resolve()

    expect(started).toEqual(['a', 'b'])
    first.resolve()
    await queue.drain()
  })

  it('limits active assistant lanes while allowing queued lanes to start as capacity frees', async () => {
    const releaseA = deferred()
    const releaseB = deferred()
    const started: string[] = []
    const queue = new MemoryExtractionQueue(async (task) => {
      started.push(task.id)
      if (task.id === 'a') await releaseA.promise
      if (task.id === 'b') await releaseB.promise
    }, 2)

    queue.enqueue({ assistantId: 'assistant-a', id: 'a' })
    queue.enqueue({ assistantId: 'assistant-b', id: 'b' })
    queue.enqueue({ assistantId: 'assistant-c', id: 'c' })
    await Promise.resolve()

    expect(started).toEqual(['a', 'b'])
    releaseA.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['a', 'b', 'c'])

    releaseB.resolve()
    await queue.drain()
  })

  it('cancels queued and active work during shutdown', async () => {
    const started = deferred()
    let activeSignal: AbortSignal | undefined
    const queue = new MemoryExtractionQueue(async (_task, signal) => {
      activeSignal = signal
      await started.promise
    })

    queue.enqueue({ assistantId: 'a', id: 'active' })
    queue.enqueue({ assistantId: 'a', id: 'queued' })
    await Promise.resolve()

    const shutdown = queue.shutdown(1)
    expect(activeSignal?.aborted).toBe(true)
    started.resolve()
    await shutdown
    await queue.drain()
  })

  it('clears the shutdown timeout when active work drains first', async () => {
    jest.useFakeTimers()
    try {
      const queue = new MemoryExtractionQueue(async () => undefined)
      queue.enqueue({ assistantId: 'a', id: 'active' })
      await Promise.resolve()

      await queue.shutdown(1_000)

      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
})
