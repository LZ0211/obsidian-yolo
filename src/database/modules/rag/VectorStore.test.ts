import type { RetrievalTrace } from '../../../core/rag/retrievalTraceTypes'

import {
  type VectorBackendStats,
  type VectorBackendStatus,
  type VectorChunkWrite,
  type VectorFileWrite,
  type VectorHit,
  type VectorNamespace,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
  VectorStoreError,
} from './VectorStore'

describe('VectorStore contract', () => {
  it('VectorStoreError preserves code, backend, and recoveryAction', () => {
    const error = new VectorStoreError(
      'rebuild_required',
      'sqlite',
      'rebuild_index',
      'sqlite index needs rebuilding',
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('VectorStoreError')
    expect(error.code).toBe('rebuild_required')
    expect(error.backend).toBe('sqlite')
    expect(error.recoveryAction).toBe('rebuild_index')
    expect(error.message).toBe('sqlite index needs rebuilding')
  })

  it('defines the spec contract shapes', () => {
    const namespace: VectorNamespace = {
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimension: 1536,
      distanceMetric: 'cosine',
      embeddingEncoding: 'float32',
      tokenizer: 'cl100k_base',
    }
    const chunk: VectorChunkWrite = {
      chunkId: 'chunk-1',
      path: 'notes/a.md',
      text: 'chunk text',
      contentHash: 'hash-1',
      embedding: [0.1, 0.2, 0.3],
      location: {
        lineStart: 1,
        lineEnd: 3,
        blockId: 'block-1',
        headingPath: ['Heading'],
        page: 1,
      },
      metadataJson: { title: 'A' },
    }
    const file: VectorFileWrite = {
      path: 'notes/a.md',
      mtime: 123,
      contentHash: 'file-hash',
      chunks: [chunk],
    }
    const searchOptions: VectorSearchOptions = {
      topK: 5,
      minSimilarity: 0.75,
      scope: {
        files: ['notes/a.md'],
        folders: ['notes'],
      },
    }
    const hit: VectorHit = {
      id: 'hit-1',
      chunkId: chunk.chunkId,
      path: chunk.path,
      title: 'A',
      excerpt: chunk.text,
      score: 0.9,
      source: 'vector',
      location: chunk.location,
      metadataJson: chunk.metadataJson,
    }
    const vectorSearchResult: VectorSearchResult = {
      hits: [hit],
      timingsMs: {
        coarseSearch: 12,
        loadFullVectors: 8,
        rerankSimilarity: 3,
      },
    }
    const status: VectorBackendStatus = {
      backend: 'sqlite',
      readiness: 'ready',
      rebuildRequired: false,
      storagePath: '/tmp/rag.sqlite',
      executionMode: 'plugin-host',
      persistenceMode: 'native-sqlite-file',
      recoveryAction: 'none',
    }
    const stats: VectorBackendStats = {
      backend: 'sqlite',
      storagePath: '/tmp/rag.sqlite',
      fileSizeBytes: 1024,
      namespaceCount: 1,
      fileCount: 1,
      chunkCount: 1,
      executionMode: 'plugin-host',
      persistenceMode: 'native-sqlite-file',
      usesWholeDatabaseSnapshot: false,
      ready: true,
    }
    const store: VectorStore = {
      open: async () => undefined,
      close: async () => undefined,
      listNamespaces: async () => [],
      getIndexedFiles: async () => new Map(),
      replaceFile: async () => undefined,
      deleteFile: async () => undefined,
      clearNamespace: async () => undefined,
      vacuum: async () => ({ removedFiles: 0, removedChunks: 0 }),
      getStatus: async () => status,
      search: async () => ({
        hits: [hit],
        recallCount: 1,
        recallLimit: 5,
      }),
      searchDetailed: async () => vectorSearchResult,
      getStats: async () => stats,
    }

    expect(namespace.distanceMetric).toBe('cosine')
    expect(file.chunks[0]).toBe(chunk)
    expect(searchOptions.topK).toBe(5)
    expect(hit.source).toBe('vector')
    expect(store).toBeDefined()
  })

  it('accepts vector retrieval diagnostics without breaking trace fields', () => {
    const trace: RetrievalTrace = {
      queryId: 'trace-1',
      backend: 'sqlite',
      modelId: 'text-embedding-3-large',
      namespaceId: 'ns-123',
      queryText: 'semantic query',
      startedAt: Date.now(),
      timingsMs: {
        normalizeInput: 1,
        resolveScope: 1,
        embedQuery: 10,
        searchBackend: 20,
        assembleEvidence: 1,
        total: 32,
      },
      evidence: [],
      warningCodes: [],
      diagnostic: {
        providerId: 'provider-1',
        modelId: 'text-embedding-3-large',
        backend: 'sqlite',
        message: 'vector retrieval trace',
      },
    }

    expect(trace.diagnostic?.backend).toBe('sqlite')
    expect(trace.timingsMs.embedQuery).toBe(10)
  })
})
