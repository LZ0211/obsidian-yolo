import { MemoryEmbeddingStore } from './memoryEmbeddings'
import type {
  MemoryIndexMaintenanceStore,
  MemoryIndexStore,
} from './memoryIndex'
import { fuseMemoryRecallRanks } from './memoryRecallFusion'
import type { MemoryRecallTarget } from './memoryRecallTarget'
import type { MemoryPartition } from './memoryTypes'

/**
 * Multi-path memory retrieval with Reciprocal Rank Fusion.
 *
 * Three paths each produce a ranked list of memory keys:
 * - lexical: keyword + content matching (SQLite, backup design)
 * - semantic: dense embedding cosine similarity (schema v2, RAG embedding)
 * - graph: keyword-Jaccard edge expansion from the lexical seeds
 *
 * RRF merges by rank position (k = 60) so the incomparable path scores never
 * need calibration — and Chinese semantic recall (where lexical matching is
 * weak) contributes on equal footing. Falls back to the lexical path alone
 * when no embedding model is configured or the vector path is unavailable.
 */

export type MemoryRetrievalOptions = {
  partition: MemoryPartition
  sourceFileFingerprint: string
  target: MemoryRecallTarget
  maxEntries: number
  maxChars: number
  /** Produces the query embedding for the semantic path; null disables it. */
  embedQuery: (query: string) => Promise<number[] | null>
}

export type MemoryRetrievalPath = 'lexical' | 'vector' | 'graph'

export type MemoryRetrievalResult = {
  memoryKeys: readonly string[]
  paths: readonly MemoryRetrievalPath[]
  /** Per-path candidate counts so the query layer's discard stats stay observable. */
  candidateCounts: Readonly<Record<MemoryRetrievalPath, number>>
  /** True only when a path reached `maxEntries` (the candidate entry cap). */
  candidateLimitHit: boolean
}

export class MemoryRetrievalService {
  constructor(
    private readonly store: MemoryIndexStore &
      Pick<MemoryIndexMaintenanceStore, 'expandViaEdges'>,
    private readonly embeddings: MemoryEmbeddingStore,
  ) {}

  /**
   * Retrieve memory keys for a query via the three-path RRF fusion.
   * Returns the fused keys (best-first) plus which paths contributed.
   */
  async retrieve(
    options: MemoryRetrievalOptions,
  ): Promise<MemoryRetrievalResult> {
    const { partition, sourceFileFingerprint, target, maxEntries, maxChars } =
      options

    const lexicalEntries = await this.store.query({
      partition,
      sourceFileFingerprint,
      target,
      maxEntries,
      maxChars,
    })
    const lexicalKeys = lexicalEntries.map((entry) => entry.memoryKey)
    const candidateCounts: Record<MemoryRetrievalPath, number> = {
      lexical: lexicalKeys.length,
      vector: 0,
      graph: 0,
    }
    let candidateLimitHit = lexicalKeys.length >= maxEntries
    const paths: MemoryRetrievalPath[] = ['lexical']
    const rankedLists: string[][] = [lexicalKeys]

    // Semantic path: query embedding → cosine Top-N.
    const vectorKeys = await this.retrieveViaVector(options)
    candidateCounts.vector = vectorKeys.length
    if (vectorKeys.length > 0) {
      if (vectorKeys.length >= maxEntries) candidateLimitHit = true
      paths.push('vector')
      rankedLists.push(vectorKeys)
    }

    // Graph path: expand from the top lexical seeds via keyword-Jaccard edges.
    const graphKeys = await this.retrieveViaGraph(options, lexicalEntries)
    candidateCounts.graph = graphKeys.length
    if (graphKeys.length > 0) {
      if (graphKeys.length >= maxEntries) candidateLimitHit = true
      paths.push('graph')
      rankedLists.push(graphKeys)
    }

    return {
      memoryKeys: fuseMemoryRecallRanks(...rankedLists),
      paths,
      candidateCounts,
      candidateLimitHit,
    }
  }

  private async retrieveViaVector(
    options: MemoryRetrievalOptions,
  ): Promise<string[]> {
    try {
      const queryText = options.target.query ?? ''
      const queryEmbedding = await options.embedQuery(queryText)
      if (!queryEmbedding || queryEmbedding.length === 0) return []
      const hits = this.embeddings.search(
        options.partition.partitionKey,
        queryEmbedding,
        options.maxEntries,
      )
      return hits.map((hit) => hit.memoryKey)
    } catch (error) {
      console.warn(
        '[YOLO] Memory vector recall failed; skipping vector path',
        error,
      )
      return []
    }
  }

  private async retrieveViaGraph(
    options: MemoryRetrievalOptions,
    lexicalEntries: readonly { memoryKey: string }[],
  ): Promise<string[]> {
    const seeds = lexicalEntries.slice(
      0,
      Math.max(1, Math.floor(options.maxEntries / 2)),
    )
    if (seeds.length === 0) return []
    try {
      const expanded = await this.store.expandViaEdges({
        partition: options.partition,
        seeds: seeds as never,
        target: options.target,
        maxEntries: options.maxEntries,
      })
      return expanded.map((entry) => entry.memoryKey)
    } catch (error) {
      console.warn(
        '[YOLO] Memory graph recall failed; skipping graph path',
        error,
      )
      return []
    }
  }
}
