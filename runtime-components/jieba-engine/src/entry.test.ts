export {}

type JiebaComponentApi = {
  cutForSearch(text: string): Promise<string[]>
  dispose(): void
}

type RegisteredDefinition = {
  id: string
  create: () => unknown
}

type FakeWorkerInstance = {
  onmessage: ((event: { data: WorkerResponseLike }) => void) | null
  onerror: ((event: { message: string }) => void) | null
  postMessage(request: unknown): void
  terminate(): void
  terminated: boolean
  requests: { id: number; text?: string }[]
  respondLatest(tokens: string[]): void
  respondReady(): void
}

type WorkerResponseLike =
  | { type: 'result'; id: number; tokens: string[] }
  | { type: 'error'; id: number; message: string }
  | { type: 'ready' }

class FakeWorker implements FakeWorkerInstance {
  onmessage: ((event: { data: WorkerResponseLike }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  terminated = false
  requests: { id: number; text?: string }[] = []
  respondLatest(tokens: string[]): void {
    const request = this.requests.at(-1)
    if (!request) throw new Error('no request posted')
    this.onmessage?.({ data: { type: 'result', id: request.id, tokens } })
  }
  respondReady(): void {
    this.onmessage?.({ data: { type: 'ready' } })
  }
  postMessage(request: unknown): void {
    // Default: never respond (simulates a wedged worker).
    this.requests.push(request as { id: number; text?: string })
  }
  terminate(): void {
    this.terminated = true
  }
}

const loadComponent = async (): Promise<JiebaComponentApi> => {
  jest.resetModules()
  let created: JiebaComponentApi | undefined
  const previous = globalThis.__yolo_register_runtime_component__
  globalThis.__yolo_register_runtime_component__ = (definition) => {
    created = definition.create() as JiebaComponentApi
  }
  try {
    await import('./entry')
  } finally {
    globalThis.__yolo_register_runtime_component__ = previous
  }
  if (!created) throw new Error('component not registered')
  return created
}

describe('jieba-engine runtime component', () => {
  const originalWorker = globalThis.Worker
  let workers: FakeWorkerInstance[]

  beforeEach(() => {
    workers = []
    ;(globalThis as { Worker?: unknown }).Worker = class extends FakeWorker {
      constructor() {
        super()
        workers.push(this)
      }
    }
  })

  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = originalWorker
    jest.useRealTimers()
  })

  it('registers its runtime component definition when loaded', async () => {
    let captured: RegisteredDefinition | undefined
    const previous = globalThis.__yolo_register_runtime_component__
    globalThis.__yolo_register_runtime_component__ = (definition) => {
      captured = definition
    }

    try {
      await import('./entry')
    } finally {
      globalThis.__yolo_register_runtime_component__ = previous
    }

    expect(captured).toEqual(
      expect.objectContaining({
        id: 'jieba-engine',
        create: expect.any(Function),
      }),
    )
  })

  it('resolves tokens from the worker response', async () => {
    const component = await loadComponent()
    const promise = component.cutForSearch('北京烤鸭')
    workers[0]?.respondReady()
    await Promise.resolve()
    workers[0]?.respondLatest(['北京', '烤鸭'])
    await expect(promise).resolves.toEqual(['北京', '烤鸭'])
  })

  it('rejects when the worker reports an error', async () => {
    const component = await loadComponent()
    const promise = component.cutForSearch('北京烤鸭')
    workers[0]?.respondReady()
    await Promise.resolve()
    const request = workers[0]?.requests.at(-1)
    workers[0]?.onmessage?.({
      data: { type: 'error', id: request?.id ?? 1, message: 'wasm exploded' },
    })
    await expect(promise).rejects.toThrow('wasm exploded')
  })

  it('rejects and recycles the worker when cutForSearch never responds', async () => {
    // Load the component before faking timers (dynamic import must run on
    // the real event loop).
    const component = await loadComponent()
    jest.useFakeTimers()

    // Attach the assertion before advancing so the timeout rejection has a
    // handler the moment it fires.
    const promise = component.cutForSearch('北京烤鸭')
    workers[0]?.respondReady()
    await jest.advanceTimersByTimeAsync(0)
    const assertion = expect(promise).rejects.toThrow(/timed out/)
    await jest.advanceTimersByTimeAsync(2_100)
    await assertion
    expect(workers[0]?.terminated).toBe(true)

    // The next call must start a fresh worker instead of reusing the wedged one.
    const retry = component.cutForSearch('again').catch(() => undefined)
    workers[1]?.respondReady()
    await jest.advanceTimersByTimeAsync(0)
    workers[1]?.respondLatest(['again'])
    await retry
    expect(workers).toHaveLength(2)
  })

  it('rejects ready waiters when the worker errors before becoming ready', async () => {
    const component = await loadComponent()
    const promise = component.cutForSearch('北京烤鸭')
    const assertion = expect(promise).rejects.toThrow(/worker error/)
    workers[0]?.onerror?.({ message: 'worker crashed' })
    await assertion
    expect(workers[0]?.terminated).toBe(true)
  })
})
