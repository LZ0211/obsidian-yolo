import type { SqliteNativeRuntimeFacade } from '../../../../sqlite/sqliteNativeRuntime'
import { vectorNamespaceId } from '../../../rag/namespaceId'
import {
  type StoredVectorFile,
  type VectorBackendStats,
  type VectorBackendStatus,
  type VectorChunkWrite,
  type VectorFileReadiness,
  type VectorFileWrite,
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

const UPSERT_CHUNK_SQL = `insert into chunks (
  chunk_id, file_path, file_mtime, file_content_hash, chunk_content_hash,
  start_line, end_line, page, text, metadata_json, tombstone
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
on conflict(chunk_id) do update set
  file_path = excluded.file_path,
  file_mtime = excluded.file_mtime,
  file_content_hash = excluded.file_content_hash,
  chunk_content_hash = excluded.chunk_content_hash,
  start_line = excluded.start_line,
  end_line = excluded.end_line,
  page = excluded.page,
  text = excluded.text,
  metadata_json = excluded.metadata_json,
  tombstone = 0`

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
 * listNamespaces/dropNamespace/getStatus); write/search/delete/vacuum land in
 * Tasks 2-5 and currently throw.
 */
export class ShardedVectorStore implements VectorStore {
  private readonly baseDir: string
  private readonly app: ShardedVaultApp
  private readonly openShardSqlite: ShardSqliteOpener
  private isOpen = false
  private isClosing = false

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
    const modelRoot = getShardedModelRoot(this.baseDir, namespaceId)
    if (!(await this.adapter.exists(modelRoot))) return
    await this.adapter.remove(modelRoot, { recursive: true })
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
    // `removeFileRowsFromShards` (compaction) runs first, so the error would
    // surface after old rows were already dropped and vector counts
    // decremented, leaving every later write dead in the vectors.f32
    // byteLength check until manual cleanup.
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

  async deleteFile(_namespace: VectorNamespace, _path: string): Promise<void> {
    throw new Error('not implemented yet')
  }

  async deleteFiles(
    _namespace: VectorNamespace,
    _paths: string[],
  ): Promise<void> {
    throw new Error('not implemented yet')
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
    _namespace: VectorNamespace,
    _embedding: number[],
    _options: VectorSearchOptions,
  ): Promise<VectorSearchResult> {
    throw new Error('not implemented yet')
  }

  async searchDetailed(
    _namespace: VectorNamespace,
    _embedding: number[],
    _options: VectorSearchOptions,
  ): Promise<VectorSearchResult> {
    throw new Error('not implemented yet')
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
  }

  async getFileReadiness(
    namespace: VectorNamespace,
    paths: string[],
  ): Promise<Map<string, VectorFileReadiness>> {
    this.assertOpen()
    this.assertNotClosing()
    const namespaceId = validateShardedNamespaceId(vectorNamespaceId(namespace))
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
   * Append-style write for one file: physically drop the file's old chunk
   * rows (Task 4 replaces this with tombstone UPDATEs), then append the new
   * chunks into the current shard, rolling to `shards/<next>` when the
   * current shard reaches `MAX_VECTORS_PER_SHARD`. The manifest is published
   * once per file via `manifest.next.json` → atomic rename.
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
    let manifest = await this.readManifest()
    if (manifest == null) {
      manifest = this.createEmptyManifest(namespaceId)
    } else if (manifest.activeModel !== namespaceId) {
      throw new VectorStoreError(
        'namespace_mismatch',
        'sqlite',
        'none',
        `Manifest active model "${manifest.activeModel}" does not match "${namespaceId}"`,
      )
    }

    try {
      if (manifest.shards.length > 0) {
        await this.removeFileRowsFromShards(manifest, namespaceId, file.path)
      }

      for (const chunk of file.chunks) {
        const shard = await this.ensureModelShard(
          manifest,
          namespaceId,
          dimension,
        )
        await this.insertChunkIntoShard(namespaceId, shard, file, chunk)
      }

      if (manifest.shards.length > 0) {
        await this.publishManifest(manifest)
      }
    } catch (error) {
      await this.rollbackFileWrite(manifest, namespaceId, file.path, error)
    }
  }

  /**
   * Best-effort rollback of a partially written file: re-run the physical
   * delete (which removes both the partially inserted rows and any old rows
   * the compaction may have dropped) and publish the corrected manifest
   * counts, so no half-indexed file state remains observable. If the
   * rollback itself fails the previous state cannot be restored — surface a
   * clear `transaction_failed` error instead.
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

  /** Upsert chunk row, append the full vector, rewrite the whole-shard coarse index. */
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
      runtime.exec(UPSERT_CHUNK_SQL, [
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
   * Temporary physical-delete path (plan: "先物理删旧行"). Task 4 replaces it
   * with tombstone UPDATEs. To keep the rowid-order ↔ vectors.f32 alignment
   * that Task 3's search depends on, the affected shard is compacted: old
   * rows are dropped, the chunks table is rebuilt with fresh rowids, and
   * vectors.f32/index.bin are rewritten to match the surviving rows.
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
