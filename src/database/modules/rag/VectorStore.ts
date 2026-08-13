export type VectorBackend = 'sqlite'

export type VectorNamespace = {
  provider: string
  model: string
  dimension: number
  distanceMetric: 'cosine'
  embeddingEncoding?: string
  tokenizer?: string
  corpus?: string
}

export type VectorFileWrite = {
  path: string
  mtime: number
  contentHash?: string
  chunks: VectorChunkWrite[]
}

export type MetadataKvRow = {
  key: string
  valueType: 'text' | 'number' | 'bool'
  value: string | number | boolean
}

export type VectorChunkWrite = {
  chunkId: string
  path: string
  text: string
  contentHash: string
  embedding: number[]
  location: {
    lineStart?: number
    lineEnd?: number
    blockId?: string
    headingPath?: string[]
    page?: number
  }
  metadataJson: Record<string, unknown>
}

export type VectorSearchOptions = {
  topK: number
  minSimilarity?: number
  minScore?: number
  signal?: AbortSignal
  scope?: {
    files?: string[]
    folders?: string[]
  }
}

export type VectorHit = {
  id: string
  chunkId: string
  path: string
  title?: string
  excerpt: string
  score: number
  source: 'vector' | 'lexical' | 'metadata' | 'hybrid'
  location: VectorChunkWrite['location']
  metadataJson: Record<string, unknown>
}

export type VectorStoreErrorCode =
  | 'not_open'
  | 'incompatible_schema'
  | 'unsupported'
  | 'open_failed'
  | 'close_failed'
  | 'dimension_mismatch'
  | 'namespace_mismatch'
  | 'database_corrupt'
  | 'transaction_failed'
  | 'cancelled'
  | 'rebuild_required'
  | 'operation_in_progress'
  | 'closing'
  | 'malformed_query'

export type VectorRecoveryAction =
  | 'none'
  | 'open_backend'
  | 'rebuild_index'
  | 'inspect_runtime_log'
  | 'retry_close'
  | 'vacuum_index'

export type VectorExecutionMode =
  | 'plugin-host'
  | 'background-worker'
  | 'serialized-background-queue'
  | 'unsupported'

export type VectorPersistenceMode = 'native-sqlite-file' | 'unsupported'

export type VectorBackendStatus = {
  backend: VectorBackend
  readiness: 'opening' | 'ready' | 'unsupported' | 'open_failed'
  rebuildRequired: boolean
  storagePath: string
  executionMode: VectorExecutionMode
  persistenceMode: VectorPersistenceMode
  recoveryAction: VectorRecoveryAction
}

export type VectorSearchTimings = {
  coarseSearch: number
  loadFullVectors: number
  rerankSimilarity: number
}

export type VectorSearchResult = {
  hits: VectorHit[]
  recallCount?: number
  recallLimit?: number
  totalCount?: number
  filteredCount?: number
  durationMs?: number
  timingsMs?: VectorSearchTimings
}

export type VectorBackendStats = {
  backend: VectorBackend
  storagePath: string
  fileSizeBytes?: number
  namespaceCount: number
  fileCount: number
  chunkCount: number
  executionMode: VectorExecutionMode
  persistenceMode: VectorPersistenceMode
  usesWholeDatabaseSnapshot: boolean
  ready: boolean
  errorCode?: VectorStoreErrorCode
}

export type VectorFileReadiness = {
  path: string
  vectorReady: boolean
}

export type StoredVectorChunk = {
  chunkId: string
  path: string
  contentHash: string
  embedding: number[]
  metadataJson: Record<string, unknown>
}

export type StoredVectorFile = {
  path: string
  contentHash?: string
  chunks: StoredVectorChunk[]
}

/**
 * Outcome of a `vacuum` compaction: `removedFiles` counts the files whose
 * every chunk was tombstoned (and is thus physically removed by the
 * rebuild); `removedChunks` counts the tombstoned chunk rows dropped.
 */
export type VectorVacuumResult = {
  removedFiles: number
  removedChunks: number
}

export class VectorStoreError extends Error {
  readonly code: VectorStoreErrorCode
  readonly backend: VectorBackend
  readonly recoveryAction: VectorRecoveryAction

  constructor(
    code: VectorStoreErrorCode,
    backend: VectorBackend,
    recoveryAction: VectorRecoveryAction,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'VectorStoreError'
    this.code = code
    this.backend = backend
    this.recoveryAction = recoveryAction
  }
}

export type VectorStore = {
  open(): Promise<void>
  close(): Promise<void>
  listNamespaces(): Promise<string[]>
  dropNamespace?(namespace: VectorNamespace): Promise<void>
  dropNamespaceById?(namespaceId: string): Promise<void>
  purgeNamespacesByPrefixForPrivacy?(input: {
    namespaceIdPrefix: string
    confirmation: string
  }): Promise<readonly string[]>
  getIndexedFiles?(
    namespace: VectorNamespace,
  ): Promise<
    Map<string, { mtime: number; contentHash?: string; updatedAt?: number }>
  >
  replaceFile(namespace: VectorNamespace, file: VectorFileWrite): Promise<void>
  replaceFiles?(
    namespace: VectorNamespace,
    files: VectorFileWrite[],
  ): Promise<void>
  deleteFile(namespace: VectorNamespace, path: string): Promise<void>
  deleteFiles?(namespace: VectorNamespace, paths: string[]): Promise<void>
  clearNamespace(namespace: VectorNamespace): Promise<void>
  save?(namespace?: VectorNamespace): Promise<void>
  vacuum(namespace?: VectorNamespace): Promise<VectorVacuumResult>
  getStatus(namespace?: VectorNamespace): Promise<VectorBackendStatus>
  /** Status for a concrete namespace directory id (see `listNamespaces`). */
  getStatusByNamespaceId?(namespaceId: string): Promise<VectorBackendStatus>
  search(
    namespace: VectorNamespace,
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult>
  searchDetailed?(
    namespace: VectorNamespace,
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult>
  getStoredFileVectors?(
    namespace: VectorNamespace,
    paths: readonly string[],
  ): Promise<Map<string, StoredVectorFile>>
  getQueryEmbedding?(
    namespace: VectorNamespace,
    queryHash: string,
  ): Promise<number[] | null>
  putQueryEmbedding?(
    namespace: VectorNamespace,
    queryHash: string,
    embedding: number[],
  ): Promise<void>
  getStats(namespace?: VectorNamespace): Promise<VectorBackendStats>
  getFileReadiness?(
    namespace: VectorNamespace,
    paths: string[],
  ): Promise<Map<string, VectorFileReadiness>>
}

export type VectorNamespaceMaintenance = {
  dropNamespace(namespace: VectorNamespace): Promise<void>
  dropNamespaceById(namespaceId: string): Promise<void>
  purgeNamespacesByPrefixForPrivacy(input: {
    namespaceIdPrefix: string
    confirmation: string
  }): Promise<readonly string[]>
  close(): Promise<void>
}
