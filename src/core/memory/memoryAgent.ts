import type { App } from 'obsidian'

import { DEFAULT_MEMORY_AGENT_PROMPT } from '../../constants/memory-agent-prompt'
import type { ChatModel } from '../../types/chat-model.types'
import type { LLMProvider } from '../../types/provider.types'
import { logFlightEvent } from '../../utils/debug/flightLog'
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

const escapeMemoryValue = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

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

export const shouldProcessMemoryTurn = (userText: string): boolean =>
  Boolean(userText.trim())

const extractJsonCandidates = (content: string): string[] => {
  const candidates: string[] = []
  let start = -1
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '"') {
      quote = character
      continue
    }

    if (depth === 0 && (character === '{' || character === '[')) {
      start = index
      depth = 1
      continue
    }

    if (depth === 0) continue
    if (character === '{' || character === '[') depth += 1
    if (character !== '}' && character !== ']') continue

    depth -= 1
    if (depth === 0 && start >= 0) {
      candidates.push(content.slice(start, index + 1))
      start = -1
    }
  }

  return candidates
}

const parseJsonCandidate = (candidate: string): unknown => {
  const variants = [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]
  for (const variant of variants) {
    try {
      return JSON.parse(variant) as unknown
    } catch {
      continue
    }
  }
  return null
}

const parseMemoryAgentPayload = (content: string): unknown[] => {
  const source = content.replace(/^\uFEFF/, '').trim()
  const payloads: unknown[] = []
  for (const candidate of [source, ...extractJsonCandidates(source)]) {
    const payload = parseJsonCandidate(candidate)
    if (payload !== null) payloads.push(payload)
  }
  return payloads
}

const normalizeOperationName = (
  value: unknown,
): 'add' | 'update' | 'delete' | null => {
  if (typeof value !== 'string') return null
  switch (value.trim().toLowerCase()) {
    case 'add':
    case 'create':
      return 'add'
    case 'update':
    case 'replace':
      return 'update'
    case 'delete':
    case 'remove':
      return 'delete'
    default:
      return null
  }
}

const normalizeAutomaticSector = (
  value: unknown,
): AutomaticMemorySector | null | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return isAutomaticMemorySector(normalized) ? normalized : null
}

const normalizeCategory = (
  value: unknown,
): {
  category?: MemoryAgentEntry['category']
  sector?: AutomaticMemorySector
} | null => {
  if (value === undefined) return {}
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'profile' || normalized === 'user_profile') {
    return { category: 'profile' }
  }
  if (normalized === 'preference' || normalized === 'preferences') {
    return { category: 'preferences' }
  }
  if (normalized === 'reflective') return null
  if (isAutomaticMemorySector(normalized)) {
    return { category: 'other', sector: normalized }
  }
  if (
    normalized === 'other' ||
    normalized === 'memory' ||
    normalized === 'fact'
  ) {
    return { category: 'other' }
  }
  return { category: 'other' }
}

const normalizeKeywords = (value: unknown): string[] | null | undefined => {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    return value.every((keyword) => typeof keyword === 'string')
      ? value.map((keyword) => keyword.trim()).filter(Boolean)
      : null
  }
  if (typeof value === 'string') {
    return value
      .split(/[,，]/)
      .map((keyword) => keyword.trim())
      .filter(Boolean)
  }
  return null
}

const normalizeScope = (value: unknown): MemoryScope | null | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'global' || normalized === 'user') return 'global'
  if (normalized === 'assistant') return 'assistant'
  return null
}

export const parseMemoryAgentOperations = (
  content: string,
): MemoryAgentOperation[] => {
  const payloads = parseMemoryAgentPayload(content)
  const operations = payloads
    .map((payload) => {
      if (Array.isArray(payload)) return payload
      if (!payload || typeof payload !== 'object') return []
      const value = payload as Record<string, unknown>
      if (Array.isArray(value.operations)) return value.operations
      return normalizeOperationName(value.op ?? value.action) ? [payload] : []
    })
    .find((candidate) => candidate.length > 0)
  if (!operations) return []

  return operations.flatMap((operation): MemoryAgentOperation[] => {
    if (!operation || typeof operation !== 'object') return []
    const value = operation as Record<string, unknown>
    const op = normalizeOperationName(value.op ?? value.action)
    const scope = normalizeScope(value.scope)
    const keywords = normalizeKeywords(value.keywords)
    if (scope === null || keywords === null) return []
    if (op === 'add') {
      if (typeof value.content !== 'string' || !value.content.trim()) return []
      const category = normalizeCategory(value.category)
      const sector = normalizeAutomaticSector(value.sector)
      if (!category || sector === null) return []
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
          content: value.content.trim(),
          ...(category.category === undefined
            ? {}
            : { category: category.category }),
          ...(scope === undefined ? {} : { scope }),
          ...(keywords === undefined ? {} : { keywords }),
          ...(reason === undefined ? {} : { reason }),
          sector:
            sector ??
            category.sector ??
            defaultSectorForCategory(category.category),
        },
      ]
    }
    if (op === 'update') {
      const newContent = value.new_content ?? value.newContent ?? value.content
      if (
        typeof value.id !== 'string' ||
        typeof newContent !== 'string' ||
        !value.id.trim() ||
        !newContent.trim()
      ) {
        return []
      }
      const sector = normalizeAutomaticSector(value.sector)
      if (sector === null) return []
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
          id: value.id.trim(),
          new_content: newContent.trim(),
          ...(scope === undefined ? {} : { scope }),
          ...(keywords === undefined ? {} : { keywords }),
          ...(sector === undefined ? {} : { sector }),
          ...(reason === undefined ? {} : { reason }),
        },
      ]
    }
    if (op !== 'delete' || typeof value.id !== 'string' || !value.id.trim()) {
      return []
    }
    return [
      {
        op: 'delete',
        id: value.id.trim(),
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
  maxChars = MAX_EXTRACTION_MEMORY_CHARS,
): { content: string; omittedEntryCount: number } => {
  const stableEntries = [...entries].sort((left, right) => {
    if (left.scope !== right.scope) {
      return left.scope === 'assistant' ? -1 : 1
    }
    if (left.category !== right.category) {
      return left.category < right.category ? -1 : 1
    }
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  })
  const ordered = [
    ...stableEntries.filter(
      (entry) =>
        entry.scope === 'assistant' && entry.category === 'preferences',
    ),
    ...stableEntries.filter(
      (entry) => entry.scope === 'global' && entry.category === 'preferences',
    ),
    ...stableEntries.filter((entry) => entry.category === 'profile'),
    ...stableEntries.filter((entry) => entry.category === 'other'),
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

const buildMemoryAgentPrompt = ({
  currentMemory,
  userText,
  assistantText,
}: {
  currentMemory: string
  userText: string
  assistantText: string
}): string => `<memory_context>
${escapeMemoryValue(currentMemory || '(empty)')}
</memory_context>

<conversation_turn>
<user>
${escapeMemoryValue(userText)}
</user>

<assistant>
${escapeMemoryValue(assistantText)}
</assistant>
</conversation_turn>`

const buildMemoryAgentSystemPrompt = (): string =>
  `${DEFAULT_MEMORY_AGENT_PROMPT.en}

${buildMemoryExtractionContract()}

Use scope "global" for user-wide facts/preferences and "assistant" only for assistant-specific context. Prefer updating an existing entry instead of creating a duplicate.

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
  if (
    !shouldProcessMemoryTurn(userText) ||
    !assistantText.trim() ||
    signal?.aborted
  ) {
    return []
  }

  const visibleEntries = await loadMemoryAgentEntries({
    app,
    settings,
    assistantId,
  })
  const currentMemory = buildBoundedMemoryExtractionContext(visibleEntries)
  logFlightEvent('memory', 'entries-loaded', {
    id: assistantId ?? 'global',
    detail: `count=${visibleEntries.length} omitted=${currentMemory.omittedEntryCount}`,
  })
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
  logFlightEvent('memory', 'llm-response', {
    id: assistantId ?? 'global',
    detail: `operations=${operations.length}`,
  })
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

  logFlightEvent('memory', 'extraction-done', {
    id: assistantId ?? 'global',
    detail: `validOperations=${validOperations.length}`,
  })
  return validOperations
}

/**
 * Run the hidden memory pass without allowing a provider outage to affect the
 * user-facing turn. A configured lightweight model falls back to the current
 * conversation model; an unconfigured current model gets one retry.
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
    if (input.signal?.aborted) {
      console.warn('[YOLO][MemoryAgent] background extraction failed', error)
      logFlightEvent('memory', 'extraction-aborted', {
        id: input.assistantId ?? 'global',
        detail: error instanceof Error ? error.message : String(error),
        consoleOutput: 'warn',
      })
      return []
    }

    const useFallback = Boolean(
      fallback && fallback.model.id !== input.model.id,
    )
    console.warn(
      useFallback
        ? '[YOLO][MemoryAgent] configured model failed; retrying with current model'
        : '[YOLO][MemoryAgent] memory extraction failed; retrying once',
      error,
    )
    logFlightEvent('memory', 'extraction-failed-retry', {
      id: input.assistantId ?? 'global',
      detail: `${useFallback ? 'fallback model' : 'same model'}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      consoleOutput: 'warn',
    })
    try {
      return await runMemoryAgentAfterTurn({
        ...input,
        ...(useFallback && fallback
          ? {
              providerClient: fallback.providerClient,
              model: fallback.model,
            }
          : {}),
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
