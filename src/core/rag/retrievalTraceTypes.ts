import type {
  VectorBackend,
  VectorExecutionMode,
  VectorPersistenceMode,
  VectorStoreErrorCode,
} from '../../database/modules/rag/VectorStore'

export type RetrievalTraceWarningCode =
  | 'scope_reduced'
  | 'degraded_runtime'
  | 'rebuild_required'
  | 'partial_evidence'
  | 'empty_result'

export type RetrievalTraceErrorCode =
  | VectorStoreErrorCode
  | 'configuration_missing_key'
  | 'configuration_invalid_base_url'
  | 'transient_timeout'
  | 'transient_rate_limited'
  | 'transient_network_failure'
  | 'index_missing_database'
  | 'runtime_worker_start_failed'
  | 'user_abort'

export type RetrievalTraceTimings = {
  normalizeInput: number
  resolveScope: number
  assembleEvidence: number
  total: number
  embedQuery?: number
  searchBackend?: number
  queryBackend?: number
  [key: string]: number | undefined
}

export type RetrievalTraceQueryRole =
  | 'user_query'
  | 'rewritten_query'
  | 'sub_query'

export type RetrievalRecoveryAction =
  | 'rebuild'
  | 'change_model'
  | 'check_network'
  | 'reconfigure_provider'
  | 'delete_corrupt_store'
  | 'retry'
  | 'unsupported'

export type RetrievalTraceDiagnostic = {
  providerId?: string
  modelId?: string
  backend?: VectorBackend
  indexPath?: string
  filePath?: string
  requestedDimension?: number
  returnedDimension?: number
  embeddingAttemptCount?: number
  embeddingRetryCount?: number
  embeddingRecoveredAfterRetry?: boolean
  embeddingAttemptDurationsMs?: number[]
  recoveryAction?: RetrievalRecoveryAction
  message?: string
  rerankModelId?: string
  rerankApplied?: boolean
  rerankError?: string
}

export type RetrievalTrace = {
  queryId: string
  backend: VectorBackend
  modelId: string
  namespaceId: string
  queryText?: string
  parentTraceId?: string
  stepLabel?: string
  queryRole?: RetrievalTraceQueryRole
  startedAt: number
  finishedAt?: number
  timingsMs: RetrievalTraceTimings
  evidence: Array<{ id: string; path: string; score?: number }>
  warningCodes: RetrievalTraceWarningCode[]
  errorCode?: RetrievalTraceErrorCode
  diagnostic?: RetrievalTraceDiagnostic
}

export type RetrievalOperationStatus = {
  ok: boolean
  startedAt?: number
  finishedAt?: number
  warningCodes: RetrievalTraceWarningCode[]
  errorCode?: RetrievalTraceErrorCode
  diagnostic?: RetrievalTraceDiagnostic
}

export type RagIndexStatus = {
  status: 'idle' | 'indexing' | 'healthy' | 'degraded' | 'failed'
  startedAt?: number
  finishedAt?: number
  indexedFileCount: number
  chunkCount: number
  failedFiles: Array<{
    path: string
    errorCode: RetrievalTraceErrorCode
    message?: string
  }>
  skippedFiles: Array<{ path: string; reason: string }>
  lastSuccessfulBackendOperation?: string
}

export type RetrievalInspectStatus = {
  backend: VectorBackend
  storagePath?: string
  executionMode: VectorExecutionMode
  persistenceMode: VectorPersistenceMode
  namespaceId?: string
  modelId?: string
  embeddingDimension?: number
  chunkCount: number
  indexedFileCount: number
  lastIndexStatus?: RagIndexStatus
  latestTrace?: RetrievalTrace
  warningCodes: RetrievalTraceWarningCode[]
  errorCode?: RetrievalTraceErrorCode
  diagnostic?: RetrievalTraceDiagnostic
}
