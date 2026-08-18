import {
  getEmbeddingModelClient,
  withEmbeddingTimeout,
} from './embedding'

const mockGetEmbedding = jest.fn()

jest.mock('../llm/manager', () => ({
  getProviderClient: jest.fn(() => ({
    getEmbedding: mockGetEmbedding,
  })),
}))

const baseModel = {
  id: 'test/model',
  providerId: 'test-provider',
  model: 'text-embedding-test',
  name: 'Test Model',
  dimension: 1536,
}

const baseSettings: any = {
  providers: [{ id: 'test-provider' }],
  embeddingModels: [baseModel],
}

describe('getEmbeddingModelClient', () => {
  beforeEach(() => {
    mockGetEmbedding.mockReset()
  })

  it('(a) nativeDimension absent: calls provider without dimensions option', async () => {
    mockGetEmbedding.mockResolvedValue(new Array(1536).fill(0))

    const client = getEmbeddingModelClient({
      settings: baseSettings,
      embeddingModelId: 'test/model',
    })
    await client.getEmbedding('hello')

    expect(mockGetEmbedding).toHaveBeenCalledWith(
      'text-embedding-test',
      'hello',
      undefined,
    )
  })

  it('(b) dimension === nativeDimension: calls provider without dimensions option', async () => {
    const settings: any = {
      ...baseSettings,
      embeddingModels: [{ ...baseModel, nativeDimension: 1536 }],
    }

    mockGetEmbedding.mockResolvedValue(new Array(1536).fill(0))

    const client = getEmbeddingModelClient({
      settings,
      embeddingModelId: 'test/model',
    })
    await client.getEmbedding('hello')

    expect(mockGetEmbedding).toHaveBeenCalledWith(
      'text-embedding-test',
      'hello',
      undefined,
    )
  })

  it('(c) dimension !== nativeDimension: calls provider with { dimensions } option (also covers legacy data after EditEmbeddingModelModal backfills nativeDimension)', async () => {
    const settings: any = {
      ...baseSettings,
      embeddingModels: [
        { ...baseModel, dimension: 512, nativeDimension: 1536 },
      ],
    }

    mockGetEmbedding.mockResolvedValue(new Array(512).fill(0))

    const client = getEmbeddingModelClient({
      settings,
      embeddingModelId: 'test/model',
    })
    await client.getEmbedding('hello')

    expect(mockGetEmbedding).toHaveBeenCalledWith(
      'text-embedding-test',
      'hello',
      { dimensions: 512 },
    )
  })

  it('(d) throws when provider returns wrong vector length', async () => {
    mockGetEmbedding.mockResolvedValue(new Array(768).fill(0))

    const client = getEmbeddingModelClient({
      settings: baseSettings,
      embeddingModelId: 'test/model',
    })

    await expect(client.getEmbedding('hello')).rejects.toThrow(
      /returned 768-dimensional vector/,
    )
  })
})

describe('withEmbeddingTimeout', () => {
  beforeEach(() => {
    mockGetEmbedding.mockReset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('resolves with the vector when the provider responds in time', async () => {
    mockGetEmbedding.mockResolvedValue(new Array(1536).fill(0))
    const client = getEmbeddingModelClient({
      settings: baseSettings,
      embeddingModelId: 'test/model',
    })

    const resultPromise = withEmbeddingTimeout(client, 'hello', 100)
    await jest.advanceTimersByTimeAsync(50)
    await expect(resultPromise).resolves.toHaveLength(1536)
  })

  it('rejects on timeout when the provider never settles', async () => {
    mockGetEmbedding.mockImplementation(
      () => new Promise<number[]>(() => undefined),
    )
    const client = getEmbeddingModelClient({
      settings: baseSettings,
      embeddingModelId: 'test/model',
    })

    // Attach the assertion before advancing so the timeout rejection has a
    // handler the moment it fires (no unhandled-rejection flake).
    const resultPromise = withEmbeddingTimeout(client, 'hello', 100)
    const assertion = expect(resultPromise).rejects.toThrow(
      /timed out after 100ms/,
    )
    await jest.advanceTimersByTimeAsync(150)
    await assertion
  })

  it('a late provider response after timeout does not leak an unhandled rejection', async () => {
    let reject: ((reason: Error) => void) | undefined
    mockGetEmbedding.mockImplementation(
      () =>
        new Promise<number[]>((_resolve, rejectPromise) => {
          reject = rejectPromise
        }),
    )
    const client = getEmbeddingModelClient({
      settings: baseSettings,
      embeddingModelId: 'test/model',
    })

    const resultPromise = withEmbeddingTimeout(client, 'hello', 100)
    const assertion = expect(resultPromise).rejects.toThrow(/timed out/)
    await jest.advanceTimersByTimeAsync(150)
    await assertion
    // Simulate the provider settling after the race already timed out; the
    // loser promise must not produce an unhandled rejection.
    reject?.(new Error('late provider failure'))
    await Promise.resolve()
    await Promise.resolve()
  })
})
