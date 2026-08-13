import type { SqliteNativeRuntimeFacade } from '../../../../sqlite/sqliteNativeRuntime'
import { vectorNamespaceId } from '../../../rag/namespaceId'
import {
  type StoredVectorFile,
  type VectorBackendStats,
  type VectorBackendStatus,
  type VectorChunkWrite,
  type VectorFileReadiness,
  type VectorFileWrite,
  type VectorHit,
  type VectorNamespace,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
  VectorStoreError,
} from '../../../rag/VectorStore'

import { parseShardedManifest } from './shardedManifest'
import {
  getShardedIndexRoot,
  getShardedManifestPath,
  getShardedModelRoot,
  getShardedShardRoot,
  getShardedStagedManifestPath,
} from './shardedPaths'
import { type ShardSqliteOpener, openShardSqliteNode } from './shardedSqlite'
import type { ShardedManifest, ShardedManifestShard } from './types'

/** Max chunk count per shard before a new shard (`shards/000002`...) opens. */
export const MAX_VECTORS_PER_SHARD = 1000

/** Coarse-index dimension: first `min(dim, COARSE_DIMENSION)` dims, L2-normalized. */
export const COARSE_DIMENSION = 256

/** Max shards queried in parallel during a search. */
export const MAX_CONCURRENT_SHARD_QUERIES = 4

/**
 * Per-shard rerank budget after the coarse pass:
 * `max(topK, min(COARSE_MIN_CANDIDATES, topK × COARSE_CANDIDATE_MULTIPLIER))`.
 */
const COARSE_MIN_CANDIDATES = 500
const COARSE_CANDIDATE_MULTIPLIER = 50

/**
 * Zod requires checksums even for freshly created/building shards (upstream
 * behavior). Real hashes land in Task 5 (vacuum); fixed placeholder for now.
 */
const CHECKSUM_PLACEHOLDER = 'sha256:pending'

const SHARD_ID_WIDTH = 6

const CHUNKS_TABLE_SQL = `create table if not exists chunks (
  chunk_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  file_mtime INTEGER,
  file_content_hash TEXT,
  chunk_content_hash TEXT,
  start_line INTEGER,
  end_line INTEGER,
  page INTEGER,
  text TEXT,
  metadata_json TEXT,
  tombstone INTEGER NOT NULL DEFAULT 0
)`

/** Insert into the staging table used by the compaction's rowid rebuild. */
const INSERT_CHUNK_REBUILD_SQL = `insert into chunks_rebuild (
  chunk_id, file_path, file_mtime, file_content_hash, chunk_content_hash,
  start_line, end_line, page, text, metadata_json, tombstone
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/**
 * Insert a fresh chunk row. A plain insert (not an upsert): rows whose
 * chunk_id already exists are routed to `reviveChunkInShard` before this
 * runs, so a duplicate primary key here is a bug that must fail loudly —
 * an upsert would silently re-break the rowid↔vector alignment.
 */
const INSERT_CHUNK_SQL = `insert into chunks (
  chunk_id, file_path, file_mtime, file_content_hash, chunk_content_hash,
  start_line, end_line, page, text, metadata_json, tombstone
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`

/** Same shape as CHUNKS_TABLE_SQL but under a staging name for rowid compaction. */
const CHUNKS_REBUILD_TABLE_SQL = `create table chunks_rebuild (
  chunk_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  file_mtime INTEGER,
  file_content_hash TEXT,
  chunk_content_hash TEXT,
  start_line INTEGER,
  end_line INTEGER,
  page INTEGER,
  text TEXT,
  metadata_json TEXT,
  tombstone INTEGER NOT NULL DEFAULT 0
)`

type ChunkRow = {
  chunk_id: string
  file_path: string
  file_mtime: number | null
  file_content_hash: string | null
  chunk_content_hash: string | null
  start_line: number | null
  end_line: number | null
  page: number | null
  text: string | null
  metadata_json: string | null
  tombstone: number
}

type ShardMeta = {
  shardId: string
  dimension: number
  vectorCount: number
}

/** Parameterized `chunks` predicate built from `VectorSearchOptions.scope`. */
type ShardScopeSql = {
  clause: string
  params: string[]
}

type ShardSearchHit = {
  row: ChunkRow
  score: number
}

/** Per-shard outcome of a search, aggregated by the caller. */
type ShardQueryResult = {
  hits: ShardSearchHit[]
  /** Rows considered in this shard (scope-filtered, or all rows when unscoped). */
  scopedCount: number
  coarseMs: number
  loadMs: number
  rerankMs: number
}

/**
 * Per-namespace reader-writer gate (desktop `SqliteVectorStore` semantics):
 * readers run concurrently, a writer waits for all readers and blocks new
 * readers while active, waiters are admitted FIFO.
 */
type NamespaceGateWaiter = {
  kind: 'read' | 'write'
  resolve: () => void
  reject: (error: unknown) => void
}

type NamespaceGateState = {
  activeReaders: number
  writerActive: boolean
  pendingWriters: number
  gateWaiters: NamespaceGateWaiter[]
}

/**
 * Coarse vectors for a whole shard: for each chunk, the first
 * `min(dim, COARSE_DIMENSION)` dims of its full vector, L2-normalized.
 * Zero-padded to `COARSE_DIMENSION × 4` bytes per vector, contiguous.
 */
function buildCoarseIndex(
  vectors: Float32Array,
  count: number,
  dimension: number,
): Float32Array {
  const coarseDims = Math.min(dimension, COARSE_DIMENSION)
  const coarse = new Float32Array(count * COARSE_DIMENSION)
  for (let i = 0; i < count; i += 1) {
    const vectorOffset = i * dimension
    const coarseOffset = i * COARSE_DIMENSION
    let sumSquares = 0
    for (let d = 0; d < coarseDims; d += 1) {
      const value = vectors[vectorOffset + d]
      coarse[coarseOffset + d] = value
      sumSquares += value * value
    }
    const norm = Math.sqrt(sumSquares)
    if (norm > 0) {
      for (let d = 0; d < coarseDims; d += 1) {
        coarse[coarseOffset + d] /= norm
      }
    }
  }
  return coarse
}

/**
 * Runs `fn` over `items` with at most `concurrency` promises in flight and
 * results in input order. A worker-shared index counter keeps the fan-in
 * race-free without a scheduler.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )
  return results
}

/**
 * Length check + L2 normalization of a query embedding. Mirrors the desktop
 * `SqliteVectorStore` helper; kept local (not imported) because this module
 * must stay free of static `node:*` imports for mobile bundling.
 */
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

/** Query-side coarse vector: first `min(dim, COARSE_DIMENSION)` dims, re-normalized to match `index.bin`. */
function coarseVector(embedding: number[]): number[] {
  return normalizeVector(
    embedding.slice(0, Math.min(COARSE_DIMENSION, embedding.length)),
    Math.min(COARSE_DIMENSION, embedding.length),
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

/**
 * Full-dimension cosine similarity between the normalized query and a stored
 * full vector. Task 2 stores raw (non-normalized) embeddings in vectors.f32,
 * so the stored vector is normalized here — equivalent to the desktop store,
 * which normalizes at write time and scores with a plain dot product.
 */
function storedCosineScore(query: number[], stored: Float32Array): number {
  let dot = 0
  let magnitude = 0
  for (let index = 0; index < stored.length; index += 1) {
    const value = stored[index]
    dot += query[index] * value
    magnitude += value * value
  }
  return magnitude === 0 ? 0 : dot / Math.sqrt(magnitude)
}

/** Trims/dedupes scope path values; mirrors the desktop store's normalization. */
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

/** Escapes LIKE wildcards so folder prefixes match literal paths. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function parseShardedMetadataJson(
  value: string | null,
): Record<string, unknown> {
  if (value == null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch (error) {
    throw new VectorStoreError(
      'database_corrupt',
      'sqlite',
      'rebuild_index',
      error instanceof Error
        ? `metadata_json is not valid JSON: ${error.message}`
        : 'metadata_json is not valid JSON',
    )
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VectorStoreError(
      'database_corrupt',
      'sqlite',
      'rebuild_index',
      'metadata_json must contain a JSON object',
    )
  }

  return parsed as Record<string, unknown>
}

/**
 * Sharded-row variant of the desktop `mapSqliteRowToVectorHit`: same
 * `VectorHit` shape minus columns the sharded `chunks` table does not carry
 * (`block_id`, `heading_path_json`).
 */
function mapShardedChunkRowToHit(row: ChunkRow, score: number): VectorHit {
  const metadataJson = parseShardedMetadataJson(row.metadata_json)
  return {
    id: row.chunk_id,
    chunkId: row.chunk_id,
    path: row.file_path,
    title:
      typeof metadataJson.title === 'string' ? metadataJson.title : undefined,
    excerpt: row.text ?? '',
    score,
    source: 'vector',
    location: {
      lineStart: row.start_line ?? undefined,
      lineEnd: row.end_line ?? undefined,
      page: row.page ?? undefined,
    },
    metadataJson,
  }
}

function throwIfVectorSearchAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('Vector search cancelled')
  error.name = 'AbortError'
  throw error
}

/**
 * Minimal vault-adapter surface the sharded backend needs. Deliberately
 * structural (not the Obsidian `DataAdapter` type) so the store stays
 * testable with an in-memory double; the real `app.vault.adapter` satisfies
 * it. Mirrors the host-agnostic shape of `SqliteEngineVaultAdapter` in
 * `src/core/runtime-components/contracts.ts`.
 */
export type ShardedVaultAdapter = {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  readBinary(path: string): Promise<ArrayBuffer>
  write(path: string, data: string): Promise<void>
  writeBinary(path: string, data: ArrayBuffer): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  list(path: string): Promise<{ files: string[]; folders: string[] }>
}

export type ShardedVaultApp = {
  vault: { adapter: ShardedVaultAdapter }
}

export type ShardedVectorStoreOptions = {
  baseDir: string
  app: ShardedVaultApp
  openShardSqlite?: ShardSqliteOpener
}

/**
 * Vault-resident sharded vector backend (mobile 分页存储模式). Layout mirrors
 * upstream `feat/sharded-vector-backend`: `<baseDir>/rag-index/v1/manifest.json`
 * plus `models/<ns>/shards/<shardId>/`. Task 1 ships the skeleton (open/close/
 * listNamespaces/dropNamespace/getStatus); Task 2 the write path; Task 3 the
 * search path (parallel coarse + full rerank + scope prefilter); Task 4
 * tombstone deletes (`UPDATE ... SET tombstone = 1`, full read-path
 * `tombstone = 0` filtering, rewrite-revive); vacuum lands in Task 5 and
 * currently throws.
 */
export class ShardedVectorStore implements VectorStore {
  private readonly baseDir: string
  private readonly app: ShardedVaultApp
  private readonly openShardSqlite: ShardSqliteOpener
  private isOpen = false
  private isClosing = false

  /**
   * Per-namespace reader-writer gates. A search concurrent with a write must
   * never observe a shard mid-mutation (chunk row inserted into chunks.sqlite
   * before vectors.f32/index.bin are appended) — that would surface as a
   * spurious `database_corrupt` byteLength mismatch or stale hits.
   */
  private readonly namespaceGates = new Map<string, NamespaceGateState>()

  constructor(options: ShardedVectorStoreOptions) {
    this.baseDir = options.baseDir
    this.app = options.app
    this.openShardSqlite = options.openShardSqlite ?? openShardSqliteNode
  }

  private get adapter(): ShardedVaultAdapter {
    return this.app.vault.adapter
  }

  async open(): Promise<void> {
    if (this.isOpen || this.isClosing) return
    this.isClosing = false
    this.isOpen = true
  }

  async close(): Promise<void> {
    this.isClosing = true
    if (!this.isOpen) {
      this.isClosing = false
      return
    }
    this.isOpen = false
    this.isClosing = false
  }

  async listNamespaces(): Promise<string[]> {
    this.assertOpen()
    this.assertNotClosing()
    const modelsRoot = `${getShardedIndexRoot(this.baseDir)}/models`
    if (!(await this.adapter.exists(modelsRoot))) return []
    const listing = await this.adapter.list(modelsRoot)
    return listing.folders.filter((name) => name.length > 0).sort()
  }

  async dropNamespace(namespace: VectorNamespace): Promise<void> {
    await this.dropNamespaceById(vectorNamespaceId(namespace))
  }

  async dropNamespaceById(namespaceId: string): Promise<void> {
    this.assertOpen()
    this.assertNotClosing()
    validateShardedNamespaceId(namespaceId)
    const release = await this.acquireNamespaceWriteLease(namespaceId)
    try {
      const modelRoot = getShardedModelRoot(this.baseDir, namespaceId)
      if (!(await this.adapter.exists(modelRoot))) return
      await this.adapter.remove(modelRoot, { recursive: true })
    } finally {
      release()
    }
  }

  async getStatus(namespace?: VectorNamespace): Promise<VectorBackendStatus> {
    this.assertOpen()
    this.assertNotClosing()
    const storagePath =
      namespace == null
        ? getShardedIndexRoot(this.baseDir)
        : getShardedManifestPath(this.baseDir)
    const manifestExists = await this.adapter.exists(
      getShardedManifestPath(this.baseDir),
    )
    if (!manifestExists) {
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
    this.assertOpen()
    this.assertNotClosing()
    const namespaceId = validateShardedNamespaceId(vectorNamespaceId(namespace))
    // Validate every chunk's embedding dimension before any mutation. A
    // mismatched embedding would otherwise poison the namespace mid-write:
    // `tombstoneFileRows` runs first, so the error would surface after old
    // rows were already tombstoned and vector counts incremented, leaving the
    // file unsearchable until a later rewrite.
    for (const file of files) {
      for (const chunk of file.chunks) {
        if (chunk.embedding.length !== namespace.dimension) {
          throw new VectorStoreError(
            'dimension_mismatch',
            'sqlite',
            'rebuild_index',
            `Expected embedding dimension ${namespace.dimension} but received ${chunk.embedding.length}`,
          )
        }
      }
    }
    for (const file of files) {
      await this.replaceFileById(namespaceId, namespace.dimension, file)
    }
  }

  async deleteFile(namespace: VectorNamespace, path: string): Promise<void> {
    await this.deleteFiles(namespace, [path])
  }

  async deleteFiles(
    namespace: VectorNamespace,
    paths: string[],
  ): Promise<void> {
    this.assertOpen()
    this.assertNotClosing()
    const namespaceId = validateShardedNamespaceId(vectorNamespaceId(namespace))
    // Exclusive lease: a search concurrent with the per-shard tombstone
    // UPDATEs must never observe a file half-tombstoned (rows in one shard
    // marked, rows in another still live).
    const release = await this.acquireNamespaceWriteLease(namespaceId)
    try {
      const manifest = await this.readManifest()
      // Nothing indexed (or a manifest active for another namespace): the
      // delete is a no-op, mirroring the desktop store's empty delete.
      if (manifest == null || manifest.activeModel !== namespaceId) return
      const failures: Array<{ shardId: string; error: unknown }> = []
      for (const shard of manifest.shards) {
        if (shard.state !== 'ready' || shard.vectorCount === 0) continue
        try {
          const runtime = this.openShardRuntime(namespaceId, shard.id)
          try {
            runtime.transaction(() => {
              for (const filePath of paths) {
                runtime.exec(
                  'update chunks set tombstone = 1 where file_path = ?',
                  [filePath],
                )
              }
            })
          } finally {
            runtime.close()
          }
        } catch (error) {
          // Keep tombstoning the remaining shards: partial tombstones are
          // recoverable (re-run the delete, or vacuum in Task 5), so the
          // failure surfaces as one clear error instead of a silent state
          // where early shards are marked and later ones are not.
          failures.push({ shardId: shard.id, error })
        }
      }
      if (failures.length > 0) {
        throw new VectorStoreError(
          'transaction_failed',
          'sqlite',
          'none',
          `deleteFiles partially tombstoned across shards: ${failures
            .map(({ shardId, error }) => `${shardId} (${String(error)})`)
            .join(', ')}`,
        )
      }
    } finally {
      release()
    }
  }

  async clearNamespace(_namespace: VectorNamespace): Promise<void> {
    throw new Error('not implemented yet')
  }

  async save(_namespace?: VectorNamespace): Promise<void> {
    throw new Error('not implemented yet')
  }

  async vacuum(_namespace?: VectorNamespace): Promise<void> {
    throw new Error('not implemented yet')
  }

  async getStatusByNamespaceId(
    _namespaceId: string,
  ): Promise<VectorBackendStatus> {
    throw new Error('not implemented yet')
  }

  async search(
    namespace: VectorNamespace,
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult> {
    return this.searchDetailed(namespace, embedding, options)
  }

  /**
   * Sharded search: manifest → ready shards (ns/dimension match) → parallel
   * per-shard coarse pass (`index.bin`) with scope prefilter (`chunks.sqlite`)
   * → full-dimension cosine rerank of the survivors (`vectors.f32`) → global
   * sort, `minSimilarity` filter, `topK` slice.
   *
   * Empty semantics mirror the desktop store: no manifest / no ready shard →
   * `rebuild_required`; scope matching nothing inside a populated namespace →
   * `{ hits: [] }`.
   */
  async searchDetailed(
    namespace: VectorNamespace,
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult> {
    this.assertOpen()
    this.assertNotClosing()
    throwIfVectorSearchAborted(options.signal)
    const namespaceId = validateShardedNamespaceId(vectorNamespaceId(namespace))
    const release = await this.acquireNamespaceReadLease(namespaceId)
    try {
      return await this.searchDetailedWithLease(
        namespace,
        embedding,
        options,
        namespaceId,
      )
    } finally {
      release()
    }
  }

  private async searchDetailedWithLease(
    namespace: VectorNamespace,
    embedding: number[],
    options: VectorSearchOptions,
    namespaceId: string,
  ): Promise<VectorSearchResult> {
    const manifest = await this.readManifest()
    if (manifest == null || manifest.activeModel !== namespaceId) {
      throw new VectorStoreError(
        'rebuild_required',
        'sqlite',
        'rebuild_index',
        'The active RAG namespace does not have an index manifest yet.',
      )
    }
    const readyShards = manifest.shards.filter(
      (shard) =>
        shard.state === 'ready' &&
        shard.dimension === namespace.dimension &&
        shard.vectorCount > 0,
    )
    if (readyShards.length === 0) {
      throw new VectorStoreError(
        'rebuild_required',
        'sqlite',
        'rebuild_index',
        'The active RAG namespace does not contain any indexed chunks yet.',
      )
    }
    throwIfVectorSearchAborted(options.signal)
    const queryFull = normalizeVector(
      embedding,
      namespace.dimension,
      'dimension_mismatch',
    )
    if (options.topK <= 0) return { hits: [] }
    const queryCoarse = coarseVector(queryFull)
    const scopeSql = this.buildShardScopeSql(options)
    const candidateK = Math.max(
      options.topK,
      Math.min(
        COARSE_MIN_CANDIDATES,
        options.topK * COARSE_CANDIDATE_MULTIPLIER,
      ),
    )

    const perShard = await mapWithConcurrency(
      readyShards,
      MAX_CONCURRENT_SHARD_QUERIES,
      async (shard) =>
        this.queryShard(
          namespaceId,
          shard,
          queryFull,
          queryCoarse,
          candidateK,
          scopeSql,
        ),
    )
    throwIfVectorSearchAborted(options.signal)
    const coarseSearch = Math.max(
      0,
      ...perShard.map((result) => result.coarseMs),
    )
    const loadFullVectors = Math.max(
      0,
      ...perShard.map((result) => result.loadMs),
    )
    const totalCount = perShard.reduce(
      (sum, result) => sum + result.scopedCount,
      0,
    )
    const merged = perShard.flatMap((result) => result.hits)
    if (merged.length === 0) {
      // The scope prefilter matched nothing inside a populated namespace: a
      // legitimate empty result — never a rebuild error (desktop parity).
      return { hits: [], timingsMs: undefined }
    }
    const rerankStart = Date.now()
    const reranked = [...merged]
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.row.chunk_id.localeCompare(right.row.chunk_id),
      )
      .filter(
        (hit) =>
          options.minSimilarity == null || hit.score >= options.minSimilarity,
      )
      .slice(0, options.topK)
    const rerankSimilarity =
      Date.now() -
      rerankStart +
      Math.max(0, ...perShard.map((result) => result.rerankMs))

    return {
      hits: reranked.map((hit) => mapShardedChunkRowToHit(hit.row, hit.score)),
      recallCount: reranked.length,
      recallLimit: candidateK,
      totalCount,
      filteredCount: merged.length - reranked.length,
      durationMs: coarseSearch + loadFullVectors + rerankSimilarity,
      timingsMs: {
        coarseSearch,
        loadFullVectors,
        rerankSimilarity,
      },
    }
  }

  /**
   * One shard's contribution to a search: scope prefilter against
   * `chunks.sqlite`, coarse dot ranking against `index.bin` (take the top
   * `candidateK`), then full-dimension cosine rerank of those survivors read
   * from `vectors.f32`.
   *
   * Alignment design (Task 4, option a): a chunk's vector sits at its chunk
   * row's position in `select * from chunks order by rowid` — the k-th row's
   * vector is at offset k in both `index.bin` and `vectors.f32`. Tombstones
   * never remove rows (only `UPDATE ... SET tombstone = 1`; Task 5's vacuum
   * is the sole physical remover), so rowids stay contiguous 1..N and rowid
   * order == vectors.f32 order even with tombstoned rows interleaved.
   * Search therefore reads ALL rows and skips tombstoned ones by position:
   * a tombstone between two live rows must NOT shift the live vectors'
   * offsets, so candidate scoring uses the row's absolute position in the
   * full rowid-ordered list, never a compacted live-only index. Rewritten
   * files keep their unchanged chunks revived in place (`reviveChunkInShard`
   * — no row moves, no vector duplicated), so this invariant also covers
   * rewrites whose chunk ids collide with earlier tombstones.
   */
  private async queryShard(
    namespaceId: string,
    shard: ShardedManifestShard,
    queryFull: number[],
    queryCoarse: number[],
    candidateK: number,
    scopeSql: ShardScopeSql | null,
  ): Promise<ShardQueryResult> {
    const result: ShardQueryResult = {
      hits: [],
      scopedCount: 0,
      coarseMs: 0,
      loadMs: 0,
      rerankMs: 0,
    }
    const coarseStart = Date.now()
    const shardRoot = getShardedShardRoot(this.baseDir, namespaceId, shard.id)
    const runtime = this.openShardRuntime(namespaceId, shard.id)
    try {
      const rows = runtime.query<ChunkRow>(
        'select * from chunks order by rowid',
      )
      // Live rows keep their absolute position in `rows` (== vector offset).
      const liveRows: Array<{ index: number; row: ChunkRow }> = []
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].tombstone === 0) liveRows.push({ index: i, row: rows[i] })
      }
      if (liveRows.length === 0) return result
      let scopedRowids: Set<number> | null = null
      if (scopeSql != null) {
        scopedRowids = new Set(
          runtime
            .query<{
              rowid: number
            }>(
              `select rowid from chunks where tombstone = 0 and (${scopeSql.clause})`,
              scopeSql.params,
            )
            .map((row) => Number(row.rowid)),
        )
      }
      result.scopedCount =
        scopedRowids == null
          ? liveRows.length
          : liveRows.filter(({ index }) => scopedRowids.has(index + 1)).length
      if (result.scopedCount === 0) return result

      const coarse = await this.readShardCoarseVectors(shardRoot, rows.length)
      const candidates: Array<{ index: number; score: number }> = []
      for (const { index } of liveRows) {
        if (scopedRowids != null && !scopedRowids.has(index + 1)) continue
        candidates.push({
          index,
          score: cosineScore(
            queryCoarse,
            coarse.subarray(
              index * COARSE_DIMENSION,
              (index + 1) * COARSE_DIMENSION,
            ),
          ),
        })
      }
      candidates.sort((a, b) => b.score - a.score || a.index - b.index)
      const selected = candidates.slice(0, candidateK)
      result.coarseMs = Date.now() - coarseStart
      if (selected.length === 0) return result

      const loadStart = Date.now()
      const fullVectors = await this.readShardVectors(
        shardRoot,
        shard.dimension,
        rows.length,
      )
      result.loadMs = Date.now() - loadStart

      const rerankStart = Date.now()
      for (const candidate of selected) {
        result.hits.push({
          row: rows[candidate.index],
          score: storedCosineScore(
            queryFull,
            fullVectors.subarray(
              candidate.index * shard.dimension,
              (candidate.index + 1) * shard.dimension,
            ),
          ),
        })
      }
      result.rerankMs = Date.now() - rerankStart
      return result
    } finally {
      runtime.close()
    }
  }

  private async readShardCoarseVectors(
    shardRoot: string,
    count: number,
  ): Promise<Float32Array> {
    const data = await this.adapter.readBinary(`${shardRoot}/index.bin`)
    const expected = count * COARSE_DIMENSION * 4
    if (data.byteLength !== expected) {
      throw new VectorStoreError(
        'database_corrupt',
        'sqlite',
        'rebuild_index',
        `index.bin size ${data.byteLength} does not match ${count} vectors × ${COARSE_DIMENSION} coarse dims`,
      )
    }
    return new Float32Array(data)
  }

  /**
   * Scope predicate for per-shard `chunks` queries, parameterized and LIKE-
   * escaped so scope values can never inject SQL.
   */
  private buildShardScopeSql(
    options: VectorSearchOptions,
  ): ShardScopeSql | null {
    if (options.scope == null) return null
    const files = uniqueNormalized(options.scope.files ?? [])
    const folders = uniqueNormalized(options.scope.folders ?? []).map(
      (folder) => folder.replace(/\/+$/g, ''),
    )
    if (files.length === 0 && folders.length === 0) return null
    const clauses: string[] = []
    const params: string[] = []
    if (files.length > 0) {
      clauses.push(`file_path in (${files.map(() => '?').join(', ')})`)
      params.push(...files)
    }
    if (folders.length > 0) {
      clauses.push(
        folders.map(() => "file_path like ? escape '\\'").join(' or '),
      )
      params.push(...folders.map((folder) => `${escapeLikePattern(folder)}/%`))
    }
    return { clause: clauses.join(' or '), params }
  }

  async getStoredFileVectors(
    _namespace: VectorNamespace,
    _paths: readonly string[],
  ): Promise<Map<string, StoredVectorFile>> {
    throw new Error('not implemented yet')
  }

  async getIndexedFiles(
    namespace: VectorNamespace,
  ): Promise<
    Map<string, { mtime: number; contentHash?: string; updatedAt?: number }>
  > {
    this.assertOpen()
    this.assertNotClosing()
    const namespaceId = validateShardedNamespaceId(vectorNamespaceId(namespace))
    const release = await this.acquireNamespaceReadLease(namespaceId)
    try {
      const manifest = await this.readManifest()
      const indexed = new Map<
        string,
        { mtime: number; contentHash?: string; updatedAt?: number }
      >()
      if (manifest == null || manifest.activeModel !== namespaceId) {
        return indexed
      }
      for (const shard of manifest.shards) {
        if (shard.state !== 'ready' || shard.vectorCount === 0) continue
        const runtime = this.openShardRuntime(namespaceId, shard.id)
        try {
          const rows = runtime.query<{
            file_path: string
            file_mtime: number | null
            file_content_hash: string | null
          }>(
            `select file_path, max(file_mtime) as file_mtime, file_content_hash
             from chunks where tombstone = 0 group by file_path`,
          )
          for (const row of rows) {
            const existing = indexed.get(row.file_path)
            const mtime = row.file_mtime ?? 0
            if (existing == null || mtime > existing.mtime) {
              indexed.set(row.file_path, {
                mtime,
                contentHash: row.file_content_hash ?? undefined,
              })
            }
          }
        } finally {
          runtime.close()
        }
      }
      return indexed
    } finally {
      release()
    }
  }

  async getFileReadiness(
    namespace: VectorNamespace,
    paths: string[],
  ): Promise<Map<string, VectorFileReadiness>> {
    this.assertOpen()
    this.assertNotClosing()
    const namespaceId = validateShardedNamespaceId(vectorNamespaceId(namespace))
    const release = await this.acquireNamespaceReadLease(namespaceId)
    try {
      const uniquePaths = [...new Set(paths)]
      const readiness = new Map<string, VectorFileReadiness>(
        uniquePaths.map((path) => [path, { path, vectorReady: false }]),
      )
      if (uniquePaths.length === 0) return readiness
      const manifest = await this.readManifest()
      if (manifest == null || manifest.activeModel !== namespaceId) {
        return readiness
      }
      const placeholders = uniquePaths.map(() => '?').join(', ')
      for (const shard of manifest.shards) {
        if (shard.state !== 'ready' || shard.vectorCount === 0) continue
        const runtime = this.openShardRuntime(namespaceId, shard.id)
        try {
          const rows = runtime.query<{ file_path: string }>(
            `select distinct file_path from chunks
             where tombstone = 0 and file_path in (${placeholders})`,
            uniquePaths,
          )
          for (const row of rows) {
            readiness.set(row.file_path, {
              path: row.file_path,
              vectorReady: true,
            })
          }
        } finally {
          runtime.close()
        }
      }
      return readiness
    } finally {
      release()
    }
  }

  async getQueryEmbedding(
    _namespace: VectorNamespace,
    _queryHash: string,
  ): Promise<number[] | null> {
    throw new Error('not implemented yet')
  }

  async putQueryEmbedding(
    _namespace: VectorNamespace,
    _queryHash: string,
    _embedding: number[],
  ): Promise<void> {
    throw new Error('not implemented yet')
  }

  async getStats(_namespace?: VectorNamespace): Promise<VectorBackendStats> {
    throw new Error('not implemented yet')
  }

  async purgeNamespacesByPrefixForPrivacy(_input: {
    namespaceIdPrefix: string
    confirmation: string
  }): Promise<readonly string[]> {
    throw new Error('not implemented yet')
  }

  /**
   * Append-style write for one file: tombstone the file's old chunk rows
   * (`tombstoneFileRows` — no physical removal, Task 4; the old vectors stay
   * as garbage until Task 5's vacuum), then write the new chunks. A chunk
   * whose id already exists in some shard (unchanged content — ids embed the
   * content hash) is revived in place (`reviveChunkInShard`) so its vector
   * keeps its original position; a genuinely new chunk appends into the
   * current shard, rolling to `shards/<next>` when the current shard reaches
   * `MAX_VECTORS_PER_SHARD`. The manifest is published once per file via
   * `manifest.next.json` → atomic rename.
   *
   * Any IO failure after the first mutation triggers a rollback (see
   * `rollbackFileWrite`) so a rejected replaceFile never leaves the file
   * half-indexed on disk.
   */
  private async replaceFileById(
    namespaceId: string,
    dimension: number,
    file: VectorFileWrite,
  ): Promise<void> {
    // Exclusive lease: a concurrent search must never observe this shard
    // mid-mutation (chunk row inserted before vectors.f32/index.bin append).
    const release = await this.acquireNamespaceWriteLease(namespaceId)
    let manifest: ShardedManifest
    try {
      manifest =
        (await this.readManifest()) ?? this.createEmptyManifest(namespaceId)
      if (manifest.activeModel !== namespaceId) {
        throw new VectorStoreError(
          'namespace_mismatch',
          'sqlite',
          'none',
          `Manifest active model "${manifest.activeModel}" does not match "${namespaceId}"`,
        )
      }
    } catch (error) {
      release()
      throw error
    }

    try {
      if (manifest.shards.length > 0) {
        await this.tombstoneFileRows(manifest, namespaceId, file.path)
      }

      // Pre-tombstoned rows are still in the table, so an unchanged chunk
      // (same chunk_id) must be revived in place — never appended again.
      const existingChunkShards = await this.findChunkShards(
        manifest,
        namespaceId,
        file.chunks.map((chunk) => chunk.chunkId),
      )
      for (const chunk of file.chunks) {
        const revivedShard = existingChunkShards.get(chunk.chunkId)
        if (revivedShard != null) {
          await this.reviveChunkInShard(namespaceId, revivedShard, file, chunk)
        } else {
          const shard = await this.ensureModelShard(
            manifest,
            namespaceId,
            dimension,
          )
          await this.insertChunkIntoShard(namespaceId, shard, file, chunk)
        }
      }

      if (manifest.shards.length > 0) {
        await this.publishManifest(manifest)
      }
    } catch (error) {
      await this.rollbackFileWrite(manifest, namespaceId, file.path, error)
    } finally {
      release()
    }
  }

  /**
   * Best-effort rollback of a partially written file: compact the file's rows
   * out of the shard (both the old tombstoned rows and any partially inserted
   * ones), rewriting vectors.f32/index.bin to match the survivors, and publish
   * the corrected manifest counts. Tombstone marking alone cannot roll back a
   * write that failed between the vectors.f32 and index.bin writes — the two
   * files would disagree on count, surfacing as a `database_corrupt`
   * byteLength mismatch. Compaction restores full artifact/table consistency
   * (and with it rowid↔offset alignment). If the rollback itself fails the
   * previous state cannot be restored — surface a clear `transaction_failed`
   * error instead.
   */
  private async rollbackFileWrite(
    manifest: ShardedManifest,
    namespaceId: string,
    filePath: string,
    cause: unknown,
  ): Promise<never> {
    try {
      if (manifest.shards.length > 0) {
        await this.removeFileRowsFromShards(manifest, namespaceId, filePath)
        await this.publishManifest(manifest)
      }
    } catch (rollbackError) {
      throw new VectorStoreError(
        'transaction_failed',
        'sqlite',
        'none',
        `replaceFile failed (${String(cause)}) and rollback also failed (${String(rollbackError)})`,
      )
    }
    throw cause
  }

  /**
   * Returns the shard new chunks append to, creating it (and the manifest
   * entry) when none exists or when the current shard is full.
   */
  private async ensureModelShard(
    manifest: ShardedManifest,
    namespaceId: string,
    dimension: number,
  ): Promise<ShardedManifestShard> {
    const lastShard = manifest.shards[manifest.shards.length - 1]
    if (
      lastShard != null &&
      lastShard.state === 'ready' &&
      lastShard.vectorCount < MAX_VECTORS_PER_SHARD
    ) {
      if (lastShard.dimension !== dimension) {
        throw new VectorStoreError(
          'dimension_mismatch',
          'sqlite',
          'none',
          `Shard ${lastShard.id} is dimension ${lastShard.dimension}, expected ${dimension}`,
        )
      }
      return lastShard
    }
    return this.createShard(manifest, namespaceId, dimension)
  }

  private async createShard(
    manifest: ShardedManifest,
    namespaceId: string,
    dimension: number,
  ): Promise<ShardedManifestShard> {
    const nextNumber = manifest.shards.reduce(
      (max, shard) => Math.max(max, Number(shard.id) || 0),
      0,
    )
    const shardId = String(nextNumber + 1).padStart(SHARD_ID_WIDTH, '0')
    const shard: ShardedManifestShard = {
      id: shardId,
      relativePath: `models/${namespaceId}/shards/${shardId}`,
      state: 'ready',
      dimension,
      vectorCount: 0,
      checksums: {
        chunksSqlite: CHECKSUM_PLACEHOLDER,
        vectorsF32: CHECKSUM_PLACEHOLDER,
        indexBin: CHECKSUM_PLACEHOLDER,
        tombstonesBin: CHECKSUM_PLACEHOLDER,
        shardMeta: CHECKSUM_PLACEHOLDER,
      },
    }
    manifest.shards.push(shard)
    const shardRoot = getShardedShardRoot(this.baseDir, namespaceId, shardId)
    // Empty artifacts; chunks.sqlite itself is created lazily by the opener.
    await this.adapter.writeBinary(
      `${shardRoot}/vectors.f32`,
      new ArrayBuffer(0),
    )
    await this.adapter.writeBinary(`${shardRoot}/index.bin`, new ArrayBuffer(0))
    await this.writeShardMeta(shardRoot, shard)
    return shard
  }

  /**
   * Locates which shard already holds each of `chunkIds` (tombstoned or
   * live). A rewrite that keeps an unchanged chunk (same chunk_id — ids
   * embed the content hash) must revive that row in place
   * (`reviveChunkInShard`), so the vector stays at its original position and
   * the rowid↔offset alignment holds. Batched in groups of 500 to stay under
   * SQLite's variable limit for large files.
   */
  private async findChunkShards(
    manifest: ShardedManifest,
    namespaceId: string,
    chunkIds: string[],
  ): Promise<Map<string, ShardedManifestShard>> {
    const found = new Map<string, ShardedManifestShard>()
    if (chunkIds.length === 0) return found
    for (const shard of manifest.shards) {
      if (shard.state !== 'ready' || shard.vectorCount === 0) continue
      const runtime = this.openShardRuntime(namespaceId, shard.id)
      try {
        for (let offset = 0; offset < chunkIds.length; offset += 500) {
          const batch = chunkIds.slice(offset, offset + 500)
          const placeholders = batch.map(() => '?').join(', ')
          const rows = runtime.query<{ chunk_id: string }>(
            `select chunk_id from chunks where chunk_id in (${placeholders})`,
            batch,
          )
          for (const row of rows) found.set(row.chunk_id, shard)
        }
      } finally {
        runtime.close()
      }
    }
    return found
  }

  /**
   * Revive path for a rewrite that keeps an unchanged chunk (same chunk_id —
   * ids embed the content hash). The row already exists (tombstoned by this
   * rewrite's `tombstoneFileRows`, or by an earlier delete), so it is
   * updated in place with `tombstone = 0`; its stored vector stays at the
   * row's original position — no vectors.f32 append, no index.bin rewrite,
   * no vectorCount change. Without this branch the old upsert would update
   * the row but still append a duplicate vector, breaking rowid↔offset
   * alignment and tripping the byteLength check on the next search.
   */
  private async reviveChunkInShard(
    namespaceId: string,
    shard: ShardedManifestShard,
    file: VectorFileWrite,
    chunk: VectorChunkWrite,
  ): Promise<void> {
    const runtime = this.openShardRuntime(namespaceId, shard.id)
    try {
      runtime.exec(
        `update chunks set
           file_path = ?, file_mtime = ?, file_content_hash = ?,
           chunk_content_hash = ?, start_line = ?, end_line = ?, page = ?,
           text = ?, metadata_json = ?, tombstone = 0
         where chunk_id = ?`,
        [
          file.path,
          file.mtime,
          file.contentHash ?? null,
          chunk.contentHash,
          chunk.location.lineStart ?? null,
          chunk.location.lineEnd ?? null,
          chunk.location.page ?? null,
          chunk.text,
          JSON.stringify(chunk.metadataJson),
          chunk.chunkId,
        ],
      )
    } finally {
      runtime.close()
    }
  }

  /**
   * Insert the chunk row (fresh chunk_id — duplicates are routed to
   * `reviveChunkInShard` by the caller, so a primary-key conflict here is a
   * bug and fails loudly), append the full vector, rewrite the whole-shard
   * coarse index.
   */
  private async insertChunkIntoShard(
    namespaceId: string,
    shard: ShardedManifestShard,
    file: VectorFileWrite,
    chunk: VectorChunkWrite,
  ): Promise<void> {
    if (chunk.embedding.length !== shard.dimension) {
      throw new VectorStoreError(
        'dimension_mismatch',
        'sqlite',
        'rebuild_index',
        `Expected embedding dimension ${shard.dimension} but received ${chunk.embedding.length}`,
      )
    }
    const shardRoot = getShardedShardRoot(this.baseDir, namespaceId, shard.id)
    const runtime = this.openShardRuntime(namespaceId, shard.id)
    try {
      runtime.exec(INSERT_CHUNK_SQL, [
        chunk.chunkId,
        file.path,
        file.mtime,
        file.contentHash ?? null,
        chunk.contentHash,
        chunk.location.lineStart ?? null,
        chunk.location.lineEnd ?? null,
        chunk.location.page ?? null,
        chunk.text,
        JSON.stringify(chunk.metadataJson),
      ])

      // Append full vector (float32 LE, dim × 4 bytes) to vectors.f32.
      const vectorsPath = `${shardRoot}/vectors.f32`
      const existing = (await this.adapter.exists(vectorsPath))
        ? new Uint8Array(await this.adapter.readBinary(vectorsPath))
        : new Uint8Array(0)
      const vectorBytes = new Uint8Array(
        new Float32Array(chunk.embedding).buffer,
      )
      const appended = new Uint8Array(existing.length + vectorBytes.length)
      appended.set(existing, 0)
      appended.set(vectorBytes, existing.length)
      await this.adapter.writeBinary(vectorsPath, appended.buffer)

      shard.vectorCount += 1
      await this.rewriteCoarseIndex(
        namespaceId,
        shard.id,
        shard.dimension,
        shard.vectorCount,
      )
      await this.writeShardMeta(shardRoot, shard)
    } finally {
      runtime.close()
    }
  }

  /**
   * Rewrites `index.bin` from the whole shard: one L2-normalized coarse
   * vector (first `min(dim, COARSE_DIMENSION)` dims) per chunk, contiguous,
   * aligned with vectors.f32 by rowid order. The count is explicit so
   * callers can index a file whose vectors.f32 layout differs from the
   * manifest count mid-compaction.
   */
  private async rewriteCoarseIndex(
    namespaceId: string,
    shardId: string,
    dimension: number,
    count: number,
  ): Promise<void> {
    const shardRoot = getShardedShardRoot(this.baseDir, namespaceId, shardId)
    const vectors = await this.readShardVectors(shardRoot, dimension, count)
    await this.adapter.writeBinary(
      `${shardRoot}/index.bin`,
      // Freshly allocated Float32Array, never backed by a SharedArrayBuffer.
      buildCoarseIndex(vectors, count, dimension).buffer as ArrayBuffer,
    )
  }

  /**
   * Rewrite path (Task 4): mark every existing chunk of `filePath` as
   * tombstoned instead of physically removing rows. vectors.f32/index.bin
   * keep the old vectors as garbage (reclaimed by Task 5's vacuum). The
   * file's new chunks then either revive their pre-existing rows in place
   * (`reviveChunkInShard`, same chunk_id) or append as fresh rows
   * (`insertChunkIntoShard`). Rowid-order ↔ vector alignment is preserved
   * because nothing is removed and nothing is duplicated: rowid order stays
   * equal to vector order.
   */
  private async tombstoneFileRows(
    manifest: ShardedManifest,
    namespaceId: string,
    filePath: string,
  ): Promise<void> {
    for (const shard of manifest.shards) {
      if (shard.state !== 'ready' || shard.vectorCount === 0) continue
      const runtime = this.openShardRuntime(namespaceId, shard.id)
      try {
        runtime.exec('update chunks set tombstone = 1 where file_path = ?', [
          filePath,
        ])
      } finally {
        runtime.close()
      }
    }
  }

  /**
   * Compaction path, used only by `rollbackFileWrite`: drops every row of
   * `filePath` (tombstoned or not) and rewrites the shard's artifacts from
   * the survivors. Task 4 replaced the normal rewrite's physical delete with
   * tombstone UPDATEs (`tombstoneFileRows`); this stays for the failure path
   * because a failed insert can leave vectors.f32 and index.bin disagreeing
   * on count, which tombstone marking cannot reconcile.
   *
   * To keep the rowid-order ↔ vectors.f32 alignment that search depends on,
   * the affected shard is compacted: old rows are dropped, the chunks table
   * is rebuilt with fresh rowids, and vectors.f32/index.bin are rewritten to
   * match the surviving rows.
   *
   * Mutation order is deliberate so a mid-compaction adapter failure leaves
   * a state that a rollback re-run can recover from: index.bin/vectors.f32
   * are written from the in-memory compacted buffers before the chunks table
   * is rebuilt, and `shard.vectorCount` is only updated at the very end. An
   * adapter failure therefore leaves either a fully-unchanged shard (re-run
   * is a full compaction) or a compacted-files + old-table shard whose
   * byteLength check fails loudly in the re-run.
   */
  private async removeFileRowsFromShards(
    manifest: ShardedManifest,
    namespaceId: string,
    filePath: string,
  ): Promise<void> {
    for (const shard of manifest.shards) {
      if (shard.state !== 'ready' || shard.vectorCount === 0) continue
      const shardRoot = getShardedShardRoot(this.baseDir, namespaceId, shard.id)
      const runtime = this.openShardRuntime(namespaceId, shard.id)
      try {
        const match = runtime.queryOne<{ n: number }>(
          'select count(*) as n from chunks where file_path = ?',
          [filePath],
        )
        if ((match?.n ?? 0) === 0) continue
        const rows = runtime.query<ChunkRow>(
          'select * from chunks order by rowid',
        )
        const kept = rows.filter((row) => row.file_path !== filePath)

        // Compact vectors.f32 and index.bin to the surviving rows.
        const vectors = await this.readShardVectors(
          shardRoot,
          shard.dimension,
          shard.vectorCount,
        )
        const compacted = new Float32Array(kept.length * shard.dimension)
        let out = 0
        for (let i = 0; i < rows.length; i += 1) {
          if (rows[i].file_path === filePath) continue
          compacted.set(
            vectors.subarray(i * shard.dimension, (i + 1) * shard.dimension),
            out * shard.dimension,
          )
          out += 1
        }
        await this.adapter.writeBinary(
          `${shardRoot}/index.bin`,
          // Freshly allocated Float32Array, never backed by a SharedArrayBuffer.
          buildCoarseIndex(compacted, kept.length, shard.dimension)
            .buffer as ArrayBuffer,
        )
        await this.adapter.writeBinary(
          `${shardRoot}/vectors.f32`,
          compacted.buffer,
        )

        runtime.transaction(() => {
          runtime.exec(CHUNKS_REBUILD_TABLE_SQL)
          for (const row of kept) {
            runtime.exec(INSERT_CHUNK_REBUILD_SQL, [
              row.chunk_id,
              row.file_path,
              row.file_mtime,
              row.file_content_hash,
              row.chunk_content_hash,
              row.start_line,
              row.end_line,
              row.page,
              row.text,
              row.metadata_json,
              row.tombstone,
            ])
          }
          runtime.exec('drop table chunks')
          runtime.exec('alter table chunks_rebuild rename to chunks')
        })

        shard.vectorCount = kept.length
        await this.writeShardMeta(shardRoot, shard)
      } finally {
        runtime.close()
      }
    }
  }

  private async readShardVectors(
    shardRoot: string,
    dimension: number,
    count: number,
  ): Promise<Float32Array> {
    const vectorsPath = `${shardRoot}/vectors.f32`
    if (!(await this.adapter.exists(vectorsPath))) return new Float32Array(0)
    const data = await this.adapter.readBinary(vectorsPath)
    const expected = count * dimension * 4
    if (data.byteLength !== expected) {
      throw new VectorStoreError(
        'database_corrupt',
        'sqlite',
        'rebuild_index',
        `vectors.f32 size ${data.byteLength} does not match ${count} vectors × ${dimension} dims`,
      )
    }
    return new Float32Array(data)
  }

  private async writeShardMeta(
    shardRoot: string,
    shard: ShardedManifestShard,
  ): Promise<void> {
    const meta: ShardMeta = {
      shardId: shard.id,
      dimension: shard.dimension,
      vectorCount: shard.vectorCount,
    }
    await this.adapter.write(
      `${shardRoot}/shard.meta.json`,
      JSON.stringify(meta),
    )
  }

  private async readManifest(): Promise<ShardedManifest | null> {
    const manifestPath = getShardedManifestPath(this.baseDir)
    if (!(await this.adapter.exists(manifestPath))) return null
    return parseShardedManifest(
      JSON.parse(await this.adapter.read(manifestPath)),
    )
  }

  /** Atomic publish: write `manifest.next.json`, then rename over `manifest.json`. */
  private async publishManifest(manifest: ShardedManifest): Promise<void> {
    manifest.updatedAt = Date.now()
    const staged = getShardedStagedManifestPath(this.baseDir)
    const target = getShardedManifestPath(this.baseDir)
    await this.adapter.write(staged, JSON.stringify(manifest))
    await this.adapter.rename(staged, target)
  }

  private createEmptyManifest(namespaceId: string): ShardedManifest {
    return {
      schemaVersion: 1,
      formatVersion: 1,
      activeModel: namespaceId,
      updatedAt: 0,
      shards: [],
    }
  }

  private openShardRuntime(
    namespaceId: string,
    shardId: string,
  ): SqliteNativeRuntimeFacade {
    const dbPath = `${getShardedShardRoot(this.baseDir, namespaceId, shardId)}/chunks.sqlite`
    const runtime = this.openShardSqlite(dbPath)
    runtime.exec(CHUNKS_TABLE_SQL)
    return runtime
  }

  private getNamespaceGateState(namespaceId: string): NamespaceGateState {
    let state = this.namespaceGates.get(namespaceId)
    if (state == null) {
      state = {
        activeReaders: 0,
        writerActive: false,
        pendingWriters: 0,
        gateWaiters: [],
      }
      this.namespaceGates.set(namespaceId, state)
    }
    return state
  }

  /**
   * Shared read lease: admitted immediately when no writer is active or
   * queued; otherwise queued FIFO behind the pending writer. Mirrors the
   * desktop `SqliteVectorStore` gate semantics.
   */
  private async acquireNamespaceReadLease(
    namespaceId: string,
  ): Promise<() => void> {
    this.assertOpen()
    this.assertNotClosing()
    const state = this.getNamespaceGateState(namespaceId)
    if (!state.writerActive && state.pendingWriters === 0) {
      state.activeReaders += 1
      return () => this.releaseNamespaceReadLease(namespaceId)
    }
    return new Promise<() => void>((resolve, reject) => {
      state.gateWaiters.push({
        kind: 'read',
        resolve: () => {
          state.activeReaders += 1
          resolve(() => this.releaseNamespaceReadLease(namespaceId))
        },
        reject,
      })
      this.drainNamespaceGate(namespaceId)
    })
  }

  /**
   * Exclusive write lease: queued FIFO, admitted once all active readers
   * finish; blocks new readers while active.
   */
  private async acquireNamespaceWriteLease(
    namespaceId: string,
  ): Promise<() => void> {
    this.assertOpen()
    this.assertNotClosing()
    const state = this.getNamespaceGateState(namespaceId)
    state.pendingWriters += 1
    return new Promise<() => void>((resolve, reject) => {
      state.gateWaiters.push({
        kind: 'write',
        resolve: () => {
          state.pendingWriters -= 1
          state.writerActive = true
          resolve(() => this.releaseNamespaceWriteLease(namespaceId))
        },
        reject: (error) => {
          state.pendingWriters -= 1
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      })
      this.drainNamespaceGate(namespaceId)
    })
  }

  private releaseNamespaceReadLease(namespaceId: string): void {
    const state = this.namespaceGates.get(namespaceId)
    if (state == null) return
    state.activeReaders = Math.max(0, state.activeReaders - 1)
    this.drainNamespaceGate(namespaceId)
  }

  private releaseNamespaceWriteLease(namespaceId: string): void {
    const state = this.namespaceGates.get(namespaceId)
    if (state == null) return
    state.writerActive = false
    this.drainNamespaceGate(namespaceId)
  }

  /** FIFO admission: leading writer, or all leading readers. */
  private drainNamespaceGate(namespaceId: string): void {
    const state = this.namespaceGates.get(namespaceId)
    if (state == null) return
    if (!state.writerActive && state.activeReaders === 0) {
      const first = state.gateWaiters[0]
      if (first?.kind === 'write') {
        state.gateWaiters.shift()
        first.resolve()
      } else if (first?.kind === 'read') {
        while (state.gateWaiters[0]?.kind === 'read') {
          state.gateWaiters.shift()?.resolve()
        }
      }
    }
  }

  private assertOpen(): void {
    if (!this.isOpen) {
      throw new VectorStoreError('not_open', 'sqlite', 'open_backend')
    }
  }

  private assertNotClosing(): void {
    if (this.isClosing) {
      throw new VectorStoreError('closing', 'sqlite', 'retry_close')
    }
  }
}

/**
 * Guards a namespace id before it is interpolated into a model-root path.
 * Pure string checks (no `node:path`) so the module stays free of static
 * `node:*` imports for mobile bundling.
 */
function validateShardedNamespaceId(namespaceId: string): string {
  if (
    typeof namespaceId !== 'string' ||
    namespaceId.length === 0 ||
    namespaceId === '.' ||
    namespaceId === '..' ||
    namespaceId.includes('/') ||
    namespaceId.includes('\\') ||
    namespaceId.includes('\0')
  ) {
    throw new VectorStoreError(
      'malformed_query',
      'sqlite',
      'none',
      `Unsafe namespace ID: ${namespaceId}`,
    )
  }
  return namespaceId
}
