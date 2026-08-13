import type { App } from 'obsidian'

import { DEFAULT_MEMORY_AGENT_PROMPT } from '../../constants/memory-agent-prompt'
import type { ChatModel } from '../../types/chat-model.types'
import type { LLMProvider } from '../../types/provider.types'
import { buildMemoryExtractionContract } from '../agent/prompt-contracts'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

import { buildMemoryKey, buildMemoryPartition } from './memoryIndex'
import {
  type MemoryPromptContext,
  type MemoryScope,
  type MemorySettingsLike,
  getMemoryPromptContext,
  memoryAdd,
  memoryDelete,
  memoryUpdate,
} from './memoryManager'
import type { MemoryRecallTarget } from './memoryRecallTarget'
import { extractMemoryQueryKeywords } from './memoryTokenizer'
import type { MemoryAgentEntry, MemorySector } from './memoryTypes'

export type { MemoryAgentEntry } from './memoryTypes'

type AutomaticMemorySector = Exclude<MemorySector, 'reflective'>

export type MemoryAgentOperation =
  | {
      op: 'add'
      content: string
      category?: MemoryAgentEntry['category']
      scope?: MemoryScope
      keywords?: string[]
      sector?: AutomaticMemorySector
      reason?: string
    }
  | {
      op: 'update'
      id: string
      new_content: string
      scope?: MemoryScope
      keywords?: string[]
      sector?: AutomaticMemorySector
      reason?: string
    }
  | {
      op: 'delete'
      id: string
      scope?: MemoryScope
    }

export type MemoryAgentSourceCommitted = (input: {
  partition: ReturnType<typeof buildMemoryPartition>
  sourcePath: string
  sectorHints?: Readonly<Record<string, MemorySector | null>>
}) => void | Promise<void>

export type MemoryAgentTurnInput = {
  app: App
  settings?: MemorySettingsLike
  assistantId?: string
  userText: string
  assistantText: string
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  signal?: AbortSignal
  onSourceCommitted?: MemoryAgentSourceCommitted
}

export type MemoryAgentModelTarget = Pick<
  MemoryAgentTurnInput,
  'providerClient' | 'model'
>

export const MAX_EXTRACTION_MEMORY_CHARS = 12_000

const MEMORY_ENTRY_RE = /^\s*[-*]\s+([^:：]+)\s*[:：]\s*(.*?)\s*$/
const MEMORY_KEYWORDS_RE = /\s*<!--\s*keywords:\s*(.*?)\s*-->\s*$/i
const MEMORY_SIGNAL_RE =
  /(记住|记得|以后|总是|习惯|偏好|喜欢|不喜欢|不要再|我的|我叫|我在|remember|preference|prefer|always|never|i am|i'm|that's wrong|you misunderstood)/i

const normalizeText = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ')

const isAutomaticMemorySector = (
  value: unknown,
): value is AutomaticMemorySector =>
  value === 'episodic' ||
  value === 'semantic' ||
  value === 'procedural' ||
  value === 'emotional'

const defaultSectorForCategory = (
  category: MemoryAgentEntry['category'] | undefined,
): AutomaticMemorySector =>
  category === 'profile' || category === 'preferences' ? 'semantic' : 'episodic'

export const MAX_RECALL_ENTRIES = 8
export const MAX_RECALL_CHARS = 3000

const MEMORY_RECALL_HEADER =
  '<memory_context>\nHistorical memory only. Current user request wins conflicts.\n'
const MEMORY_RECALL_FOOTER = '\n</memory_context>'

const escapeMemoryValue = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const renderMemoryRecallEntry = (entry: MemoryAgentEntry): string =>
  `- [${entry.scope}/${entry.category}/${escapeMemoryValue(entry.id)}] ${escapeMemoryValue(entry.content)}`

const fitMemoryRecallEntries = ({
  entries,
  maxEntries,
  maxChars,
}: {
  entries: MemoryAgentEntry[]
  maxEntries: number
  maxChars: number
}): MemoryAgentEntry[] => {
  if (maxChars < MEMORY_RECALL_HEADER.length + MEMORY_RECALL_FOOTER.length) {
    return []
  }

  const selected: MemoryAgentEntry[] = []
  let usedChars = MEMORY_RECALL_HEADER.length + MEMORY_RECALL_FOOTER.length
  for (const entry of entries) {
    if (selected.length >= Math.max(0, maxEntries)) break
    const separatorChars = selected.length > 0 ? 1 : 0
    const entryChars = separatorChars + renderMemoryRecallEntry(entry).length
    if (usedChars + entryChars > maxChars) continue
    selected.push(entry)
    usedChars += entryChars
  }
  return selected
}

const scoreEntry = (entry: MemoryAgentEntry, query: string): number => {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) return 0

  const normalizedContent = normalizeText(entry.content)
  const queryTokens = extractMemoryQueryKeywords(normalizedQuery)
  const contentTokens = new Set([
    ...extractMemoryQueryKeywords(normalizedContent),
    ...entry.keywords.flatMap((keyword) => extractMemoryQueryKeywords(keyword)),
  ])
  let score = normalizedContent.includes(normalizedQuery) ? 10 : 0

  for (const token of queryTokens) {
    if (contentTokens.has(token)) score += token.length > 2 ? 3 : 1
  }

  return score
}

export const rankMemoryEntries = (
  entries: MemoryAgentEntry[],
  target: string | MemoryRecallTarget,
): MemoryAgentEntry[] => {
  const query =
    typeof target === 'string'
      ? target
      : [target.query, ...target.keywords, ...target.entities].join('\n')
  const candidates =
    typeof target === 'string'
      ? entries
      : entries.filter(
          (entry) =>
            target.categories.includes(entry.category) &&
            target.scopes.includes(entry.scope),
        )

  return candidates
    .map((entry, index) => ({ entry, index, score: scoreEntry(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      if (left.entry.scope !== right.entry.scope) {
        return left.entry.scope === 'assistant' ? -1 : 1
      }
      return left.index - right.index
    })
    .map(({ entry }) => entry)
}

export const selectAlwaysLoadedMemoryEntries = (
  entries: MemoryAgentEntry[],
): MemoryAgentEntry[] =>
  entries.filter((entry) => entry.category === 'preferences')

const hasMatchingTargetScopeAndCategory = (
  entry: MemoryAgentEntry,
  target: MemoryRecallTarget,
): boolean =>
  target.categories.includes(entry.category) &&
  target.scopes.includes(entry.scope)

const deduplicateMemoryEntries = (
  entries: MemoryAgentEntry[],
): MemoryAgentEntry[] => {
  const preferred = [...entries].sort((left, right) => {
    if (left.scope !== right.scope) return left.scope === 'assistant' ? -1 : 1
    return 0
  })
  const seenContent = new Set<string>()
  return preferred.filter((entry) => {
    const key = normalizeText(entry.content)
    if (seenContent.has(key)) return false
    seenContent.add(key)
    return true
  })
}

/** Select one bounded recall set; preferences lead, but share the same limits as facts. */
export const selectMemoryRecallEntries = (
  entries: MemoryAgentEntry[],
  target: MemoryRecallTarget,
  maxEntries = MAX_RECALL_ENTRIES,
  maxChars = MAX_RECALL_CHARS,
): MemoryAgentEntry[] => {
  const candidates = deduplicateMemoryEntries(
    entries.filter((entry) => hasMatchingTargetScopeAndCategory(entry, target)),
  )
  const preferences = candidates.filter(
    (entry) => entry.category === 'preferences',
  )
  const facts = rankMemoryEntries(
    candidates.filter((entry) => entry.category !== 'preferences'),
    target,
  )
  return fitMemoryRecallEntries({
    entries: [...preferences, ...facts],
    maxEntries,
    maxChars,
  })
}

export const shouldProcessMemoryTurn = (userText: string): boolean =>
  MEMORY_SIGNAL_RE.test(userText.trim())

const extractJsonObject = (content: string): string | null => {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  return start >= 0 && end > start ? content.slice(start, end + 1) : null
}

export const parseMemoryAgentOperations = (
  content: string,
): MemoryAgentOperation[] => {
  const raw = extractJsonObject(content)
  if (!raw) return []

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return []
  }
  if (!decoded || typeof decoded !== 'object') return []
  const operations = (decoded as { operations?: unknown }).operations
  if (!Array.isArray(operations)) return []

  return operations.flatMap((operation): MemoryAgentOperation[] => {
    if (!operation || typeof operation !== 'object') return []
    const value = operation as Record<string, unknown>
    const scope =
      value.scope === undefined
        ? undefined
        : value.scope === 'global' || value.scope === 'assistant'
          ? value.scope
          : null
    const keywords =
      value.keywords === undefined
        ? undefined
        : Array.isArray(value.keywords) &&
            value.keywords.every((keyword) => typeof keyword === 'string')
          ? value.keywords
          : null
    if (scope === null || keywords === null) return []
    if (value.op === 'add') {
      if (
        typeof value.content !== 'string' ||
        !value.content.trim() ||
        (value.category !== undefined &&
          value.category !== 'profile' &&
          value.category !== 'preferences' &&
          value.category !== 'other')
      ) {
        return []
      }
      if (
        value.sector !== undefined &&
        !isAutomaticMemorySector(value.sector)
      ) {
        return []
      }
      const reason =
        value.reason === undefined
          ? undefined
          : typeof value.reason === 'string' && value.reason.trim()
            ? value.reason.trim()
            : null
      if (reason === null) return []
      return [
        {
          op: 'add',
          content: value.content,
          ...(value.category === undefined ? {} : { category: value.category }),
          ...(scope === undefined ? {} : { scope }),
          ...(keywords === undefined ? {} : { keywords }),
          ...(reason === undefined ? {} : { reason }),
          sector:
            value.sector === undefined
              ? defaultSectorForCategory(value.category)
              : value.sector,
        },
      ]
    }
    if (value.op === 'update') {
      if (
        typeof value.id !== 'string' ||
        typeof value.new_content !== 'string' ||
        !value.id.trim() ||
        !value.new_content.trim()
      ) {
        return []
      }
      if (
        value.sector !== undefined &&
        !isAutomaticMemorySector(value.sector)
      ) {
        return []
      }
      const reason =
        value.reason === undefined
          ? undefined
          : typeof value.reason === 'string' && value.reason.trim()
            ? value.reason.trim()
            : null
      if (reason === null) return []
      return [
        {
          op: 'update',
          id: value.id,
          new_content: value.new_content,
          ...(scope === undefined ? {} : { scope }),
          ...(keywords === undefined ? {} : { keywords }),
          ...(value.sector === undefined ? {} : { sector: value.sector }),
          ...(reason === undefined ? {} : { reason }),
        },
      ]
    }
    if (
      value.op !== 'delete' ||
      typeof value.id !== 'string' ||
      !value.id.trim()
    ) {
      return []
    }
    return [
      {
        op: 'delete',
        id: value.id,
        ...(scope === undefined ? {} : { scope }),
      },
    ]
  })
}

const parseEntries = (
  content: string | null,
  scope: MemoryScope,
): MemoryAgentEntry[] => {
  if (!content) return []

  return content
    .split(/\r?\n/)
    .map((line) => line.match(MEMORY_ENTRY_RE))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const id = match[1]?.trim() ?? ''
      const rawValue = match[2]?.trim() ?? ''
      const keywordMatch = rawValue.match(MEMORY_KEYWORDS_RE)
      const value = (
        keywordMatch ? rawValue.replace(keywordMatch[0], '') : rawValue
      ).trim()
      const keywords = keywordMatch
        ? keywordMatch[1]
            .split(',')
            .map((keyword) => keyword.trim())
            .filter(Boolean)
        : []
      const category: MemoryAgentEntry['category'] = id.startsWith('Profile_')
        ? 'profile'
        : id.startsWith('Preference_')
          ? 'preferences'
          : 'other'
      return { id, content: value, keywords, category, scope }
    })
    .filter((entry) => entry.id.length > 0 && entry.content.length > 0)
}

export const loadMemoryAgentEntries = async ({
  app,
  settings,
  assistantId,
  context,
}: {
  app: App
  settings?: Parameters<typeof getMemoryPromptContext>[0]['settings']
  assistantId?: string
  context?: MemoryPromptContext
}): Promise<MemoryAgentEntry[]> => {
  const resolvedContext =
    context ?? (await getMemoryPromptContext({ app, settings, assistantId }))
  return [
    ...parseEntries(resolvedContext.global, 'global'),
    ...parseEntries(resolvedContext.assistant, 'assistant'),
  ]
}

export const buildBoundedMemoryExtractionContext = (
  entries: MemoryAgentEntry[],
  query: string,
  maxChars = MAX_EXTRACTION_MEMORY_CHARS,
): { content: string; omittedEntryCount: number } => {
  const ordered = [
    ...entries.filter(
      (entry) =>
        entry.scope === 'assistant' && entry.category === 'preferences',
    ),
    ...entries.filter(
      (entry) => entry.scope === 'global' && entry.category === 'preferences',
    ),
    ...entries.filter((entry) => entry.category === 'profile'),
    ...rankMemoryEntries(
      entries.filter((entry) => entry.category === 'other'),
      query,
    ),
  ]
  const selected: MemoryAgentEntry[] = []
  let usedChars = 0
  for (const entry of ordered) {
    const rendered = `- [${entry.scope}/${entry.id}] ${entry.content}`
    if (selected.length > 0 && usedChars + rendered.length + 1 > maxChars) {
      continue
    }
    if (rendered.length > maxChars && selected.length === 0) {
      continue
    }
    selected.push(entry)
    usedChars += rendered.length + 1
  }
  let omittedEntryCount = ordered.length - selected.length
  let omission =
    omittedEntryCount > 0
      ? `\n\n[${omittedEntryCount} memory entries omitted due to extraction budget.]`
      : ''
  while (
    selected.length > 0 &&
    selected
      .map((entry) => `- [${entry.scope}/${entry.id}] ${entry.content}`)
      .join('\n').length +
      omission.length >
      maxChars
  ) {
    selected.pop()
    omittedEntryCount = ordered.length - selected.length
    omission = `\n\n[${omittedEntryCount} memory entries omitted due to extraction budget.]`
  }
  return {
    content:
      selected
        .map((entry) => `- [${entry.scope}/${entry.id}] ${entry.content}`)
        .join('\n') + omission,
    omittedEntryCount,
  }
}

const operationScope = (operation: MemoryAgentOperation): MemoryScope =>
  operation.scope ?? 'assistant'

type MemoryAgentWriteResult = {
  id: string
  scope: MemoryScope
  filePath: string
  skipped?: true
}

const notifyAutomaticSourceCommitted = async ({
  callback,
  assistantId,
  operation,
  result,
}: {
  callback?: MemoryAgentSourceCommitted
  assistantId?: string
  operation: MemoryAgentOperation
  result: MemoryAgentWriteResult
}): Promise<void> => {
  if (!callback || result.skipped) return

  const partition =
    result.scope === 'global'
      ? buildMemoryPartition({ scope: 'global' })
      : assistantId?.trim()
        ? buildMemoryPartition({ scope: 'assistant', assistantId })
        : null
  if (!partition) return

  const memoryKey = buildMemoryKey(partition.partitionKey, result.id)
  const sectorHints =
    operation.op === 'add'
      ? {
          [memoryKey]:
            operation.sector ?? defaultSectorForCategory(operation.category),
        }
      : operation.op === 'update'
        ? { [memoryKey]: operation.sector ?? null }
        : undefined

  try {
    await callback({
      partition,
      sourcePath: result.filePath,
      ...(sectorHints ? { sectorHints } : {}),
    })
  } catch {
    return
  }
}

const entryMatchesSnapshot = (
  snapshot: MemoryAgentEntry,
  latest: MemoryAgentEntry,
): boolean =>
  snapshot.content === latest.content &&
  snapshot.category === latest.category &&
  snapshot.keywords.length === latest.keywords.length &&
  snapshot.keywords.every(
    (keyword, index) => keyword === latest.keywords[index],
  )

export const filterMemoryAgentOperationsForLatestState = ({
  operations,
  visibleEntries,
  latestEntries,
}: {
  operations: MemoryAgentOperation[]
  visibleEntries: MemoryAgentEntry[]
  latestEntries: MemoryAgentEntry[]
}): MemoryAgentOperation[] => {
  return operations.filter((operation) => {
    const scope = operationScope(operation)
    if (operation.op === 'add') {
      return !latestEntries.some(
        (entry) =>
          entry.scope === scope &&
          normalizeText(entry.content) === normalizeText(operation.content),
      )
    }
    const visible = visibleEntries.find(
      (entry) => entry.id === operation.id && entry.scope === scope,
    )
    const current = latestEntries.find(
      (entry) => entry.id === operation.id && entry.scope === scope,
    )
    return Boolean(visible && current && entryMatchesSnapshot(visible, current))
  })
}

export const selectRelevantMemoryEntries = (
  entries: MemoryAgentEntry[],
  target: string | MemoryRecallTarget,
  maxEntries = 8,
  maxChars = 3000,
): MemoryAgentEntry[] => {
  const query = typeof target === 'string' ? target : target.query
  if (!query.trim()) return []
  const selected: MemoryAgentEntry[] = []
  let usedChars = 0

  for (const entry of rankMemoryEntries(
    entries.filter((candidate) => candidate.category !== 'preferences'),
    target,
  )) {
    const entryChars = entry.id.length + entry.content.length + 8
    if (selected.length >= Math.max(1, maxEntries)) break
    if (selected.length > 0 && usedChars + entryChars > maxChars) break
    selected.push(entry)
    usedChars += entryChars
  }

  return selected
}

export const recallMemoryEntries = async ({
  app,
  settings,
  assistantId,
  query,
  maxEntries = 8,
  maxChars = 3000,
}: {
  app: App
  settings?: Parameters<typeof getMemoryPromptContext>[0]['settings']
  assistantId?: string
  query: string
  maxEntries?: number
  maxChars?: number
}): Promise<MemoryAgentEntry[]> => {
  return selectRelevantMemoryEntries(
    await loadMemoryAgentEntries({ app, settings, assistantId }),
    query,
    maxEntries,
    maxChars,
  )
}

const buildMemoryAgentPrompt = ({
  currentMemory,
  userText,
  assistantText,
}: {
  currentMemory: string
  userText: string
  assistantText: string
}): string => `Current memory:
<memory>
${escapeMemoryValue(currentMemory || '(empty)')}
</memory>

User turn:
${escapeMemoryValue(userText)}

Assistant turn:
${escapeMemoryValue(assistantText)}`

const buildMemoryAgentSystemPrompt = (): string =>
  `${DEFAULT_MEMORY_AGENT_PROMPT.en}

${buildMemoryExtractionContract()}

Use scope "global" for user-wide facts/preferences and "assistant" only for assistant-specific context. Prefer updating an existing entry instead of creating a duplicate. Return {"operations":[{"op":"add|update|delete", ...}]}; for add use content, category, scope, keywords, sector; for update use id, new_content, scope, keywords, sector; for delete use id, scope.

Extract durable memory operations. Never call tools. Return strict JSON.`

export const runMemoryAgentAfterTurn = async ({
  app,
  settings,
  assistantId,
  userText,
  assistantText,
  providerClient,
  model,
  signal,
  onSourceCommitted,
}: MemoryAgentTurnInput): Promise<MemoryAgentOperation[]> => {
  if (!shouldProcessMemoryTurn(userText) || signal?.aborted) return []

  const visibleEntries = await loadMemoryAgentEntries({
    app,
    settings,
    assistantId,
  })
  const currentMemory = buildBoundedMemoryExtractionContext(
    visibleEntries,
    userText,
  )
  const response = await executeSingleTurn({
    providerClient,
    model,
    request: {
      model: model.model,
      messages: [
        {
          role: 'system',
          content: buildMemoryAgentSystemPrompt(),
        },
        {
          role: 'user',
          content: buildMemoryAgentPrompt({
            currentMemory: currentMemory.content,
            userText,
            assistantText,
          }),
        },
      ],
    },
    signal,
    deliveryMode: 'buffered',
    purpose: 'lightweight',
  })
  const operations = parseMemoryAgentOperations(response.content)
  if (signal?.aborted) return []

  const latestEntries = await loadMemoryAgentEntries({
    app,
    settings,
    assistantId,
  })
  const validOperations = filterMemoryAgentOperationsForLatestState({
    operations,
    visibleEntries,
    latestEntries,
  })

  for (const operation of validOperations) {
    if (signal?.aborted) return []
    const shouldWrite = async (): Promise<boolean> => {
      if (signal?.aborted) return false
      const currentEntries = await loadMemoryAgentEntries({
        app,
        settings,
        assistantId,
      })
      return (
        !signal?.aborted &&
        filterMemoryAgentOperationsForLatestState({
          operations: [operation],
          visibleEntries,
          latestEntries: currentEntries,
        }).length > 0
      )
    }
    try {
      let result: MemoryAgentWriteResult
      if (operation.op === 'add') {
        result = await memoryAdd({
          app,
          settings,
          assistantId,
          content: operation.content,
          category: operation.category,
          scope: operation.scope,
          keywords: operation.keywords,
          reason: operation.reason,
          shouldWrite,
        })
      } else if (operation.op === 'update') {
        result = await memoryUpdate({
          app,
          settings,
          assistantId,
          id: operation.id,
          newContent: operation.new_content,
          scope: operation.scope,
          keywords: operation.keywords,
          reason: operation.reason,
          shouldWrite,
        })
      } else {
        result = await memoryDelete({
          app,
          settings,
          assistantId,
          id: operation.id,
          scope: operation.scope,
          shouldWrite,
        })
      }
      await notifyAutomaticSourceCommitted({
        callback: onSourceCommitted,
        assistantId,
        operation,
        result,
      })
    } catch (error) {
      console.warn('[YOLO][MemoryAgent] operation failed', error)
    }
  }

  return validOperations
}

/**
 * Run the hidden memory pass without allowing a provider outage to affect the
 * user-facing turn. A configured lightweight model gets one retry on the
 * current conversation model; the current model itself is never retried.
 */
export const runMemoryAgentWithFallback = async ({
  input,
  fallback,
}: {
  input: MemoryAgentTurnInput
  fallback?: MemoryAgentModelTarget
}): Promise<MemoryAgentOperation[]> => {
  try {
    return await runMemoryAgentAfterTurn(input)
  } catch (error) {
    if (
      !fallback ||
      input.signal?.aborted ||
      fallback.model.id === input.model.id
    ) {
      console.warn('[YOLO][MemoryAgent] background extraction failed', error)
      return []
    }

    console.warn(
      '[YOLO][MemoryAgent] configured model failed; retrying with current model',
      error,
    )
    try {
      return await runMemoryAgentAfterTurn({
        ...input,
        providerClient: fallback.providerClient,
        model: fallback.model,
      })
    } catch (fallbackError) {
      console.warn(
        '[YOLO][MemoryAgent] current model fallback failed; skipping background extraction',
        fallbackError,
      )
      return []
    }
  }
}

export const renderMemoryRecall = (
  entries: MemoryAgentEntry[],
  maxChars = MAX_RECALL_CHARS,
): string => {
  const boundedEntries = fitMemoryRecallEntries({
    entries,
    maxEntries: entries.length,
    maxChars,
  })
  if (boundedEntries.length === 0) return ''
  return `${MEMORY_RECALL_HEADER}${boundedEntries
    .map(renderMemoryRecallEntry)
    .join('\n')}${MEMORY_RECALL_FOOTER}`
}
