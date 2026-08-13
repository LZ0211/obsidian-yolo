import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  type SqliteNativeRuntimeFacade,
  openSqliteRuntime,
} from '../../sqlite/sqliteNativeRuntime'

import { getSqliteDbPath, getSqliteNamespaceDir } from './backendPaths'
import { vectorNamespaceId } from './namespaceId'
import {
  QUERY_EMBEDDING_CACHE_MAX_ENTRIES,
  decodeQueryEmbedding,
  encodeQueryEmbedding,
} from './queryEmbeddingCache'
import {
  SQLITE_COARSE_DIMENSION,
  SQLITE_SCHEMA_VERSION,
  buildClearNamespaceSql,
  buildSchemaMigrationSql,
  buildUserVersionCheckSql,
  validateNamespaceForSqlite,
} from './SqliteSchema'
import { mapSqliteRowToVectorHit } from './vectorHitMapper'
import {
  type StoredVectorFile,
  type VectorBackendStats,
  type VectorBackendStatus,
  type VectorFileReadiness,
  type VectorFileWrite,
  type VectorNamespace,
  type VectorNamespaceMaintenance,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
  type VectorVacuumResult,
  VectorStoreError,
} from './VectorStore'

type SqliteVectorStoreOptions = {
  baseDir: string
}

type NamespaceRuntimeState = {
  runtime: SqliteNativeRuntimeFacade
  namespaceId: string
  dbPath: string
  statements?: NamespaceStatements
  nextChunkRowid?: number
  coarseCache?: CoarseCache
  coarseCachePrewarmTimer?: ReturnType<typeof setTimeout>
  activeReaders: number
  writerActive: boolean
  pendingWriters: number
  gateWaiters: NamespaceGateWaiter[]
  idleWaiters: Array<() => void>
  closing: boolean
}

type NamespaceGateWaiter = {
  kind: 'read' | 'write'
  resolve: () => void
  reject: (error: unknown) => void
}

type PreparedStatement = ReturnType<SqliteNativeRuntimeFacade['prepare']>

type NamespaceStatements = {
  insertChunk: PreparedStatement
  insertEmbedding: PreparedStatement
  insertCoarseEmbedding: PreparedStatement
}

type CoarseCacheRow = {
  rowid: number
  coarse: Float32Array
}

type CoarseCache = {
  rows: CoarseCacheRow[]
  memoryBytes: number
}

type NamespaceRow = {
  provider?: string
  model?: string
  dimension: number
  distance_metric?: VectorNamespace['distanceMetric']
  embedding_encoding?: string | null
  tokenizer?: string | null
}

type IndexedFileRow = {
  path: string
  mtime: number
  content_hash: string | null
  updated_at: number | null
}

type CountRow = {
  count: number
}

type TableExistsRow = {
  name: string
}

type SearchRow = {
  id: string
  chunk_id: string
  path: string
  excerpt: string
  embedding: Uint8Array
  line_start: number | null
  line_end: number | null
  block_id: string | null
  heading_path_json: string | null
  page: number | null
  metadata_json: string
}

type StoredVectorRow = {
  file_path: string
  file_content_hash: string | null
  chunk_id: string
  chunk_path: string
  chunk_content_hash: string
  embedding: Uint8Array
  metadata_json: string
  chunk_rowid: number
}

type ScopeSql = {
  clause: string
  params: string[]
}

const COARSE_CANDIDATE_MULTIPLIER = 50
const COARSE_MIN_CANDIDATES = 500
const MAX_COARSE_CACHE_BYTES = 64 * 1024 * 1024
const COARSE_CACHE_PREWARM_DEBOUNCE_MS = 150
const VECTOR_PRIVACY_PURGE_CONFIRMATION = 'PURGE_RELATION_HISTORY'
const MAX_STORED_VECTOR_PATHS = 256

function hashHex32(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function fileIdFor(namespaceKey: string, filePath: string): string {
  return hashHex32(`${namespaceKey}\0${filePath}`)
}

function normalizeVector(
  embedding: number[],
  dimension: number,
  code: 'dimension_mismatch' | 'transaction_failed',
): number[] {
  if (embedding.length !== dimension) {
    throw new VectorStoreError(
      code,
      'sqlite',
      code === 'dimension_mismatch' ? 'rebuild_index' : 'none',
      `Expected embedding dimension ${dimension} but received ${embedding.length}`,
    )
  }

  let magnitude = 0
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new VectorStoreError(
        code,
        'sqlite',
        'none',
        'Embedding contains a non-finite value',
      )
    }
    magnitude += value * value
  }

  if (magnitude === 0) {
    throw new VectorStoreError(
      code,
      'sqlite',
      'none',
      'Embedding magnitude must be greater than zero',
    )
  }

  const length = Math.sqrt(magnitude)
  return embedding.map((value) => value / length)
}

function vectorBlob(embedding: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(embedding).buffer)
}

function corruptStoreError(message: string): VectorStoreError {
  return new VectorStoreError(
    'database_corrupt',
    'sqlite',
    'rebuild_index',
    message,
  )
}

function vectorFromBlob(
  value: Uint8Array,
  expectedDimension: number,
  label: 'full' | 'coarse',
): Float32Array {
  if (value.byteLength % 4 !== 0) {
    throw corruptStoreError(
      `${label} embedding blob has invalid byte length ${value.byteLength}`,
    )
  }

  const actualDimension = value.byteLength / 4
  if (actualDimension !== expectedDimension) {
    throw corruptStoreError(
      `${label} embedding dimension mismatch: expected ${expectedDimension}, received ${actualDimension}`,
    )
  }

  const vector = new Float32Array(
    value.buffer,
    value.byteOffset,
    actualDimension,
  )
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw corruptStoreError(`${label} embedding contains a non-finite value`)
    }
  }
  return vector
}

function coarseVector(embedding: number[]): number[] {
  return normalizeVector(
    embedding.slice(0, Math.min(SQLITE_COARSE_DIMENSION, embedding.length)),
    Math.min(SQLITE_COARSE_DIMENSION, embedding.length),
    'transaction_failed',
  )
}

function cosineScore(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number {
  let dot = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
  }
  return dot
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function assertSafeRowid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VectorStoreError(
      'transaction_failed',
      'sqlite',
      'inspect_runtime_log',
      `Invalid chunk rowid ${String(value)}`,
    )
  }
  return value
}

export class SqliteVectorStore
  implements VectorStore, VectorNamespaceMaintenance
{
  private readonly baseDir: string
  private readonly namespaceStates = new Map<string, NamespaceRuntimeState>()
  private isOpen = false
  private isClosing = false
  private writeQueue: Promise<void> = Promise.resolve()
  private lifecycleQueue: Promise<void> = Promise.resolve()

  constructor(options: SqliteVectorStoreOptions) {
    this.baseDir = options.baseDir
  }

  async open(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      if (this.isOpen || this.isClosing) return
      this.isClosing = false
      this.isOpen = true
      this.scheduleExistingNamespacePrewarm()
    })
  }

  async close(): Promise<void> {
    this.isClosing = true
    await this.enqueueLifecycle(async () => {
      if (!this.isOpen && this.namespaceStates.size === 0) {
        this.isClosing = false
        return
      }
      await this.writeQueue.catch(() => undefined)
      const states = [...this.namespaceStates.values()]
      for (const state of states) {
        state.closing = true
        this.rejectNamespaceWaiters(state)
      }
      await Promise.all(states.map((state) => this.waitForNamespaceIdle(state)))
      for (const state of states) {
        this.clearScheduledCoarseCachePrewarm(state)
        state.runtime.close()
      }
      this.namespaceStates.clear()
      this.isOpen = false
      this.isClosing = false
    })
  }

  private enqueueLifecycle<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.lifecycleQueue.then(work, work)
    this.lifecycleQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async listNamespaces(): Promise<string[]> {
    this.assertOpen()
    this.assertNotClosing()
    const ragDir = path.join(this.baseDir, 'rag')
    if (!fs.existsSync(ragDir)) return []
    return fs
      .readdirSync(ragDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((entry) => fs.existsSync(getSqliteDbPath(this.baseDir, entry)))
      .sort()
  }

  async dropNamespace(namespace: VectorNamespace): Promise<void> {
    await this.dropNamespaceById(vectorNamespaceId(namespace))
  }

  async dropNamespaceById(namespaceKey: string): Promise<void> {
    const validatedId = validateNamespaceIdForFilesystem(
      this.baseDir,
      namespaceKey,
    )
    await this.enqueueWrite(async () => {
      const namespaceDir = getSafeNamespaceTarget(this.baseDir, validatedId)
      const state = this.namespaceStates.get(validatedId)
      const directoryExists = fs.existsSync(namespaceDir)
      if (!directoryExists && state == null) return
      if (directoryExists && !fs.statSync(namespaceDir).isDirectory()) {
        throw new VectorStoreError(
          'transaction_failed',
          'sqlite',
          'inspect_runtime_log',
          `Namespace target is not a directory: ${validatedId}`,
        )
      }
      if (state != null) {
        state.closing = true
        this.rejectNamespaceWaiters(state)
        await this.waitForNamespaceIdle(state)
        this.clearScheduledCoarseCachePrewarm(state)
        state.runtime.close()
        this.namespaceStates.delete(validatedId)
      }
      if (directoryExists) {
        fs.rmSync(namespaceDir, { recursive: true, force: true })
      }
    })
  }

  async purgeNamespacesByPrefixForPrivacy(input: {
    namespaceIdPrefix: string
    confirmation: string
  }): Promise<readonly string[]> {
    if (input.confirmation !== VECTOR_PRIVACY_PURGE_CONFIRMATION) {
      throw new Error(
        `vector namespace purge requires ${VECTOR_PRIVACY_PURGE_CONFIRMATION}`,
      )
    }
    const prefix = validateNamespacePrefix(input.namespaceIdPrefix)
    return this.enqueueSerialized(async () => {
      const ragDir = path.resolve(this.baseDir, 'rag')
      if (!fs.existsSync(ragDir)) return []
      const entries = fs
        .readdirSync(ragDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((entry) => entry.startsWith(prefix))
      const deleted: string[] = []
      for (const entry of entries) {
        const validatedId = validateNamespaceIdForFilesystem(
          this.baseDir,
          entry,
        )
        const namespaceDir = getSafeNamespaceTarget(this.baseDir, validatedId)
        if (!fs.existsSync(namespaceDir)) continue
        if (!fs.statSync(namespaceDir).isDirectory()) {
          throw new VectorStoreError(
            'transaction_failed',
            'sqlite',
            'inspect_runtime_log',
            `Namespace target is not a directory: ${validatedId}`,
          )
        }
        const state = this.namespaceStates.get(validatedId)
        if (state != null) {
          state.closing = true
          this.rejectNamespaceWaiters(state)
          await this.waitForNamespaceIdle(state)
          this.clearScheduledCoarseCachePrewarm(state)
          state.runtime.close()
          this.namespaceStates.delete(validatedId)
        }
        fs.rmSync(namespaceDir, { recursive: true, force: true })
        deleted.push(validatedId)
      }
      return deleted.sort()
    })
  }

  async getStoredFileVectors(
    namespace: VectorNamespace,
    paths: readonly string[],
  ): Promise<Map<string, StoredVectorFile>> {
    const uniquePaths = [...new Set(paths.map(normalizeVectorFilePath))]
    if (uniquePaths.length > MAX_STORED_VECTOR_PATHS) {
      throw new VectorStoreError(
        'malformed_query',
        'sqlite',
        'none',
        `getStoredFileVectors accepts at most ${MAX_STORED_VECTOR_PATHS} paths`,
      )
    }
    if (uniquePaths.length === 0) return new Map()
    const state = this.getNamespaceState(namespace)
    const release = await this.acquireNamespaceReadLease(state)
    try {
      const rows = state.runtime.transaction((runtime) => {
        runtime.exec(
          'create temporary table if not exists rag_requested_vector_paths(path text primary key, ordinal integer not null)',
        )
        runtime.exec('delete from rag_requested_vector_paths')
        const insertPath = runtime.prepare(
          'insert into rag_requested_vector_paths(path, ordinal) values (?, ?)',
        )
        uniquePaths.forEach((filePath, ordinal) => {
          insertPath.run(filePath, ordinal)
        })
        return runtime.query<StoredVectorRow>(
          `
            select
              requested.path as file_path,
              rf.content_hash as file_content_hash,
              rc.chunk_id,
              rc.path as chunk_path,
              rc.content_hash as chunk_content_hash,
              re.embedding,
              rc.metadata_json,
              rc.rowid as chunk_rowid
            from rag_requested_vector_paths requested
            inner join rag_files rf
              on rf.path = requested.path and rf.namespace_id = ?
            inner join rag_chunks rc on rc.file_id = rf.id
            inner join rag_embeddings re on re.rowid = rc.rowid
            order by requested.ordinal, rc.rowid
          `,
          [state.namespaceId],
        )
      })
      const files = new Map<string, StoredVectorFile>()
      for (const row of rows) {
        const file =
          files.get(row.file_path) ??
          ({
            path: row.file_path,
            contentHash: row.file_content_hash ?? undefined,
            chunks: [],
          } satisfies StoredVectorFile)
        file.chunks.push({
          chunkId: row.chunk_id,
          path: row.chunk_path,
          contentHash: row.chunk_content_hash,
          embedding: Array.from(
            vectorFromBlob(row.embedding, namespace.dimension, 'full'),
          ),
          metadataJson: parseStoredMetadata(row.metadata_json),
        })
        files.set(row.file_path, file)
      }
      return files
    } finally {
      release()
    }
  }

  async getIndexedFiles(
    namespace: VectorNamespace,
  ): Promise<Map<string, { mtime: number; contentHash?: string }>> {
    const state = this.getNamespaceState(namespace)
    const release = await this.acquireNamespaceReadLease(state)
    try {
      const rows = state.runtime.query<IndexedFileRow>(
        'select path, mtime, content_hash, updated_at from rag_files order by path',
      )
      return new Map(
        rows.map((row) => [
          row.path,
          {
            mtime: row.mtime,
            contentHash: row.content_hash ?? undefined,
            updatedAt: row.updated_at ?? undefined,
          },
        ]),
      )
    } finally {
      release()
    }
  }

  async replaceFile(
    namespace: VectorNamespace,
    file: VectorFileWrite,
  ): Promise<void> {
    await this.replaceFiles(namespace, [file])
  }

  async replaceFiles(
    namespace: VectorNamespace,
    files: VectorFileWrite[],
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = this.getNamespaceState(namespace)
      const validatedNamespace = validateNamespaceForSqlite(namespace)
      const release = await this.acquireNamespaceWriteLease(state)
      try {
        state.runtime.transaction(() => {
          this.upsertNamespace(state, validatedNamespace)
          if (files.length > 1) {
            this.deleteFilesInTransaction(
              state,
              files.map((file) => file.path),
              { keepFileRows: true },
            )
          }
          for (const file of files) {
            this.replaceFileInTransaction(state, validatedNamespace, file, {
              skipDelete: files.length > 1,
            })
          }
        })
        state.coarseCache = undefined
        this.scheduleCoarseCachePrewarm(state)
      } catch (error) {
        throw this.asStoreError(
          error,
          'transaction_failed',
          files.length === 1 ? 'replaceFile failed' : 'replaceFiles failed',
        )
      } finally {
        release()
      }
    })
  }

  async deleteFile(
    namespace: VectorNamespace,
    filePath: string,
  ): Promise<void> {
    await this.deleteFiles(namespace, [filePath])
  }

  async deleteFiles(
    namespace: VectorNamespace,
    filePaths: string[],
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = this.getNamespaceState(namespace)
      const release = await this.acquireNamespaceWriteLease(state)
      try {
        state.runtime.transaction(() => {
          this.upsertNamespace(state, namespace)
          this.deleteFilesInTransaction(state, filePaths)
        })
        state.coarseCache = undefined
        this.scheduleCoarseCachePrewarm(state)
      } catch (error) {
        throw this.asStoreError(
          error,
          'transaction_failed',
          filePaths.length === 1 ? 'deleteFile failed' : 'deleteFiles failed',
        )
      } finally {
        release()
      }
    })
  }

  async clearNamespace(namespace: VectorNamespace): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = this.getNamespaceState(namespace)
      const release = await this.acquireNamespaceWriteLease(state)
      try {
        state.runtime.transaction(() => {
          this.upsertNamespace(state, namespace)
          for (const sql of buildClearNamespaceSql()) {
            state.runtime.exec(sql, [state.namespaceId])
          }
          state.nextChunkRowid = 1
          state.coarseCache = undefined
          this.clearScheduledCoarseCachePrewarm(state)
        })
      } catch (error) {
        throw this.asStoreError(
          error,
          'transaction_failed',
          'clearNamespace failed',
        )
      } finally {
        release()
      }
    })
  }

  async vacuum(namespace?: VectorNamespace): Promise<VectorVacuumResult> {
    this.assertOpen()
    if (this.isClosing) {
      throw new VectorStoreError('closing', 'sqlite', 'retry_close')
    }
    if (namespace == null) {
      // Desktop VACUUM is a per-namespace SQLite command; the sharded
      // backend's "all namespaces" mode has no desktop equivalent.
      return { removedFiles: 0, removedChunks: 0 }
    }
    await this.enqueueWrite(async () => {
      const state = this.getNamespaceState(namespace)
      const release = await this.acquireNamespaceWriteLease(state)
      try {
        state.runtime.exec('vacuum')
      } finally {
        release()
      }
    })
    // The desktop store keeps no tombstone accounting: rows are deleted
    // physically at write time, so compaction removes nothing extra.
    return { removedFiles: 0, removedChunks: 0 }
  }

  async getStatus(namespace?: VectorNamespace): Promise<VectorBackendStatus> {
    this.assertOpen()
    this.assertNotClosing()
    // Aggregate (namespace-less) status has no single database file. The old
    // `<namespace>` placeholder looked like a real path and made the
    // maintenance explorer open (and CREATE) a garbage SQLite file at a
    // path that does not exist — the empty path instead makes such callers
    // fail fast with "RAG database is unavailable" before touching the fs.
    if (namespace == null) {
      return {
        backend: 'sqlite',
        readiness: 'ready',
        rebuildRequired: false,
        storagePath: '',
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        recoveryAction: 'none',
      }
    }

    const storagePath = getSqliteDbPath(this.baseDir, vectorNamespaceId(namespace))
    if (!fs.existsSync(storagePath)) {
      return {
        backend: 'sqlite',
        readiness: 'ready',
        rebuildRequired: true,
        storagePath,
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        recoveryAction: 'rebuild_index',
      }
    }

    return {
      backend: 'sqlite',
      readiness: 'ready',
      rebuildRequired: false,
      storagePath,
      executionMode: 'plugin-host',
      persistenceMode: 'native-sqlite-file',
      recoveryAction: 'none',
    }
  }

  /**
   * Status for a concrete namespace directory (as listed by
   * `listNamespaces()`). `getStatus(namespace)` takes a `VectorNamespace`
   * object, which callers holding only the namespace id cannot construct.
   */
  async getStatusByNamespaceId(
    namespaceId: string,
  ): Promise<VectorBackendStatus> {
    this.assertOpen()
    this.assertNotClosing()
    const storagePath = getSqliteDbPath(this.baseDir, namespaceId)
    if (!fs.existsSync(storagePath)) {
      return {
        backend: 'sqlite',
        readiness: 'ready',
        rebuildRequired: true,
        storagePath,
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        recoveryAction: 'rebuild_index',
      }
    }
    return {
      backend: 'sqlite',
      readiness: 'ready',
      rebuildRequired: false,
      storagePath,
      executionMode: 'plugin-host',
      persistenceMode: 'native-sqlite-file',
      recoveryAction: 'none',
    }
  }

  async getQueryEmbedding(
    namespace: VectorNamespace,
    queryHash: string,
  ): Promise<number[] | null> {
    const state = this.getNamespaceState(namespace)
    const row = state.runtime.queryOne<{
      embedding: Uint8Array
      dimension: number
    }>(
      'select embedding, dimension from query_embedding_cache where model_id = ? and query_hash = ?',
      [namespace.model, queryHash],
    )
    if (
      !row ||
      row.dimension !== namespace.dimension ||
      row.dimension !== row.embedding.byteLength / 4
    ) {
      return null
    }
    void this.enqueueWrite(() => {
      state.runtime.exec(
        'update query_embedding_cache set last_accessed_at_ms = ? where model_id = ? and query_hash = ?',
        [Date.now(), namespace.model, queryHash],
      )
    }).catch(() => undefined)
    return decodeQueryEmbedding(row.embedding)
  }

  async putQueryEmbedding(
    namespace: VectorNamespace,
    queryHash: string,
    embedding: number[],
  ): Promise<void> {
    await this.enqueueWrite(() => {
      const state = this.getNamespaceState(namespace)
      const now = Date.now()
      state.runtime.exec(
        'insert into query_embedding_cache(model_id, query_hash, dimension, embedding, created_at_ms, last_accessed_at_ms) values (?, ?, ?, ?, ?, ?) on conflict(model_id, query_hash) do update set embedding = excluded.embedding, dimension = excluded.dimension, last_accessed_at_ms = excluded.last_accessed_at_ms',
        [
          namespace.model,
          queryHash,
          embedding.length,
          encodeQueryEmbedding(embedding),
          now,
          now,
        ],
      )
      state.runtime.exec(
        `delete from query_embedding_cache where rowid in (
          select rowid from query_embedding_cache
          order by last_accessed_at_ms desc
          limit -1 offset ?
        )`,
        [QUERY_EMBEDDING_CACHE_MAX_ENTRIES],
      )
    })
  }

  async search(
    namespace: VectorNamespace,
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult> {
    return this.searchDetailed(namespace, embedding, options)
  }

  async searchDetailed(
    namespace: VectorNamespace,
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult> {
    this.assertOpen()
    this.assertNotClosing()
    throwIfVectorSearchAborted(options.signal)
    const namespaceKey = vectorNamespaceId(
      validateNamespaceForSqlite(namespace),
    )
    const dbPath = getSqliteDbPath(this.baseDir, namespaceKey)
    if (!fs.existsSync(dbPath)) {
      throw new VectorStoreError(
        'rebuild_required',
        'sqlite',
        'rebuild_index',
        'The active RAG namespace does not have an index database yet.',
      )
    }

    const state = this.getNamespaceState(namespace)
    const release = await this.acquireNamespaceReadLease(state)
    try {
      throwIfVectorSearchAborted(options.signal)
      const normalizedEmbedding = normalizeVector(
        embedding,
        namespace.dimension,
        'dimension_mismatch',
      )
      const retrievalMode = (
        options as VectorSearchOptions & { retrievalMode?: unknown }
      ).retrievalMode
      if (retrievalMode != null && retrievalMode !== 'vector') {
        const receivedMode =
          typeof retrievalMode === 'string'
            ? retrievalMode
            : (JSON.stringify(retrievalMode) ?? typeof retrievalMode)
        throw new VectorStoreError(
          'unsupported',
          'sqlite',
          'none',
          `SQLite VectorStore only supports vector retrieval, received ${receivedMode}.`,
        )
      }
      if (options.topK <= 0) return { hits: [] }

      // Warm the coarse cache before the first yield point so concurrent
      // searches on the same namespace never race on cold-cache rebuild.
      // Without this, a search whose embedding returns first pays the full
      // table-scan cost while a later-arriving search on the same namespace
      // gets the hot cache for free — producing order-dependent timing.
      // getCoarseCache() is synchronous; call it here before the await so
      // the first search to enter searchDetailed() always warms the cache
      // before yielding.
      this.getCoarseCache(state)

      const maxCandidates = await this.countSearchCandidates(state, options)
      throwIfVectorSearchAborted(options.signal)
      if (maxCandidates === 0) {
        // An empty namespace still needs a rebuild, but an empty *scope*
        // inside a populated namespace is a legitimate empty result — a query
        // scoped to a folder that has no indexed chunks must return nothing,
        // not fail with "rebuild the index".
        if (options.scope != null) {
          const totalChunks =
            state.runtime.queryOne<CountRow>(
              'select count(*) as count from rag_chunks',
            )?.count ?? 0
          if (totalChunks > 0) {
            return { hits: [], timingsMs: undefined }
          }
        }
        throw new VectorStoreError(
          'rebuild_required',
          'sqlite',
          'rebuild_index',
          'The active RAG namespace does not contain any indexed chunks yet.',
        )
      }
      const candidateK = Math.min(
        maxCandidates,
        Math.max(
          options.topK,
          Math.min(
            COARSE_MIN_CANDIDATES,
            options.topK * COARSE_CANDIDATE_MULTIPLIER,
          ),
        ),
      )

      const coarseSearchStart = Date.now()
      const candidateRowids = this.coarseTopK(
        state,
        normalizedEmbedding,
        candidateK,
        options,
      )
      throwIfVectorSearchAborted(options.signal)
      const coarseSearch = Date.now() - coarseSearchStart
      if (candidateRowids.length === 0) {
        return {
          hits: [],
          timingsMs: {
            coarseSearch,
            loadFullVectors: 0,
            rerankSimilarity: 0,
          },
        }
      }
      const loadFullVectorsStart = Date.now()
      const rows = this.loadSearchRows(state, candidateRowids)
      throwIfVectorSearchAborted(options.signal)
      const loadFullVectors = Date.now() - loadFullVectorsStart
      const rerankSimilarityStart = Date.now()
      const reranked = rows
        .map((row) => ({
          ...row,
          score: cosineScore(
            normalizedEmbedding,
            vectorFromBlob(row.embedding, namespace.dimension, 'full'),
          ),
        }))
        .filter(
          (row) =>
            options.minSimilarity == null || row.score >= options.minSimilarity,
        )
        .sort(
          (left, right) =>
            right.score - left.score || left.id.localeCompare(right.id),
        )
        .slice(0, options.topK)
      const rerankSimilarity = Date.now() - rerankSimilarityStart
      throwIfVectorSearchAborted(options.signal)

      return {
        hits: reranked.map((row) =>
          mapSqliteRowToVectorHit({
            ...row,
            source: 'vector',
          }),
        ),
        recallCount: reranked.length,
        recallLimit: candidateK,
        totalCount: maxCandidates,
        filteredCount: rows.length - reranked.length,
        durationMs: coarseSearch + loadFullVectors + rerankSimilarity,
        timingsMs: {
          coarseSearch,
          loadFullVectors,
          rerankSimilarity,
        },
      }
    } finally {
      release()
    }
  }

  async getStats(namespace?: VectorNamespace): Promise<VectorBackendStats> {
    if (namespace == null) {
      const namespaces = this.isOpen
        ? await this.listNamespaces().catch(() => [])
        : []
      return {
        backend: 'sqlite',
        storagePath: getSqliteNamespaceDir(this.baseDir, '<namespace>'),
        namespaceCount: namespaces.length,
        fileCount: 0,
        chunkCount: 0,
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        usesWholeDatabaseSnapshot: false,
        ready: this.isOpen,
      }
    }

    try {
      const state = this.getNamespaceState(namespace)
      const fileCount =
        state.runtime.queryOne<CountRow>(
          'select count(*) as count from rag_files',
        )?.count ?? 0
      const chunkCount =
        state.runtime.queryOne<CountRow>(
          'select count(*) as count from rag_chunks',
        )?.count ?? 0
      return {
        backend: 'sqlite',
        storagePath: state.dbPath,
        fileSizeBytes: fs.existsSync(state.dbPath)
          ? fs.statSync(state.dbPath).size
          : undefined,
        namespaceCount: 1,
        fileCount,
        chunkCount,
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        usesWholeDatabaseSnapshot: false,
        ready: true,
      }
    } catch (error) {
      if (error instanceof VectorStoreError) {
        return {
          backend: 'sqlite',
          storagePath: getSqliteDbPath(
            this.baseDir,
            vectorNamespaceId(namespace),
          ),
          namespaceCount: 0,
          fileCount: 0,
          chunkCount: 0,
          executionMode: 'plugin-host',
          persistenceMode: 'native-sqlite-file',
          usesWholeDatabaseSnapshot: false,
          ready: false,
          errorCode: error.code,
        }
      }
      throw error
    }
  }

  async getFileReadiness(
    namespace: VectorNamespace,
    paths: string[],
  ): Promise<Map<string, VectorFileReadiness>> {
    this.assertOpen()
    this.assertNotClosing()
    const uniquePaths = [...new Set(paths)]
    const readiness = new Map<string, VectorFileReadiness>(
      uniquePaths.map((path) => [path, { path, vectorReady: false }]),
    )
    if (uniquePaths.length === 0) {
      return readiness
    }

    const state = this.getNamespaceState(namespace)
    const placeholders = uniquePaths.map(() => '?').join(', ')
    const rows = state.runtime.query<{
      path: string
      chunk_count: number
    }>(
      `
        select
          rf.path,
          count(rc.rowid) as chunk_count
        from rag_files rf
        left join rag_chunks rc on rc.file_id = rf.id
        where rf.namespace_id = ? and rf.path in (${placeholders})
        group by rf.path
      `,
      [state.namespaceId, ...uniquePaths],
    )

    for (const row of rows) {
      const chunkCount = row.chunk_count
      const vectorReady = chunkCount > 0
      readiness.set(row.path, {
        path: row.path,
        vectorReady,
      })
    }
    return readiness
  }

  private assertOpen() {
    if (!this.isOpen) {
      throw new VectorStoreError('not_open', 'sqlite', 'open_backend')
    }
  }

  private assertNotClosing() {
    if (this.isClosing) {
      throw new VectorStoreError('closing', 'sqlite', 'retry_close')
    }
  }

  private getNamespaceState(namespace: VectorNamespace): NamespaceRuntimeState {
    this.assertOpen()
    this.assertNotClosing()
    const validatedNamespace = validateNamespaceForSqlite(namespace)
    const namespaceKey = vectorNamespaceId(validatedNamespace)
    const existing = this.namespaceStates.get(namespaceKey)
    if (existing != null) return existing

    const dbPath = getSqliteDbPath(this.baseDir, namespaceKey)
    const state: NamespaceRuntimeState = {
      runtime: openSqliteRuntime({ dbPath }),
      namespaceId: namespaceKey,
      dbPath,
      activeReaders: 0,
      writerActive: false,
      pendingWriters: 0,
      gateWaiters: [],
      idleWaiters: [],
      closing: false,
    }
    try {
      this.ensureSchema(state, validatedNamespace)
    } catch (error) {
      state.runtime.close()
      throw error
    }
    this.namespaceStates.set(namespaceKey, state)
    return state
  }

  private getExistingNamespaceState(
    namespaceKey: string,
  ): NamespaceRuntimeState {
    this.assertOpen()
    this.assertNotClosing()
    const existing = this.namespaceStates.get(namespaceKey)
    if (existing != null) return existing

    const dbPath = getSqliteDbPath(this.baseDir, namespaceKey)
    const state: NamespaceRuntimeState = {
      runtime: openSqliteRuntime({ dbPath }),
      namespaceId: namespaceKey,
      dbPath,
      activeReaders: 0,
      writerActive: false,
      pendingWriters: 0,
      gateWaiters: [],
      idleWaiters: [],
      closing: false,
    }
    try {
      const tableRow = state.runtime.queryOne<TableExistsRow>(
        `
          select name
          from sqlite_master
          where type = 'table' and name = 'rag_namespaces'
        `,
      )
      if (tableRow == null) {
        throw new VectorStoreError(
          'incompatible_schema',
          'sqlite',
          'rebuild_index',
          `Namespace database ${namespaceKey} is missing rag_namespaces table`,
        )
      }
      const namespaceRow = state.runtime.queryOne<NamespaceRow>(
        `
          select provider, model, dimension, distance_metric, embedding_encoding, tokenizer
          from rag_namespaces
          where id = ?
        `,
        [namespaceKey],
      )
      if (
        namespaceRow == null ||
        !namespaceRow.provider ||
        !namespaceRow.model
      ) {
        throw corruptStoreError(`Missing namespace row for ${namespaceKey}`)
      }
      this.ensureSchema(state, {
        provider: namespaceRow.provider,
        model: namespaceRow.model,
        dimension: namespaceRow.dimension,
        distanceMetric: namespaceRow.distance_metric ?? 'cosine',
        embeddingEncoding: namespaceRow.embedding_encoding ?? undefined,
        tokenizer: namespaceRow.tokenizer ?? undefined,
      })
    } catch (error) {
      state.runtime.close()
      throw error
    }
    this.namespaceStates.set(namespaceKey, state)
    return state
  }

  private ensureSchema(
    state: NamespaceRuntimeState,
    namespace: VectorNamespace,
    options: { inTransaction?: boolean } = {},
  ) {
    const apply = (runtime: SqliteNativeRuntimeFacade): void => {
      const versionRow = runtime.queryOne<Record<string, number>>(
        buildUserVersionCheckSql(),
      )
      const userVersion =
        versionRow?.user_version ?? versionRow?.pragma_user_version ?? 0
      if (userVersion > SQLITE_SCHEMA_VERSION) {
        throw new VectorStoreError(
          'incompatible_schema',
          'sqlite',
          'rebuild_index',
          `Unsupported schema version ${userVersion}`,
        )
      }

      for (const sql of buildSchemaMigrationSql(
        userVersion,
        namespace,
        state.namespaceId,
      )) {
        runtime.exec(sql)
      }

      const namespaceRow = runtime.queryOne<NamespaceRow>(
        'select dimension from rag_namespaces where id = ?',
        [state.namespaceId],
      )
      if (
        namespaceRow != null &&
        namespaceRow.dimension !== namespace.dimension
      ) {
        throw new VectorStoreError(
          'namespace_mismatch',
          'sqlite',
          'rebuild_index',
          `Namespace ${state.namespaceId} dimension mismatch`,
        )
      }
    }

    if (options.inTransaction) {
      apply(state.runtime)
    } else {
      state.runtime.transaction(apply)
    }
  }

  private upsertNamespace(
    state: NamespaceRuntimeState,
    namespace: VectorNamespace,
  ) {
    this.ensureSchema(state, namespace, { inTransaction: true })
  }

  private replaceFileInTransaction(
    state: NamespaceRuntimeState,
    namespace: VectorNamespace,
    file: VectorFileWrite,
    options: { skipDelete?: boolean } = {},
  ) {
    const fileId = fileIdFor(state.namespaceId, file.path)
    state.runtime.exec(
      `
        insert into rag_files(
          id, namespace_id, path, mtime, content_hash
        )
        values (?, ?, ?, ?, ?)
        on conflict(id) do update set
          namespace_id = excluded.namespace_id,
          path = excluded.path,
          mtime = excluded.mtime,
          content_hash = excluded.content_hash,
          updated_at = unixepoch()
      `,
      [
        fileId,
        state.namespaceId,
        file.path,
        file.mtime,
        file.contentHash ?? null,
      ],
    )
    if (!options.skipDelete) this.deleteFileRows(state, fileId)
    const statements = this.getStatements(state)
    for (const chunk of file.chunks) {
      const normalizedEmbedding = normalizeVector(
        chunk.embedding,
        namespace.dimension,
        'transaction_failed',
      )
      const chunkRowid = this.allocateChunkRowid(state)
      statements.insertChunk.run(
        chunkRowid,
        chunk.chunkId,
        fileId,
        chunk.chunkId,
        chunk.path,
        chunk.text,
        chunk.contentHash,
        chunk.location.lineStart ?? null,
        chunk.location.lineEnd ?? null,
        chunk.location.blockId ?? null,
        chunk.location.headingPath == null
          ? null
          : JSON.stringify(chunk.location.headingPath),
        chunk.location.page ?? null,
        JSON.stringify(chunk.metadataJson),
      )
      statements.insertEmbedding.run(
        chunkRowid,
        vectorBlob(normalizedEmbedding),
      )
      statements.insertCoarseEmbedding.run(
        chunkRowid,
        vectorBlob(coarseVector(normalizedEmbedding)),
        chunk.chunkId,
        fileId,
      )
    }
  }

  private deleteFileRows(state: NamespaceRuntimeState, fileId: string) {
    state.runtime.exec(
      'delete from rag_coarse_embeddings where rowid in (select rowid from rag_chunks where file_id = ?)',
      [fileId],
    )
    state.runtime.exec(
      'delete from rag_embeddings where rowid in (select rowid from rag_chunks where file_id = ?)',
      [fileId],
    )
    state.runtime.exec('delete from rag_chunks where file_id = ?', [fileId])
  }

  private deleteFilesInTransaction(
    state: NamespaceRuntimeState,
    filePaths: string[],
    options: { keepFileRows?: boolean } = {},
  ) {
    if (filePaths.length === 0) return
    if (filePaths.length === 1) {
      const fileId = fileIdFor(state.namespaceId, filePaths[0])
      this.deleteFileRows(state, fileId)
      if (!options.keepFileRows) {
        state.runtime.exec('delete from rag_files where id = ?', [fileId])
      }
      return
    }
    state.runtime.exec(
      'create temporary table if not exists rag_delete_file_ids(id text primary key)',
    )
    state.runtime.exec('delete from rag_delete_file_ids')
    const insertDeleteFileId = state.runtime.prepare(
      'insert into rag_delete_file_ids(id) values (?)',
    )
    for (const filePath of filePaths) {
      insertDeleteFileId.run(fileIdFor(state.namespaceId, filePath))
    }
    state.runtime.exec(`
      delete from rag_coarse_embeddings
      where rowid in (
        select rc.rowid
        from rag_chunks rc
        inner join rag_delete_file_ids d on d.id = rc.file_id
      )
    `)
    state.runtime.exec(`
      delete from rag_embeddings
      where rowid in (
        select rc.rowid
        from rag_chunks rc
        inner join rag_delete_file_ids d on d.id = rc.file_id
      )
    `)
    state.runtime.exec(
      'delete from rag_chunks where file_id in (select id from rag_delete_file_ids)',
    )
    if (!options.keepFileRows) {
      state.runtime.exec(
        'delete from rag_files where id in (select id from rag_delete_file_ids)',
      )
    }
    state.runtime.exec('delete from rag_delete_file_ids')
  }

  private allocateChunkRowid(state: NamespaceRuntimeState): number {
    if (state.nextChunkRowid == null) {
      const row = state.runtime.queryOne<{ rowid: number | null }>(
        'select max(rowid) as rowid from rag_chunks',
      )
      state.nextChunkRowid = assertSafeRowid((row?.rowid ?? 0) + 1)
    }
    const rowid = assertSafeRowid(state.nextChunkRowid)
    state.nextChunkRowid += 1
    return rowid
  }

  private getStatements(state: NamespaceRuntimeState): NamespaceStatements {
    if (state.statements != null) return state.statements
    state.statements = {
      insertChunk: state.runtime.prepare(`
        insert into rag_chunks(
          rowid, id, file_id, chunk_id, path, text, content_hash,
          line_start, line_end, block_id, heading_path_json, page, metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertEmbedding: state.runtime.prepare(
        'insert into rag_embeddings(rowid, embedding) values (?, ?)',
      ),
      insertCoarseEmbedding: state.runtime.prepare(
        'insert into rag_coarse_embeddings(rowid, embedding, chunk_id, file_id) values (?, ?, ?, ?)',
      ),
    }
    return state.statements
  }

  private getCoarseCache(state: NamespaceRuntimeState): CoarseCache | null {
    if (state.coarseCache != null) return state.coarseCache
    const count =
      state.runtime.queryOne<CountRow>(
        'select count(*) as count from rag_coarse_embeddings',
      )?.count ?? 0
    const memoryBytes = count * Math.min(SQLITE_COARSE_DIMENSION, 4096) * 4
    if (memoryBytes > MAX_COARSE_CACHE_BYTES) return null
    const expectedCoarseDimension = Math.min(
      SQLITE_COARSE_DIMENSION,
      this.getNamespaceDimension(state),
    )
    const rows = state.runtime
      .query<{
        rowid: number
        embedding: Uint8Array
      }>('select rowid, embedding from rag_coarse_embeddings')
      .map((row) => ({
        rowid: Number(row.rowid),
        coarse: vectorFromBlob(
          row.embedding,
          expectedCoarseDimension,
          'coarse',
        ),
      }))
    state.coarseCache = { rows, memoryBytes }
    return state.coarseCache
  }

  private scheduleCoarseCachePrewarm(state: NamespaceRuntimeState): void {
    this.clearScheduledCoarseCachePrewarm(state)
    state.coarseCachePrewarmTimer = setTimeout(() => {
      state.coarseCachePrewarmTimer = undefined
      if (!this.isOpen || this.isClosing) {
        return
      }
      try {
        if (state.coarseCache == null) {
          this.getCoarseCache(state)
        }
      } catch (error) {
        console.warn('[YOLO] Failed to prewarm SQLite RAG coarse cache', error)
      }
    }, COARSE_CACHE_PREWARM_DEBOUNCE_MS)
  }

  private clearScheduledCoarseCachePrewarm(state: NamespaceRuntimeState): void {
    if (state.coarseCachePrewarmTimer != null) {
      clearTimeout(state.coarseCachePrewarmTimer)
      state.coarseCachePrewarmTimer = undefined
    }
  }

  private scheduleExistingNamespacePrewarm(): void {
    const ragDir = path.join(this.baseDir, 'rag')
    if (!fs.existsSync(ragDir)) {
      return
    }
    for (const entry of fs.readdirSync(ragDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }
      const dbPath = getSqliteDbPath(this.baseDir, entry.name)
      if (!fs.existsSync(dbPath)) {
        continue
      }
      try {
        const state = this.getExistingNamespaceState(entry.name)
        this.scheduleCoarseCachePrewarm(state)
      } catch (error) {
        if (
          error instanceof VectorStoreError &&
          error.code === 'incompatible_schema'
        ) {
          continue
        }
        console.warn(
          '[YOLO] Failed to schedule SQLite RAG coarse cache prewarm for existing namespace',
          entry.name,
          error,
        )
      }
    }
  }

  private coarseTopK(
    state: NamespaceRuntimeState,
    normalizedEmbedding: number[],
    candidateK: number,
    options: VectorSearchOptions,
  ): number[] {
    const scopedRowids = this.getScopedRowids(state, options)
    if (scopedRowids?.size === 0) return []
    const query = coarseVector(normalizedEmbedding)
    const cache = this.getCoarseCache(state)
    const rows =
      cache?.rows ??
      state.runtime
        .query<{
          rowid: number
          embedding: Uint8Array
        }>('select rowid, embedding from rag_coarse_embeddings')
        .map((row) => ({
          rowid: Number(row.rowid),
          coarse: vectorFromBlob(row.embedding, query.length, 'coarse'),
        }))

    return rows
      .filter((row) => scopedRowids == null || scopedRowids.has(row.rowid))
      .map((row) => ({
        rowid: row.rowid,
        score: cosineScore(query, row.coarse),
      }))
      .sort(
        (left, right) => right.score - left.score || left.rowid - right.rowid,
      )
      .slice(0, candidateK)
      .map((row) => row.rowid)
  }

  private getScopedRowids(
    state: NamespaceRuntimeState,
    options: VectorSearchOptions,
  ): Set<number> | null {
    if (options.scope == null) return null
    const files = uniqueNormalized(options.scope.files ?? [])
    const folders = uniqueNormalized(options.scope.folders ?? []).map(
      (folder) => folder.replace(/\/+$/g, ''),
    )
    if (files.length === 0 && folders.length === 0) return null
    const { clause, params } = this.buildScopeSqlFromNormalized(files, folders)
    return new Set(
      state.runtime
        .query<{ rowid: number }>(
          `
            select rc.rowid
            from rag_chunks rc
            inner join rag_files rf on rf.id = rc.file_id
            where ${clause}
          `,
          params,
        )
        .map((row) => Number(row.rowid)),
    )
  }

  private buildScopeSql(options: VectorSearchOptions): ScopeSql | null {
    if (options.scope == null) return null
    const files = uniqueNormalized(options.scope.files ?? [])
    const folders = uniqueNormalized(options.scope.folders ?? []).map(
      (folder) => folder.replace(/\/+$/g, ''),
    )
    if (files.length === 0 && folders.length === 0) return null
    return this.buildScopeSqlFromNormalized(files, folders)
  }

  private buildScopeSqlFromNormalized(
    files: string[],
    folders: string[],
  ): ScopeSql {
    const clauses: string[] = []
    const params: string[] = []
    if (files.length > 0) {
      clauses.push(`rf.path in (${files.map(() => '?').join(', ')})`)
      params.push(...files)
    }
    if (folders.length > 0) {
      clauses.push(folders.map(() => "rf.path like ? escape '\\'").join(' or '))
      params.push(...folders.map((folder) => `${escapeLikePattern(folder)}/%`))
    }
    return { clause: clauses.join(' or '), params }
  }

  private async acquireNamespaceReadLease(
    state: NamespaceRuntimeState,
  ): Promise<() => void> {
    this.assertOpen()
    this.assertNotClosing()
    if (state.closing) {
      throw new VectorStoreError('closing', 'sqlite', 'retry_close')
    }
    if (!state.writerActive && state.pendingWriters === 0) {
      state.activeReaders += 1
      return () => this.releaseNamespaceReadLease(state)
    }
    return new Promise<() => void>((resolve, reject) => {
      state.gateWaiters.push({
        kind: 'read',
        resolve: () => {
          state.activeReaders += 1
          resolve(() => this.releaseNamespaceReadLease(state))
        },
        reject,
      })
      this.drainNamespaceGate(state)
    })
  }

  private async acquireNamespaceWriteLease(
    state: NamespaceRuntimeState,
  ): Promise<() => void> {
    this.assertOpen()
    this.assertNotClosing()
    if (state.closing) {
      throw new VectorStoreError('closing', 'sqlite', 'retry_close')
    }
    state.pendingWriters += 1
    return new Promise<() => void>((resolve, reject) => {
      state.gateWaiters.push({
        kind: 'write',
        resolve: () => {
          state.pendingWriters -= 1
          state.writerActive = true
          resolve(() => this.releaseNamespaceWriteLease(state))
        },
        reject: (error) => {
          state.pendingWriters -= 1
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      })
      this.drainNamespaceGate(state)
    })
  }

  private releaseNamespaceReadLease(state: NamespaceRuntimeState): void {
    state.activeReaders = Math.max(0, state.activeReaders - 1)
    this.drainNamespaceGate(state)
  }

  private releaseNamespaceWriteLease(state: NamespaceRuntimeState): void {
    state.writerActive = false
    this.drainNamespaceGate(state)
  }

  private drainNamespaceGate(state: NamespaceRuntimeState): void {
    if (!state.writerActive && state.activeReaders === 0) {
      const first = state.gateWaiters[0]
      if (first?.kind === 'write') {
        state.gateWaiters.shift()
        first.resolve()
      } else if (first?.kind === 'read') {
        while (state.gateWaiters[0]?.kind === 'read') {
          state.gateWaiters.shift()!.resolve()
        }
      }
    }
    if (state.activeReaders === 0 && !state.writerActive) {
      const idleWaiters = state.idleWaiters.splice(0)
      for (const resolve of idleWaiters) resolve()
    }
  }

  private waitForNamespaceIdle(state: NamespaceRuntimeState): Promise<void> {
    if (state.activeReaders === 0 && !state.writerActive) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      state.idleWaiters.push(resolve)
    })
  }

  private rejectNamespaceWaiters(state: NamespaceRuntimeState): void {
    const error = new VectorStoreError('closing', 'sqlite', 'retry_close')
    const waiters = state.gateWaiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }

  private loadSearchRows(
    state: NamespaceRuntimeState,
    rowids: number[],
  ): SearchRow[] {
    if (rowids.length === 0) return []
    return state.runtime.query<SearchRow>(
      `
        select
          rc.id,
          rc.chunk_id,
          rf.path,
          rc.text as excerpt,
          re.embedding,
          rc.line_start,
          rc.line_end,
          rc.block_id,
          rc.heading_path_json,
          rc.page,
          rc.metadata_json
        from rag_chunks rc
        inner join rag_files rf on rf.id = rc.file_id
        inner join rag_embeddings re on re.rowid = rc.rowid
        where rc.rowid in (${rowids.map(() => '?').join(', ')})
      `,
      rowids,
    )
  }

  private enqueueSerialized<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.writeQueue.then(async () => await work())
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private enqueueWrite<T>(work: () => Promise<T> | T): Promise<T> {
    this.assertOpen()
    this.assertNotClosing()
    return this.enqueueSerialized(work)
  }

  private async countSearchCandidates(
    state: NamespaceRuntimeState,
    options: VectorSearchOptions,
  ): Promise<number> {
    const scopedRowids =
      options.scope == null ? null : this.getScopedRowids(state, options)
    if (scopedRowids == null) {
      return (
        state.runtime.queryOne<CountRow>(
          'select count(*) as count from rag_chunks',
        )?.count ?? 0
      )
    }
    return scopedRowids.size
  }

  private asStoreError(
    error: unknown,
    code: 'transaction_failed',
    message: string,
  ): VectorStoreError {
    if (error instanceof VectorStoreError) return error
    return new VectorStoreError(
      code,
      'sqlite',
      'inspect_runtime_log',
      error instanceof Error ? `${message}: ${error.message}` : message,
    )
  }

  private getNamespaceDimension(state: NamespaceRuntimeState): number {
    const namespaceRow = state.runtime.queryOne<NamespaceRow>(
      'select dimension from rag_namespaces where id = ?',
      [state.namespaceId],
    )
    if (namespaceRow == null) {
      throw corruptStoreError(`Missing namespace row for ${state.namespaceId}`)
    }
    return namespaceRow.dimension
  }
}

function uniqueNormalized(values: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

function validateNamespaceIdForFilesystem(
  baseDir: string,
  namespaceKey: string,
): string {
  if (
    typeof namespaceKey !== 'string' ||
    namespaceKey.length === 0 ||
    namespaceKey !== namespaceKey.normalize('NFKC') ||
    namespaceKey === '.' ||
    namespaceKey === '..' ||
    namespaceKey.includes('/') ||
    namespaceKey.includes('\\') ||
    path.posix.isAbsolute(namespaceKey) ||
    path.win32.isAbsolute(namespaceKey)
  ) {
    throw new VectorStoreError(
      'malformed_query',
      'sqlite',
      'none',
      `Unsafe namespace ID: ${namespaceKey}`,
    )
  }
  const target = getSafeNamespaceTarget(baseDir, namespaceKey)
  const ragDir = path.resolve(baseDir, 'rag')
  const relative = path.relative(ragDir, target)
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.basename(target) !== namespaceKey
  ) {
    throw new VectorStoreError(
      'malformed_query',
      'sqlite',
      'none',
      `Namespace ID is outside the vector directory: ${namespaceKey}`,
    )
  }
  return namespaceKey
}

function validateNamespacePrefix(prefix: string): string {
  const normalized = prefix.normalize('NFKC').trim()
  if (
    !normalized ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized === '.' ||
    normalized === '..' ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe namespace prefix: ${prefix}`)
  }
  return normalized
}

function getSafeNamespaceTarget(baseDir: string, namespaceKey: string): string {
  return path.resolve(baseDir, 'rag', namespaceKey)
}

function normalizeVectorFilePath(filePath: string): string {
  const normalized = filePath.normalize('NFKC').trim()
  const segments = normalized.replace(/\\/g, '/').split('/')
  if (
    !normalized ||
    normalized.includes('\0') ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new VectorStoreError(
      'malformed_query',
      'sqlite',
      'none',
      `Unsafe vector file path: ${filePath}`,
    )
  }
  return normalized
}

function parseStoredMetadata(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch (error) {
    throw corruptStoreError(
      error instanceof Error
        ? `metadata_json is not valid JSON: ${error.message}`
        : 'metadata_json is not valid JSON',
    )
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corruptStoreError('metadata_json must contain a JSON object')
  }
  return parsed as Record<string, unknown>
}

function throwIfVectorSearchAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('Vector search cancelled')
  error.name = 'AbortError'
  throw error
}
