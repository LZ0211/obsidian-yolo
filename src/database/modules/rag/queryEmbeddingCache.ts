import { createHash } from 'node:crypto'

export const queryEmbeddingCacheKey = (
  modelId: string,
  query: string,
  dimension?: number,
): string =>
  createHash('sha256')
    .update(`${modelId}\u0000${dimension ?? 0}\u0000${query}`)
    .digest('hex')

export const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 2_000

export const encodeQueryEmbedding = (embedding: number[]): Uint8Array =>
  new Uint8Array(new Float32Array(embedding).buffer)

export const decodeQueryEmbedding = (value: Uint8Array): number[] =>
  Array.from(
    new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4),
  )

export type QueryEmbeddingCacheRuntime = {
  queryOne: <T>(sql: string, params?: unknown[]) => T | null
  exec: (sql: string, params?: unknown[]) => void
}

type CacheRow = { embedding: Uint8Array; dimension: number }

export class QueryEmbeddingCache {
  constructor(private readonly runtime: QueryEmbeddingCacheRuntime) {}

  get(modelId: string, query: string): number[] | null {
    const key = queryEmbeddingCacheKey(modelId, query)
    const row = this.runtime.queryOne<CacheRow>(
      'select embedding, dimension from query_embedding_cache where model_id = ? and query_hash = ?',
      [modelId, key],
    )
    if (!row) return null
    this.runtime.exec(
      'update query_embedding_cache set last_accessed_at_ms = ? where model_id = ? and query_hash = ?',
      [Date.now(), modelId, key],
    )
    return row.dimension === row.embedding.byteLength / 4
      ? decodeQueryEmbedding(row.embedding)
      : null
  }

  set(modelId: string, query: string, embedding: number[]): void {
    const now = Date.now()
    this.runtime.exec(
      `insert into query_embedding_cache(model_id, query_hash, dimension, embedding, created_at_ms, last_accessed_at_ms)
       values (?, ?, ?, ?, ?, ?)
       on conflict(model_id, query_hash) do update set embedding = excluded.embedding, dimension = excluded.dimension, last_accessed_at_ms = excluded.last_accessed_at_ms`,
      [
        modelId,
        queryEmbeddingCacheKey(modelId, query),
        embedding.length,
        encodeQueryEmbedding(embedding),
        now,
        now,
      ],
    )
    this.runtime.exec(
      `delete from query_embedding_cache where rowid in (
        select rowid from query_embedding_cache order by last_accessed_at_ms desc limit -1 offset ?
      )`,
      [QUERY_EMBEDDING_CACHE_MAX_ENTRIES],
    )
  }
}
