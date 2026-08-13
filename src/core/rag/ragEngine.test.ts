import type { QueryProgressState } from '../../components/chat-view/QueryProgress'
import {
  LLMAPIKeyNotSetException,
  LLMRateLimitExceededException,
} from '../llm/exception'

import { RAGEngine, dedupeRagQueryResults } from './ragEngine'
import type { RetrievalTrace } from './retrievalTraceTypes'
import {
  publishRetrievalTraceArrival,
  subscribeRetrievalTraceArrival,
} from './retrievalTraceBus'

jest.mock('./embedding', () => ({
  getEmbeddingModelClient: jest.fn(() => ({
    id: 'test-embedding-model',
    dimension: 3,
    getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  })),
}))

const baseSettings = {
  embeddingModelId: 'test-embedding-model',
  ragOptions: {
    chunkSize: 500,
    chunkOverlap: 50,
    excludePatterns: [],
    includePatterns: [],
    minSimilarity: 0.3,
    limit: 20,
  },
}

const waitForNextTick = async () =>
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

const createTraceStore = () => {
  const traces: RetrievalTrace[] = []
  return {
    traces,
    store: {
      insertTrace: jest.fn(async (trace: RetrievalTrace) => {
        traces.push(trace)
      }),
      flushPendingWrites: jest.fn(async () => undefined),
    },
  }
}

describe('RAGEngine', () => {
  it('dedupes duplicate query rows by path, line range, and content hash', () => {
    const rows = [
      {
        id: 1,
        path: 'a.md',
        mtime: 1,
        content: 'foo',
        content_hash: 'hash-1',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 10, endLine: 20 },
        similarity: 0.5,
      },
      {
        id: 2,
        path: 'a.md',
        mtime: 1,
        content: 'foo newer',
        content_hash: 'hash-2',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 10, endLine: 20 },
        similarity: 0.8,
      },
      {
        // Same range AND same content hash as row 1: a true duplicate (the
        // same chunk surfaced twice) — must collapse to the higher similarity.
        id: 4,
        path: 'a.md',
        mtime: 1,
        content: 'foo',
        content_hash: 'hash-1',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 10, endLine: 20 },
        similarity: 0.9,
      },
      {
        id: 3,
        path: 'b.md',
        mtime: 1,
        content: 'bar',
        content_hash: 'hash-3',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 30, endLine: 31 },
        similarity: 0.7,
      },
    ]

    // rows 1 and 2 share a line range but differ in content (sub-chunks of an
    // oversized block) — both must survive; row 4 is a true duplicate of
    // row 1 and collapses to the higher similarity (keeping row 1's position).
    expect(dedupeRagQueryResults(rows)).toEqual([rows[2], rows[1], rows[3]])
  })

  it('skips the configured rerank model when reranking is disabled', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'one',
            path: 'one.md',
            content: 'one',
            similarity: 0.9,
            metadata: { startLine: 1, endLine: 1 },
          },
          {
            id: 'two',
            path: 'two.md',
            content: 'two',
            similarity: 0.8,
            metadata: { startLine: 2, endLine: 2 },
          },
        ],
        trace: {},
      }),
    }
    const engine = new RAGEngine(
      {} as never,
      {
        ...baseSettings,
        ragOptions: { ...baseSettings.ragOptions, rerankEnabled: false },
      } as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )
    const rerank = jest.fn()
    ;(engine as unknown as { rerankModel: { rerank: jest.Mock } }).rerankModel =
      {
        rerank,
      }

    await engine.processQuery({ query: 'match me' })

    expect(rerank).not.toHaveBeenCalled()
  })

  it('returns raw vector candidates when rerank policy is none', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'one',
            path: 'one.md',
            content: 'one',
            similarity: 0.9,
            metadata: { startLine: 1, endLine: 1 },
          },
          {
            id: 'two',
            path: 'two.md',
            content: 'two',
            similarity: 0.7,
            metadata: { startLine: 2, endLine: 2 },
          },
        ],
        trace: {},
      }),
    }
    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )
    const rerank = jest.fn()
    ;(engine as unknown as { rerankModel: { rerank: jest.Mock } }).rerankModel =
      { rerank }

    const result = await engine.processQuery({
      query: 'match me',
      rerankPolicy: 'none',
    })

    expect(rerank).not.toHaveBeenCalled()
    expect(result.map((row) => row.similarity)).toEqual([0.9, 0.7])
  })

  it('aborts an in-flight embedding before vector search or rerank', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn(),
    }
    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )
    ;(
      engine as unknown as {
        embeddingModel: {
          id: string
          dimension: number
          getEmbedding: jest.Mock
        }
      }
    ).embeddingModel = {
      id: 'test-embedding-model',
      dimension: 3,
      getEmbedding: jest.fn(() => new Promise<number[]>(() => undefined)),
    }
    const abortController = new AbortController()
    const run = engine.processQuery({
      query: 'cancel me',
      signal: abortController.signal,
    })

    await waitForNextTick()
    abortController.abort()

    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(vectorManager.performSimilaritySearch).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent identical query embedding requests', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue([]),
    }
    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )
    const embedding = jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
    ;(
      engine as unknown as {
        embeddingModel: {
          id: string
          dimension: number
          getEmbedding: jest.Mock
        }
      }
    ).embeddingModel = {
      id: 'test-embedding-model',
      dimension: 3,
      getEmbedding: embedding,
    }

    await Promise.all([
      engine.processQuery({ query: 'same query' }),
      engine.processQuery({ query: 'same query' }),
    ])

    expect(embedding).toHaveBeenCalledTimes(1)
  })

  it('serializes updateVaultIndex calls across shared engine entrypoints', async () => {
    const updateEvents: string[] = []
    const resolvers: Array<() => void> = []
    const vectorManager = {
      reconcile: jest.fn().mockImplementation(
        async (
          _embeddingModel: unknown,
          _config: unknown,
          options: {
            truncate?: boolean
            onProgress?: (progress: unknown) => void
          },
        ) => {
          const tag = options.truncate ? 'rebuild' : 'sync'
          updateEvents.push(`start:${tag}`)
          options.onProgress?.({
            completedChunks: 0,
            totalChunks: 1,
            totalFiles: 1,
            completedFiles: 0,
          })

          await new Promise<void>((resolve) => {
            resolvers.push(() => {
              updateEvents.push(`end:${tag}`)
              resolve()
            })
          })
          return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
        },
      ),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )
    const progressEvents: QueryProgressState[] = []

    const firstRun = engine.updateVaultIndex(
      { scope: { kind: 'all' }, truncate: true },
      (progress) => progressEvents.push(progress),
    )
    const secondRun = engine.updateVaultIndex(
      { scope: { kind: 'all' }, truncate: false },
      (progress) => progressEvents.push(progress),
    )

    await waitForNextTick()
    expect(vectorManager.reconcile).toHaveBeenCalledTimes(1)
    expect(updateEvents).toEqual(['start:rebuild'])

    resolvers[0]?.()
    await firstRun
    await waitForNextTick()

    expect(vectorManager.reconcile).toHaveBeenCalledTimes(2)
    expect(updateEvents).toEqual(['start:rebuild', 'end:rebuild', 'start:sync'])

    resolvers[1]?.()
    await secondRun

    expect(updateEvents).toEqual([
      'start:rebuild',
      'end:rebuild',
      'start:sync',
      'end:sync',
    ])
    expect(progressEvents).toHaveLength(2)
    expect(progressEvents.every((event) => event.type === 'indexing')).toBe(
      true,
    )
  })

  it('passes chunkOverlap through to reconcile config', async () => {
    const vectorManager = {
      reconcile: jest.fn().mockResolvedValue({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      }),
      performSimilaritySearch: jest.fn(),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )

    await engine.updateVaultIndex({ scope: { kind: 'all' }, truncate: false })

    expect(vectorManager.reconcile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chunkSize: 500,
        chunkOverlap: 50,
      }),
      expect.anything(),
    )
  })

  it('processQuery preserves the current result shape when VectorManager maps RagStore hits', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'chunk-1',
            path: 'notes/a.md',
            mtime: 123,
            content: 'matched text',
            content_hash: 'chunk-1-hash',
            model: 'test-embedding-model',
            dimension: 3,
            metadata: { startLine: 4, endLine: 6, page: 2 },
            similarity: 0.91,
          },
        ],
        trace: {
          coarseSearchMs: 12,
          loadFullVectorsMs: 8,
          rerankSimilarityMs: 3,
        },
      }),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )

    const result = await engine.processQuery({ query: 'match me' })

    expect(vectorManager.performSimilaritySearch).toHaveBeenCalledTimes(1)
    expect(result).toEqual([
      {
        id: 'chunk-1',
        path: 'notes/a.md',
        mtime: 123,
        content: 'matched text',
        content_hash: 'chunk-1-hash',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 4, endLine: 6, page: 2 },
        similarity: 0.91,
      },
    ])
  })

  it('writes trace evidence with the original string hit ids', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'stable-chunk-id',
            path: 'notes/a.md',
            mtime: 123,
            content: 'matched text',
            content_hash: 'chunk-1-hash',
            model: 'test-embedding-model',
            dimension: 3,
            metadata: { startLine: 4, endLine: 6, page: 2 },
            similarity: 0.91,
          },
        ],
        trace: {
          coarseSearchMs: 12,
          loadFullVectorsMs: 8,
          rerankSimilarityMs: 3,
        },
      }),
    }
    const { traces, store } = createTraceStore()

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
      store,
    )

    await engine.processQuery({ query: 'match me' })
    await engine.flushPendingTraceWritesForTest()

    expect(traces).toHaveLength(1)
    expect(traces[0]?.evidence).toEqual([
      {
        id: 'stable-chunk-id',
        path: 'notes/a.md',
        score: 0.91,
      },
    ])
  })

  it('publishes a trace arrival after the trace row is persisted', async () => {
    const { traces, store } = createTraceStore()
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue([]),
    }
    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
      store,
    )

    const arrivals: RetrievalTrace[] = []
    const unsubscribe = subscribeRetrievalTraceArrival((trace) => {
      arrivals.push(trace)
    })
    try {
      await engine.processQuery({ query: 'match me' })
      await engine.flushPendingTraceWritesForTest()
    } finally {
      unsubscribe()
    }

    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]?.queryId).toBe(traces[0]?.queryId)
    expect(arrivals[0]?.queryText).toBe('match me')
  })

  it('does not publish a trace arrival without a trace store', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue([]),
    }
    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )

    const arrivals: RetrievalTrace[] = []
    const unsubscribe = subscribeRetrievalTraceArrival((trace) => {
      arrivals.push(trace)
    })
    try {
      await engine.processQuery({ query: 'match me' })
      await engine.flushPendingTraceWritesForTest()
    } finally {
      unsubscribe()
    }

    expect(arrivals).toHaveLength(0)
  })

  it('retries transient query embedding failures before searching', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue([]),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )

    let attempts = 0
    ;(
      engine as unknown as {
        embeddingModel: {
          id: string
          dimension: number
          getEmbedding: jest.Mock
        }
      }
    ).embeddingModel = {
      id: 'test-embedding-model',
      dimension: 3,
      getEmbedding: jest.fn(async () => {
        attempts += 1
        if (attempts < 3) {
          throw Object.assign(new Error('service unavailable'), { status: 503 })
        }
        return [0.1, 0.2, 0.3]
      }),
    }

    await expect(engine.processQuery({ query: 'retry me' })).resolves.toEqual(
      [],
    )

    expect(attempts).toBe(3)
    expect(vectorManager.performSimilaritySearch).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      expect.anything(),
      expect.objectContaining({
        minSimilarity: 0.3,
        limit: 20,
      }),
    )
  })

  it('does not retry permanent query embedding configuration failures', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue([]),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )
    const getEmbedding = jest
      .fn()
      .mockRejectedValue(new LLMAPIKeyNotSetException('missing key'))
    ;(
      engine as unknown as {
        embeddingModel: {
          id: string
          dimension: number
          getEmbedding: jest.Mock
        }
      }
    ).embeddingModel = {
      id: 'test-embedding-model',
      dimension: 3,
      getEmbedding,
    }

    await expect(engine.processQuery({ query: 'no retry' })).rejects.toThrow(
      /Embedding provider is not configured/i,
    )

    expect(getEmbedding).toHaveBeenCalledTimes(1)
    expect(vectorManager.performSimilaritySearch).not.toHaveBeenCalled()
  })

  it('writes one compact success trace with timing keys and evidence ids', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'chunk-1',
            path: 'notes/a.md',
            mtime: 123,
            content: 'matched text',
            content_hash: 'chunk-1-hash',
            model: 'test-embedding-model',
            dimension: 3,
            metadata: { startLine: 4, endLine: 6, page: 2 },
            similarity: 0.91,
          },
        ],
        trace: {
          coarseSearchMs: 12,
          loadFullVectorsMs: 8,
          rerankSimilarityMs: 3,
        },
      }),
    }
    const { traces, store } = createTraceStore()

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
      store,
    )

    await engine.processQuery({ query: 'match me' })
    await engine.flushPendingTraceWritesForTest()

    expect(store.insertTrace).toHaveBeenCalledTimes(1)
    expect(traces).toHaveLength(1)
    expect(traces[0]).toEqual(
      expect.objectContaining({
        backend: 'sqlite',
        modelId: 'test-embedding-model',
        namespaceId: 'test-embedding-model-d3',
        queryText: 'match me',
        warningCodes: [],
        evidence: [
          {
            id: 'chunk-1',
            path: 'notes/a.md',
            score: 0.91,
          },
        ],
      }),
    )
    expect(traces[0]?.queryId).toMatch(/^rq-\d+-[a-z0-9]+$/)
    expect(traces[0]?.startedAt).toEqual(expect.any(Number))
    expect(traces[0]?.finishedAt).toEqual(expect.any(Number))
    expect(traces[0]?.timingsMs).toEqual(
      expect.objectContaining({
        normalizeInput: expect.any(Number),
        resolveScope: expect.any(Number),
        embedQuery: expect.any(Number),
        searchBackend: expect.any(Number),
        coarseSearch: 12,
        loadFullVectors: 8,
        rerankSimilarity: 3,
        assembleEvidence: expect.any(Number),
        total: expect.any(Number),
      }),
    )
    expect(traces[0]).not.toHaveProperty('errorCode')
  })

  it('writes an empty_result warning trace without an error code', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue([]),
    }
    const { traces, store } = createTraceStore()

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
      store,
    )

    await expect(engine.processQuery({ query: 'no hits' })).resolves.toEqual([])
    await engine.flushPendingTraceWritesForTest()

    expect(traces).toHaveLength(1)
    expect(traces[0]).toEqual(
      expect.objectContaining({
        queryText: 'no hits',
        warningCodes: ['empty_result'],
        evidence: [],
      }),
    )
    expect(traces[0]).not.toHaveProperty('errorCode')
  })

  it.each([
    [
      'configuration_missing_key',
      new LLMAPIKeyNotSetException('OpenAI API key is not set'),
      'Embedding provider is not configured. Check the embedding model API key or base URL settings.',
    ],
    [
      'transient_rate_limited',
      new LLMRateLimitExceededException('Too many requests'),
      'Embedding provider is rate limited. Please retry in a moment.',
    ],
  ] as const)(
    'records a failed trace for %s query failures while preserving the friendly thrown message',
    async (expectedCode, rejection, expectedMessage) => {
      const vectorManager = {
        reconcile: jest.fn(),
        performSimilaritySearch: jest.fn(),
      }
      const { traces, store } = createTraceStore()

      const engine = new RAGEngine(
        {} as never,
        baseSettings as never,
        vectorManager as never,
        (_key, fallback) => fallback ?? '',
        store,
      )
      ;(
        engine as unknown as {
          embeddingModel: {
            id: string
            dimension: number
            getEmbedding: jest.Mock
          }
        }
      ).embeddingModel = {
        id: 'test-embedding-model',
        dimension: 3,
        getEmbedding: jest.fn().mockRejectedValue(rejection),
      }

      await expect(engine.processQuery({ query: 'match me' })).rejects.toThrow(
        expectedMessage,
      )
      await engine.flushPendingTraceWritesForTest()

      expect(traces).toHaveLength(1)
      expect(traces[0]).toEqual(
        expect.objectContaining({
          backend: 'sqlite',
          modelId: 'test-embedding-model',
          namespaceId: 'test-embedding-model-d3',
          queryText: 'match me',
          evidence: [],
          warningCodes: [],
          errorCode: expectedCode,
        }),
      )
      expect(vectorManager.performSimilaritySearch).not.toHaveBeenCalled()
    },
  )

  it('does not reject retrieval when trace persistence fails', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'chunk-1',
            path: 'notes/a.md',
            mtime: 123,
            content: 'matched text',
            content_hash: 'chunk-1-hash',
            model: 'test-embedding-model',
            dimension: 3,
            metadata: { startLine: 4, endLine: 6, page: 2 },
            similarity: 0.91,
          },
        ],
        trace: {
          coarseSearchMs: 12,
          loadFullVectorsMs: 8,
          rerankSimilarityMs: 3,
        },
      }),
    }
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const traceStore = {
      insertTrace: jest
        .fn<Promise<void>, [RetrievalTrace]>()
        .mockRejectedValue(new Error('trace insert failed')),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
      traceStore,
    )

    await expect(engine.processQuery({ query: 'match me' })).resolves.toEqual([
      {
        id: 'chunk-1',
        path: 'notes/a.md',
        mtime: 123,
        content: 'matched text',
        content_hash: 'chunk-1-hash',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 4, endLine: 6, page: 2 },
        similarity: 0.91,
      },
    ])
    await engine.flushPendingTraceWritesForTest()

    expect(traceStore.insertTrace).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('skips trace writes when diagnostics are disabled', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue([]),
    }
    const { store } = createTraceStore()

    const engine = new RAGEngine(
      {} as never,
      {
        ...baseSettings,
        ragOptions: {
          ...baseSettings.ragOptions,
          diagnosticsEnabled: false,
        },
      } as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
      store,
    )

    await engine.processQuery({ query: 'no traces please' })
    await engine.flushPendingTraceWritesForTest()

    expect(store.insertTrace).not.toHaveBeenCalled()
  })

  it('surfaces a friendly query error when embedding API key is missing', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn(),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )
    ;(
      engine as unknown as {
        embeddingModel: {
          id: string
          dimension: number
          getEmbedding: jest.Mock
        }
      }
    ).embeddingModel = {
      id: 'test-embedding-model',
      dimension: 3,
      getEmbedding: jest
        .fn()
        .mockRejectedValue(
          new LLMAPIKeyNotSetException('OpenAI API key is not set'),
        ),
    }

    await expect(engine.processQuery({ query: 'match me' })).rejects.toThrow(
      'Embedding provider is not configured. Check the embedding model API key or base URL settings.',
    )
    expect(vectorManager.performSimilaritySearch).not.toHaveBeenCalled()
  })

  it('surfaces a friendly query error when embedding provider is rate limited', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn(),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
    )
    ;(
      engine as unknown as {
        embeddingModel: {
          id: string
          dimension: number
          getEmbedding: jest.Mock
        }
      }
    ).embeddingModel = {
      id: 'test-embedding-model',
      dimension: 3,
      getEmbedding: jest
        .fn()
        .mockRejectedValue(
          new LLMRateLimitExceededException('Too many requests'),
        ),
    }

    await expect(engine.processQuery({ query: 'match me' })).rejects.toThrow(
      'Embedding provider is rate limited. Please retry in a moment.',
    )
    expect(vectorManager.performSimilaritySearch).not.toHaveBeenCalled()
  })

  it('records embedding retry diagnostics when query embedding succeeds after retry', async () => {
    const vectorManager = {
      reconcile: jest.fn(),
      performSimilaritySearch: jest.fn().mockResolvedValue([]),
    }
    const { traces, store } = createTraceStore()

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
      (_key, fallback) => fallback ?? '',
      store,
    )
    ;(
      engine as unknown as {
        embeddingModel: {
          id: string
          dimension: number
          getEmbedding: jest.Mock
        }
      }
    ).embeddingModel = {
      id: 'test-embedding-model',
      dimension: 3,
      getEmbedding: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        )
        .mockResolvedValueOnce([0.1, 0.2, 0.3]),
    }

    await engine.processQuery({ query: 'retry me' })
    await engine.flushPendingTraceWritesForTest()

    expect(traces).toHaveLength(1)
    expect(traces[0]?.diagnostic).toMatchObject({
      providerId: 'embedding',
      modelId: 'test-embedding-model',
      embeddingAttemptCount: 2,
      embeddingRetryCount: 1,
      embeddingRecoveredAfterRetry: true,
    })
  })
})
