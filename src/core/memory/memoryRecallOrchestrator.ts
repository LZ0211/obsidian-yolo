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

export type MemoryAgentEntryLike = { memoryKey: string } & Record<string, unknown>

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

    // Resolve fused memory keys back to full entries via the lexical query.
    const allEntries = await this.store.query({
      partition,
      sourceFileFingerprint,
      target,
      maxEntries: MAX_RECALL_ENTRIES,
      maxChars: MAX_RECALL_CHARS,
    })
    const byKey = new Map(allEntries.map((entry) => [entry.memoryKey, entry]))
    const entries = result.memoryKeys
      .map((key) => byKey.get(key))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .slice(0, MAX_RECALL_ENTRIES)

    return {
      partition,
      sourceFileFingerprint,
      entries,
      paths: result.paths,
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
        typeof entry.content === 'string' ? entry.content : String(entry.content ?? '')
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
