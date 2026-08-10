import type {
  VectorBackendStats,
  VectorBackendStatus,
} from '../../database/modules/rag/VectorStore'

import type { RagIndexRunSnapshot } from './ragIndexService'
import type {
  RagIndexStatus,
  RetrievalInspectStatus,
  RetrievalTrace,
} from './retrievalTraceTypes'

const mapIndexStatus = (
  snapshot: RagIndexRunSnapshot,
): RagIndexStatus['status'] => {
  switch (snapshot.status) {
    case 'running':
      return 'indexing'
    case 'completed':
      return (snapshot.permanentFailedPaths?.length ?? 0) > 0
        ? 'degraded'
        : 'healthy'
    case 'failed':
      return 'failed'
    case 'idle':
    default:
      return 'idle'
  }
}

export function composeRetrievalInspectStatus(input: {
  backendStatus: VectorBackendStatus
  backendStats: VectorBackendStats | null
  indexSnapshot: RagIndexRunSnapshot
  latestTrace: RetrievalTrace | null
  namespaceId?: string
  modelId?: string
  embeddingDimension?: number
}): RetrievalInspectStatus {
  const { backendStatus, backendStats, indexSnapshot, latestTrace } = input
  const indexedFileCount = backendStats?.fileCount ?? 0
  const chunkCount = backendStats?.chunkCount ?? 0

  return {
    backend: backendStatus.backend,
    storagePath: backendStatus.storagePath || backendStats?.storagePath,
    executionMode: backendStatus.executionMode,
    persistenceMode: backendStatus.persistenceMode,
    namespaceId: input.namespaceId,
    modelId: input.modelId,
    embeddingDimension: input.embeddingDimension,
    chunkCount,
    indexedFileCount,
    lastIndexStatus: {
      status: mapIndexStatus(indexSnapshot),
      startedAt: indexSnapshot.startedAt ?? undefined,
      finishedAt: indexSnapshot.updatedAt ?? undefined,
      indexedFileCount,
      chunkCount,
      failedFiles: (indexSnapshot.permanentFailedPaths ?? []).map((path) => ({
        path,
        errorCode: 'rebuild_required',
      })),
      skippedFiles: [],
    },
    latestTrace: latestTrace ?? undefined,
    warningCodes: latestTrace?.warningCodes ?? [],
    errorCode: latestTrace?.errorCode,
    diagnostic: latestTrace?.diagnostic,
  }
}

export function buildFailedRetrievalInspectStatus(input: {
  error: unknown
  indexSnapshot: RagIndexRunSnapshot
  namespaceId?: string
  modelId?: string
  embeddingDimension?: number
}): RetrievalInspectStatus {
  const { error } = input

  return composeRetrievalInspectStatus({
    backendStatus: {
      backend: 'sqlite',
      readiness: 'open_failed',
      rebuildRequired: true,
      storagePath: '',
      executionMode: 'unsupported',
      persistenceMode: 'unsupported',
      recoveryAction: 'inspect_runtime_log',
    },
    backendStats: null,
    indexSnapshot: input.indexSnapshot,
    latestTrace: {
      queryId: 'rq-fallback-open-failed',
      backend: 'sqlite',
      modelId: input.modelId ?? 'unknown',
      namespaceId: input.namespaceId ?? 'unknown',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      timingsMs: {
        normalizeInput: 0,
        resolveScope: 0,
        embedQuery: 0,
        searchBackend: 0,
        assembleEvidence: 0,
        total: 0,
      },
      evidence: [],
      warningCodes: [],
      errorCode: 'open_failed',
      diagnostic: {
        backend: 'sqlite',
        modelId: input.modelId,
        recoveryAction: 'unsupported',
        message: error instanceof Error ? error.message : String(error),
      },
    },
    namespaceId: input.namespaceId,
    modelId: input.modelId,
    embeddingDimension: input.embeddingDimension,
  })
}
