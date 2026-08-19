import type { FlightSpan } from '../../utils/debug/flightLog'
import { logFlightEvent, startFlightSpan } from '../../utils/debug/flightLog'
import { estimateTextTokens } from '../../utils/llm/contextTokenEstimate'

import { MemoryEmbeddingStore } from './memoryEmbeddings'
import type { MemoryIndexMaintenanceStore } from './memoryIndex'
import {
  type MemoryRecallTarget,
  type MemoryRecallTargetInput,
  buildMemoryRecallTargetWithJieba,
} from './memoryRecallTarget'
import { MemoryRetrievalService } from './memoryRetrieval'
import type { MemoryPartition, MemoryRecallRenderResult } from './memoryTypes'

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
  /** Per-path candidate counts recorded by the retrieval layer. */
  candidateCounts: Readonly<Record<'lexical' | 'vector' | 'graph', number>>
  /** True when any retrieval path reached the candidate entry cap. */
  candidateLimitHit: boolean
}

export type MemoryAgentEntryLike = { memoryKey: string } & Record<
  string,
  unknown
>

/**
 * C1+C2 budget layering. The CANDIDATE limits bound the query layer so an
 * unhealthy index (pathological data volume) cannot balloon a single recall;
 * only the final render applies the RENDER entry cap and token budget. These
 * are this project's first-version safety numbers — they change only through
 * this project's own metrics, never by copying another project's tuning.
 */
export const MAX_RECALL_CANDIDATE_ENTRIES = 32
export const MAX_RECALL_CANDIDATE_CHARS = 12_000
export const MAX_RECALL_RENDER_ENTRIES = 8
export const MAX_RECALL_RENDER_TOKENS = 768
export const MAX_RECALL_RECENT_USER_MESSAGES = 5

/** A packable recall line: `[category] content` with the given content. */
export type MemoryRecallPackLine = Readonly<{
  content: string
  category: string
}>

/** Coerce an entry's unknown content into the string the packer renders. */
const toEntryContent = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

/**
 * Injecting limits keeps the packer deterministically testable. `maxTokens`
 * is the binding budget; `maxEntries` is the final-output max-entry safety
 * cap (spec 6.2) and is optional so tight-budget tests can omit it.
 */
export type MemoryRecallPackLimits = Readonly<{
  maxTokens: number
  maxEntries?: number
}>

const OMITTED_NOTICE_KEY = 'memory.recall.more-omitted'

const buildRecallBlock = (source: string, lines: readonly string[]): string =>
  `<recalled_memory source="${source}">\n${lines.join('\n')}\n</recalled_memory>`

const buildEntryLine = (line: MemoryRecallPackLine, content: string): string =>
  `[${line.category}] ${content}`

/** One selected entry; `content` is the (possibly truncated) rendered text. */
type SelectedEntry = {
  packLine: MemoryRecallPackLine
  content: string
  truncated: boolean
}

const lineOf = (entry: SelectedEntry): string =>
  buildEntryLine(entry.packLine, entry.content)

/**
 * Longest code-point-safe prefix of `line.content` such that the block built
 * from `selected` plus the prefix line stays within `maxTokens`. Returns null
 * when even a one-code-point prefix does not fit.
 */
const longestFittingPrefix = async (
  line: MemoryRecallPackLine,
  selected: readonly SelectedEntry[],
  source: string,
  maxTokens: number,
): Promise<string | null> => {
  const codePoints = Array.from(line.content)
  if (codePoints.length === 0) return null
  let low = 1
  let high = codePoints.length
  let best = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    const block = buildRecallBlock(source, [
      ...selected.map(lineOf),
      buildEntryLine(line, codePoints.slice(0, mid).join('')),
    ])
    if ((await estimateTextTokens(block)) <= maxTokens) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best === 0 ? null : codePoints.slice(0, best).join('')
}

/**
 * Same search as `longestFittingPrefix` but for an entry already inside
 * `entries` (shrinking it in place), with an optional extra trailing line
 * (the omission notice or the full line of a later candidate).
 */
const longestFittingPrefixOfEntry = async (
  entries: readonly SelectedEntry[],
  index: number,
  source: string,
  maxTokens: number,
  extraLine: string | null,
): Promise<string | null> => {
  const entry = entries[index]
  const codePoints = Array.from(entry.content)
  if (codePoints.length === 0) return null
  let low = 1
  let high = codePoints.length
  let best = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    const lines = entries.map((other, otherIndex) =>
      otherIndex === index
        ? buildEntryLine(other.packLine, codePoints.slice(0, mid).join(''))
        : lineOf(other),
    )
    const block = buildRecallBlock(
      source,
      extraLine ? [...lines, extraLine] : lines,
    )
    if ((await estimateTextTokens(block)) <= maxTokens) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best === 0 ? null : codePoints.slice(0, best).join('')
}

/**
 * Spec 6.4: a long entry must not prevent later short entries from entering
 * the result. When a candidate's full line does not fit the remaining budget,
 * try to win back space from earlier TRUNCATED entries (most recent first,
 * down to a one-code-point floor) so the candidate can enter at full length.
 * Shrinks are applied only when the full line then fits.
 */
const stealSpaceForFullEntry = async (
  packLine: MemoryRecallPackLine,
  selected: readonly SelectedEntry[],
  source: string,
  maxTokens: number,
): Promise<boolean> => {
  if (!selected.some((entry) => entry.truncated)) return false
  const fullLine = buildEntryLine(packLine, packLine.content)
  const over =
    (await estimateTextTokens(
      buildRecallBlock(source, [...selected.map(lineOf), fullLine]),
    )) - maxTokens
  if (over <= 0) return false
  const work = selected.map((entry) => ({ ...entry }))
  let remaining = over
  for (let index = work.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const entry = work[index]
    if (!entry.truncated) continue
    const codePoints = Array.from(entry.content)
    if (codePoints.length <= 1) continue
    const shrink = Math.min(remaining, codePoints.length - 1)
    entry.content = codePoints.slice(0, codePoints.length - shrink).join('')
    remaining -= shrink
  }
  if (remaining > 0) return false
  // The code-point deficit is exact for the test seam; a real tokenizer can
  // be non-additive, so verify and refine the shrunk entries with binary
  // search before applying anything.
  if (
    (await estimateTextTokens(
      buildRecallBlock(source, [...work.map(lineOf), fullLine]),
    )) > maxTokens
  ) {
    for (let index = work.length - 1; index >= 0; index -= 1) {
      if (!work[index].truncated) continue
      const refined = await longestFittingPrefixOfEntry(
        work,
        index,
        source,
        maxTokens,
        fullLine,
      )
      if (refined === null) return false
      work[index].content = refined
      if (
        (await estimateTextTokens(
          buildRecallBlock(source, [...work.map(lineOf), fullLine]),
        )) <= maxTokens
      )
        break
    }
  }
  if (
    (await estimateTextTokens(
      buildRecallBlock(source, [...work.map(lineOf), fullLine]),
    )) > maxTokens
  )
    return false
  for (let index = 0; index < work.length; index += 1) {
    selected[index].content = work[index].content
  }
  return true
}

/**
 * Try to append the `[+N more omitted]` notice within the same budget. The
 * notice's space is reserved first by re-truncating already-selected
 * truncated entries (most recent first), then by removing selected entries
 * from the tail; when even an empty block cannot hold it, the notice is
 * omitted and the selection is left untouched.
 */
const fitOmittedNotice = async (
  notice: string,
  selected: readonly SelectedEntry[],
  source: string,
  maxTokens: number,
): Promise<readonly SelectedEntry[] | null> => {
  const blockWithNotice = (entries: readonly SelectedEntry[]): string =>
    buildRecallBlock(source, [...entries.map(lineOf), notice])
  if ((await estimateTextTokens(blockWithNotice(selected))) <= maxTokens) {
    return selected
  }
  const work = selected.map((entry) => ({ ...entry }))
  for (let index = work.length - 1; index >= 0; index -= 1) {
    if (!work[index].truncated) continue
    const refined = await longestFittingPrefixOfEntry(
      work,
      index,
      source,
      maxTokens,
      notice,
    )
    if (refined !== null) {
      work[index].content = refined
      if ((await estimateTextTokens(blockWithNotice(work))) <= maxTokens) {
        return work
      }
    }
  }
  // Advisory semantics: the `[+N more omitted]` notice counts candidates
  // omitted BEFORE this notice-fit pass (greedy omissions plus output-cap
  // drops). Entries removed here to make room for the notice itself are NOT
  // reflected in N — the caller keeps the pre-fit `omittedCount` and only the
  // rendered selection shrinks, so N may understate the true skip count.
  while (work.length > 0) {
    work.pop()
    if ((await estimateTextTokens(blockWithNotice(work))) <= maxTokens) {
      return work
    }
  }
  return null
}

const packGreedy = async (
  lines: readonly MemoryRecallPackLine[],
  source: string,
  maxTokens: number,
): Promise<{ selected: SelectedEntry[]; omittedCount: number }> => {
  const selected: SelectedEntry[] = []
  let omittedCount = 0
  for (const packLine of lines) {
    const fullLine = buildEntryLine(packLine, packLine.content)
    if (
      (await estimateTextTokens(
        buildRecallBlock(source, [...selected.map(lineOf), fullLine]),
      )) <= maxTokens
    ) {
      selected.push({ packLine, content: packLine.content, truncated: false })
      continue
    }
    if (await stealSpaceForFullEntry(packLine, selected, source, maxTokens)) {
      selected.push({ packLine, content: packLine.content, truncated: false })
      continue
    }
    const prefix = await longestFittingPrefix(
      packLine,
      selected,
      source,
      maxTokens,
    )
    if (prefix !== null) {
      selected.push({ packLine, content: prefix, truncated: true })
      continue
    }
    // No non-empty prefix fits: omit and keep trying later candidates.
    omittedCount += 1
  }
  return { selected, omittedCount }
}

/**
 * Pack `lines` into a `<recalled_memory>` block under the token budget. The
 * full output — XML wrapper, newlines, `[category] ` prefixes and the
 * omission notice — is tokenized through `estimateTextTokens` (the project's
 * only production token counter; the text cache is reused). Shared by the
 * indexed recall path and the Markdown fallback so the SQLite-outage path
 * cannot exceed the final budget with a second, character-based budget.
 */
export const packMemoryRecallLines = async (
  lines: readonly MemoryRecallPackLine[],
  source: string,
  limits: MemoryRecallPackLimits,
  t: (key: string, fallback: string) => string,
): Promise<MemoryRecallRenderResult> => {
  if (lines.length === 0) {
    return {
      content: null,
      tokenCount: 0,
      selectedCount: 0,
      truncatedCount: 0,
      omittedCount: 0,
    }
  }
  if (
    (await estimateTextTokens(buildRecallBlock(source, []))) > limits.maxTokens
  ) {
    return {
      content: null,
      tokenCount: 0,
      selectedCount: 0,
      truncatedCount: 0,
      omittedCount: lines.length,
    }
  }
  const packed = await packGreedy(lines, source, limits.maxTokens)
  // Final-output max-entry safety cap (spec 6.2): the greedy pass iterates
  // every candidate ("never break"), so entries beyond the cap are dropped
  // from the tail and count toward the omission notice.
  let selected = packed.selected
  let omittedCount = packed.omittedCount
  if (limits.maxEntries !== undefined && selected.length > limits.maxEntries) {
    omittedCount += selected.length - limits.maxEntries
    selected = selected.slice(0, limits.maxEntries)
  }
  let notice: string | null = null
  if (omittedCount > 0) {
    notice = t(OMITTED_NOTICE_KEY, `[+${omittedCount} more omitted]`)
    const fitted = await fitOmittedNotice(
      notice,
      selected,
      source,
      limits.maxTokens,
    )
    if (fitted !== null) selected = [...fitted]
    else notice = null
  }
  const content = buildRecallBlock(source, [
    ...selected.map(lineOf),
    ...(notice ? [notice] : []),
  ])
  const tokenCount = await estimateTextTokens(content)
  return {
    content,
    tokenCount,
    selectedCount: selected.length,
    truncatedCount: selected.filter((entry) => entry.truncated).length,
    omittedCount,
  }
}

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
    const recallStartedAt = Date.now()
    const recallSpan = startFlightSpan('memory', 'recall', {
      id: partition.partitionKey,
    })
    try {
      return await this.runRecall({
        input,
        partition,
        sourceFileFingerprint,
        recallStartedAt,
        recallSpan,
      })
    } catch (error) {
      recallSpan.finish(
        `error=${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  private async runRecall({
    input,
    partition,
    sourceFileFingerprint,
    recallStartedAt,
    recallSpan,
  }: {
    input: MemoryRecallTargetInput
    partition: MemoryPartition
    sourceFileFingerprint: string
    recallStartedAt: number
    recallSpan: FlightSpan
  }): Promise<MemoryRecallContext> {
    const target = await buildMemoryRecallTargetWithJieba(input)
    const result = await this.retrieval.retrieve({
      partition,
      sourceFileFingerprint,
      target,
      maxEntries: MAX_RECALL_CANDIDATE_ENTRIES,
      maxChars: MAX_RECALL_CANDIDATE_CHARS,
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
      maxEntries: MAX_RECALL_CANDIDATE_ENTRIES,
      maxChars: MAX_RECALL_CANDIDATE_CHARS,
    })
    const byKey = new Map(allEntries.map((entry) => [entry.memoryKey, entry]))
    const entries = result.memoryKeys
      .map((key) => byKey.get(key))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .slice(0, MAX_RECALL_RENDER_ENTRIES)

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

    recallSpan.finish(
      `hits=${entries.length} paths=${result.paths.join('+')} ${Date.now() - recallStartedAt}ms`,
    )
    return {
      partition,
      sourceFileFingerprint,
      entries,
      paths: result.paths,
      candidateCounts: result.candidateCounts,
      candidateLimitHit: result.candidateLimitHit,
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

  /**
   * Render recalled entries into a `<recalled_memory>` prompt block under the
   * final token budget (C1+C2). Delegates the token packing (including the
   * final-output entry cap) to `packMemoryRecallLines`. `limits` is
   * injectable so the budget boundaries are deterministically testable.
   */
  async render(
    context: MemoryRecallContext,
    t: (key: string, fallback: string) => string,
    limits: MemoryRecallPackLimits = {
      maxTokens: MAX_RECALL_RENDER_TOKENS,
      maxEntries: MAX_RECALL_RENDER_ENTRIES,
    },
  ): Promise<MemoryRecallRenderResult> {
    const lines = context.entries.map((entry) => ({
      content: toEntryContent(entry.content),
      category: typeof entry.category === 'string' ? entry.category : 'other',
    }))
    const result = await packMemoryRecallLines(
      lines,
      context.paths.join('+'),
      limits,
      t,
    )
    const totalCandidates = Object.values(context.candidateCounts).reduce(
      (sum, count) => sum + count,
      0,
    )
    logFlightEvent('memory', 'recall-render', {
      id: context.partition.partitionKey,
      detail: `candidates=${totalCandidates} entries=${lines.length} selected=${result.selectedCount} tokens=${result.tokenCount} truncated=${result.truncatedCount} omitted=${result.omittedCount} limitHit=${context.candidateLimitHit}`,
      consoleOutput: 'none',
    })
    return result
  }
}

export type { MemoryRecallTarget, MemoryRecallTargetInput }
