import type { RagIndexRunSnapshot } from './ragIndexService'
import {
  buildFailedRetrievalInspectStatus,
  composeRetrievalInspectStatus,
} from './retrievalInspectStatus'
import type {
  RetrievalInspectStatus,
  RetrievalTrace,
} from './retrievalTraceTypes'

const baseIndexSnapshot: RagIndexRunSnapshot = {
  runId: 'rag-1',
  trigger: 'manual',
  retryPolicy: 'transient',
  mode: 'sync',
  scopeKind: 'all',
  status: 'completed',
  startedAt: 1000,
  updatedAt: 2000,
  retryCount: 0,
  completedFiles: 4,
  completedChunks: 10,
  totalFiles: 4,
  totalChunks: 10,
  permanentFailedPaths: ['notes/bad.pdf'],
}

const baseTrace: RetrievalTrace = {
  queryId: 'rq-123-abc',
  backend: 'sqlite',
  modelId: 'text-embedding-3-large',
  namespaceId: 'embedding:text-embedding-3-large:1024',
  startedAt: 3000,
  finishedAt: 3250,
  timingsMs: {
    normalizeInput: 5,
    resolveScope: 10,
    embedQuery: 160,
    searchBackend: 40,
    assembleEvidence: 35,
    total: 250,
  },
  evidence: [
    {
      id: 'chunk-1',
      path: 'notes/good.md',
      score: 0.92,
    },
  ],
  warningCodes: ['partial_evidence'],
  errorCode: 'transient_network_failure',
  diagnostic: {
    backend: 'sqlite',
    filePath: 'notes/bad.pdf',
    recoveryAction: 'retry',
    message: 'network flake',
  },
}

describe('composeRetrievalInspectStatus', () => {
  it('projects backend stats, latest trace, failed file placeholders, and derived diagnostics', () => {
    const status = composeRetrievalInspectStatus({
      backendStatus: {
        backend: 'sqlite',
        readiness: 'ready',
        rebuildRequired: false,
        storagePath: '/vault/.obsidian/plugins/yolo/rag/sqlite.db',
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        recoveryAction: 'none',
      },
      backendStats: {
        backend: 'sqlite',
        storagePath: '/vault/.obsidian/plugins/yolo/rag/sqlite.db',
        namespaceCount: 1,
        fileCount: 42,
        chunkCount: 420,
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        usesWholeDatabaseSnapshot: false,
        ready: true,
      },
      indexSnapshot: baseIndexSnapshot,
      latestTrace: baseTrace,
      namespaceId: 'embedding:text-embedding-3-large:1024',
      modelId: 'text-embedding-3-large',
      embeddingDimension: 1024,
    })

    expect(status).toEqual<RetrievalInspectStatus>(
      expect.objectContaining({
        backend: 'sqlite',
        storagePath: '/vault/.obsidian/plugins/yolo/rag/sqlite.db',
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        namespaceId: 'embedding:text-embedding-3-large:1024',
        modelId: 'text-embedding-3-large',
        embeddingDimension: 1024,
        indexedFileCount: 42,
        chunkCount: 420,
        latestTrace: baseTrace,
        warningCodes: ['partial_evidence'],
        errorCode: 'transient_network_failure',
        diagnostic: {
          backend: 'sqlite',
          filePath: 'notes/bad.pdf',
          recoveryAction: 'retry',
          message: 'network flake',
        },
        lastIndexStatus: {
          status: 'degraded',
          startedAt: 1000,
          finishedAt: 2000,
          indexedFileCount: 42,
          chunkCount: 420,
          failedFiles: [
            {
              path: 'notes/bad.pdf',
              errorCode: 'rebuild_required',
            },
          ],
          skippedFiles: [],
        },
      }),
    )
  })

  it.each([
    ['running', undefined, 'indexing'],
    ['completed', [], 'healthy'],
    ['completed', ['notes/bad.pdf'], 'degraded'],
    ['failed', undefined, 'failed'],
    ['idle', undefined, 'idle'],
  ] as const)(
    'maps index snapshot status %s to %s',
    (snapshotStatus, permanentFailedPaths, expectedStatus) => {
      const status = composeRetrievalInspectStatus({
        backendStatus: {
          backend: 'sqlite',
          readiness: 'ready',
          rebuildRequired: false,
          storagePath: '/db.sqlite',
          executionMode: 'plugin-host',
          persistenceMode: 'native-sqlite-file',
          recoveryAction: 'none',
        },
        backendStats: null,
        indexSnapshot: {
          ...baseIndexSnapshot,
          status: snapshotStatus,
          updatedAt: 2222,
          permanentFailedPaths: permanentFailedPaths
            ? [...permanentFailedPaths]
            : undefined,
        },
        latestTrace: null,
      })

      expect(status.lastIndexStatus?.status).toBe(expectedStatus)
      expect(status.indexedFileCount).toBe(0)
      expect(status.chunkCount).toBe(0)
    },
  )

  it('builds failed-open fallback status with open_failed error details', () => {
    const status = buildFailedRetrievalInspectStatus({
      error: new Error('sqlite open exploded'),
      indexSnapshot: {
        ...baseIndexSnapshot,
        status: 'idle',
      },
      namespaceId: 'embedding:text-embedding-3-large:1024',
      modelId: 'text-embedding-3-large',
      embeddingDimension: 1024,
    })

    expect(status).toEqual(
      expect.objectContaining({
        backend: 'sqlite',
        executionMode: 'unsupported',
        persistenceMode: 'unsupported',
        errorCode: 'open_failed',
        diagnostic: expect.objectContaining({
          message: 'sqlite open exploded',
        }),
        latestTrace: expect.objectContaining({
          errorCode: 'open_failed',
        }),
      }),
    )
  })
})
