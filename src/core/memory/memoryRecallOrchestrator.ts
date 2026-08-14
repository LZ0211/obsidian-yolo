import type { MemoryIndexMaintenanceStore } from './memoryIndex'
import { MemoryEmbeddingStore } from './memoryEmbeddings'
import { MemoryRetrievalService } from './memoryRetrieval'
import {
  type MemoryRecallTarget,
  buildMemoryRecallTargetWithJieba,
  type MemoryRecallTargetInput,
} from './memoryRecallTarget'
import type { MemoryPartition } from './memoryTypes'

/**
 * Production recall orchestration: builds the recall target (jieba-enhanced
 * lexical keywords), runs the three-path RRF retrieval over the SQLite
 * memory index, and resolves the fused memory keys back to full entries.
 *
 * This is the entry point the session context builder uses so the memory
 * subsystem (index + RRF + vector + graph) actually feeds production
 * conversations instead of only the full-markdown fallback.
 */

export type MemoryRecallContext = {
  partition: MemoryPartition
  sourceFileFingerprint: string
  entries: readonly MemoryAgentEntryLike[]
  paths: readonly ('lexical' | 'vector' | 'graph')[]
}

export type MemoryAgentEntryLike = { memoryKey: string } & Record<
  string,
  unknown
>

export const MAX_RECALL_ENTRIES = 8
export const MAX_RECALL_CHARS = 3000
export const MAX_RECALL_RECENT_USER_MESSAGES = 5

const entryChars = (entry: MemoryAgentEntryLike): number =>
  typeof entry.content === 'string' ? entry.content.length : 0

export class MemoryRecallOrchestrator {
  private readonly retrieval: MemoryRetrievalService

  constructor(
    private readonly store: MemoryIndexMaintenanceStore & {
      query(input: unknown): Promise<readonly MemoryAgentEntryLike[]>
    },
    embeddings: MemoryEmbeddingStore,
    private readonly embedQuery: (query: string) => Promise<number[] | null>,
  ) {
    this.retrieval = new MemoryRetrievalService(store as never, embeddings)
  }

  async recall(
    input: MemoryRecallTargetInput,
    partition: MemoryPartition,
    sourceFileFingerprint: string,
  ): Promise<MemoryRecallContext> {
    const target = await buildMemoryRecallTargetWithJieba(input)
    const result = await this.retrieval.retrieve({
      partition,
      sourceFileFingerprint,
      target,
      maxEntries: MAX_RECALL_ENTRIES,
      maxChars: MAX_RECALL_CHARS,
      embedQuery: this.embedQuery,
    })

    // Resolve fused memory keys back to full entries in the fused order. A
    // lexical re-query would only return its own top rows and could discard
    // vector/graph-only hits before the fused result is rendered.
    const allEntries = await this.store.query({
      partition,
      sourceFileFingerprint,
      target,
      memoryKeys: result.memoryKeys,
      maxEntries: MAX_RECALL_ENTRIES,
      maxChars: MAX_RECALL_CHARS,
    })
    const byKey = new Map(allEntries.map((entry) => [entry.memoryKey, entry]))
    const entries = result.memoryKeys
      .map((key) => byKey.get(key))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .slice(0, MAX_RECALL_ENTRIES)

    // Reinforce only lexical hits: store.query also returns category-priority
    // entries that never matched the query, and strengthening those would
    // reward noise. Fire-and-forget so a reinforce failure never delays the
    // request path.
    const hitKeys = entries
      .filter((entry) => this.isLexicalHit(entry, target.keywords))
      .map((entry) => entry.memoryKey)
    if (hitKeys.length > 0) {
      void this.reinforceHits(hitKeys, partition).catch((error) => {
        console.error('[YOLO][Memory] recall reinforce failed', error)
      })
    }

    return {
      partition,
      sourceFileFingerprint,
      entries,
      paths: result.paths,
    }
  }

  private isLexicalHit(
    entry: MemoryAgentEntryLike,
    queryKeywords: readonly string[],
  ): boolean {
    const entryKeywords = Array.isArray(entry.keywords)
      ? entry.keywords.filter(
          (keyword): keyword is string => typeof keyword === 'string',
        )
      : []
    if (
      entryKeywords.some((keyword) =>
        queryKeywords.some((queryKeyword) => keyword === queryKeyword),
      )
    )
      return true
    const content = typeof entry.content === 'string' ? entry.content : ''
    return queryKeywords.some((keyword) => content.includes(keyword))
  }

  private async reinforceHits(
    memoryKeys: readonly string[],
    partition: MemoryPartition,
  ): Promise<void> {
    const nowMs = Date.now()
    const prefix = `${partition.partitionKey}::`
    for (const memoryKey of memoryKeys) {
      const localId = memoryKey.slice(prefix.length)
      if (!localId || localId === memoryKey) continue
      await this.store.reinforce({ partition, localId, nowMs })
    }
  }

  /** Render recalled entries into the `<recalled_memory>` prompt block. */
  render(
    context: MemoryRecallContext,
    t: (key: string, fallback: string) => string,
  ): string | null {
    if (context.entries.length === 0) return null
    const parts: string[] = []
    let budget = MAX_RECALL_CHARS
    for (const entry of context.entries) {
      const chars = entryChars(entry)
      if (chars > budget) break
      budget -= chars
      const content =
        typeof entry.content === 'string'
          ? entry.content
          : String(entry.content ?? '')
      const category =
        typeof entry.category === 'string' ? entry.category : 'other'
      parts.push(`[${category}] ${content}`)
    }
    if (parts.length === 0) return null
    const source = context.paths.join('+')
    return `<recalled_memory source="${source}">
${parts.join('\n')}
</recalled_memory>`
  }
}

export type { MemoryRecallTarget, MemoryRecallTargetInput }
