import type { SqliteNativeRuntimeFacade } from '../../database/sqlite/sqliteNativeRuntime'

/**
 * Dense memory embeddings for semantic recall. One row per indexed memory
 * entry (`memory_embeddings` table, schema v2), keyed by memory_key
 * (``partition::localId``) so the semantic path aligns with the lexical and
 * graph paths in the RRF fusion. Memory volume is small compared to RAG — a
 * partition rarely exceeds a few thousand entries — so recall loads the
 * partition's vectors and brute-forces cosine similarity; no coarse/fine
 * two-stage scheme needed.
 */

export type MemoryEmbeddingKey = {
  partitionKey: string
  memoryKey: string
  localId: number
}

export type MemoryEmbeddingHit = MemoryEmbeddingKey & {
  score: number
}

const FLOAT32_BYTES = 4

const encodeF32 = (values: number[]): Uint8Array => {
  const buffer = new ArrayBuffer(values.length * FLOAT32_BYTES)
  new Float32Array(buffer).set(values)
  return new Uint8Array(buffer)
}

const decodeF32 = (bytes: Uint8Array): number[] =>
  Array.from(
    new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / FLOAT32_BYTES,
    ),
  )

const cosineSimilarity = (left: number[], right: number[]): number => {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export class MemoryEmbeddingStore {
  constructor(private readonly runtime: SqliteNativeRuntimeFacade) {}

  upsert(key: MemoryEmbeddingKey, embedding: number[]): void {
    this.runtime.exec(
      `insert into memory_embeddings (partition_key, memory_key, local_id, embedding, dimension, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(partition_key, memory_key) do update set
         embedding = excluded.embedding,
         dimension = excluded.dimension,
         updated_at = excluded.updated_at`,
      [
        key.partitionKey,
        key.memoryKey,
        key.localId,
        encodeF32(embedding),
        embedding.length,
        Date.now(),
      ],
    )
  }

  delete(partitionKey: string, memoryKeys: readonly string[]): void {
    if (memoryKeys.length === 0) return
    const placeholders = memoryKeys.map(() => '?').join(', ')
    this.runtime.exec(
      `delete from memory_embeddings where partition_key = ? and memory_key in (${placeholders})`,
      [partitionKey, ...memoryKeys],
    )
  }

  clearPartition(partitionKey: string): void {
    this.runtime.exec(
      'delete from memory_embeddings where partition_key = ?',
      [partitionKey],
    )
  }

  /**
   * Brute-force cosine search over one partition. Returns hits sorted by
   * descending similarity, capped at `topN`.
   *
   * Rows are filtered by the query embedding's dimension: after an embedding
   * model switch, unchanged entries keep vectors from the old model, and
   * comparing vectors of different lengths would produce garbage scores.
   */
  search(
    partitionKey: string,
    queryEmbedding: number[],
    topN: number,
  ): MemoryEmbeddingHit[] {
    const dimension = queryEmbedding.length
    const rows = this.runtime.query<{
      memory_key: string
      local_id: number
      embedding: Uint8Array
    }>(
      'select memory_key, local_id, embedding from memory_embeddings where partition_key = ? and dimension = ?',
      [partitionKey, dimension],
    )
    const scored: MemoryEmbeddingHit[] = []
    for (const row of rows) {
      const vector = decodeF32(row.embedding)
      const score = cosineSimilarity(queryEmbedding, vector)
      scored.push({
        partitionKey,
        memoryKey: row.memory_key,
        localId: row.local_id,
        score,
      })
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, topN)
  }
}
