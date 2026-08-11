import type { ChatModel } from '../../types/chat-model.types'
import type { LLMProvider } from '../../types/provider.types'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

import {
  extractMemoryQueryKeywords,
  normalizeMemoryText,
} from './memoryTokenizer'
import type { MemorySector } from './memoryTypes'

export const MAX_RECALL_CONTEXT_CHARS = 4000
export const MAX_RECALL_QUERY_CHARS = 2000
export const MAX_KNOWN_MEMORY_KEYWORDS = 256
export const MAX_RECENT_USER_MESSAGES = 5
export const MEMORY_RECALL_REWRITE_TIMEOUT_MS = 2000

export type MemoryRecallCategory = 'profile' | 'preferences' | 'other'
export type MemoryRecallScope = 'global' | 'assistant'

export type MemoryRecallTarget = {
  query: string
  keywords: string[]
  entities: string[]
  categories: MemoryRecallCategory[]
  scopes: MemoryRecallScope[]
  sector: MemorySector | null
  confidence: number
  isReferential: boolean
  source: 'lexical' | 'model_rewrite'
}

export type MemoryRecallTargetInput = {
  latestQuery: string
  recentUserMessages: string[]
  compactionSummary?: string
  knownMemoryKeywords?: string[]
  assistantId?: string
}

export type MemoryRecallRewriteResult = {
  hitCount: number
  hasUsableRecentContext?: boolean
}

type MemoryRecallRuntime = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
}

type MemoryRecallTargetRewriteInput = MemoryRecallRuntime & {
  target: MemoryRecallTarget
  conversationContext?: string
  result: MemoryRecallRewriteResult
  signal?: AbortSignal
}

const CJK_REFERENTIAL_RE =
  /(?:继续|那个|这个|之前|上次|原来|照旧|同样|他|她|它)/
const ENGLISH_REFERENTIAL_RE =
  /\b(?:continue|that one|this one|before|last time|previously|as before|same|him|her|them|it)\b/i
const normalizeText = normalizeMemoryText

const appendWithinLimit = (parts: string[], value: string): void => {
  const currentLength = parts.join('\n').length
  const separatorLength = parts.length ? 1 : 0
  const available = MAX_RECALL_CONTEXT_CHARS - currentLength - separatorLength
  if (available <= 0) return
  const normalized = value.slice(0, available).trim()
  if (!normalized) return
  parts.push(normalized.slice(0, available))
}

type MemoryRecallContextProjection = {
  context: string
  latestQuery: string
}

const buildContext = (
  input: MemoryRecallTargetInput,
): MemoryRecallContextProjection => {
  const latestQuery = input.latestQuery.slice(0, MAX_RECALL_QUERY_CHARS).trim()
  const parts = [latestQuery]

  for (const message of input.recentUserMessages
    .slice(-MAX_RECENT_USER_MESSAGES)
    .reverse()) {
    appendWithinLimit(parts, message)
  }
  appendWithinLimit(parts, input.compactionSummary ?? '')

  return { context: parts.join('\n'), latestQuery }
}

export const buildMemoryRecallConversationContext = (
  input: MemoryRecallTargetInput,
): string => buildContext(input).context

const findMatchingKnownKeywords = (
  knownKeywords: string[] | undefined,
  context: string,
): string[] => {
  const normalizedContext = normalizeText(context)
  const matches = new Set<string>()

  for (const keyword of knownKeywords?.slice(0, MAX_KNOWN_MEMORY_KEYWORDS) ??
    []) {
    const normalizedKeyword = normalizeText(keyword)
    if (normalizedKeyword && normalizedContext.includes(normalizedKeyword)) {
      matches.add(normalizedKeyword)
    }
  }

  return [...matches]
}

const isReferential = (query: string): boolean =>
  CJK_REFERENTIAL_RE.test(query) || ENGLISH_REFERENTIAL_RE.test(query)

export const buildMemoryRecallTarget = (
  input: MemoryRecallTargetInput,
): MemoryRecallTarget => {
  const projection = buildContext(input)
  const lexicalKeywords = extractMemoryQueryKeywords(projection.context)
  const knownKeywords = findMatchingKnownKeywords(
    input.knownMemoryKeywords,
    projection.context,
  )
  const keywords = [...new Set([...knownKeywords, ...lexicalKeywords])].slice(
    0,
    MAX_KNOWN_MEMORY_KEYWORDS,
  )
  const latestKeywords = extractMemoryQueryKeywords(projection.latestQuery)
  const referential = isReferential(projection.latestQuery)
  const confidence = referential
    ? 0.2
    : latestKeywords.length >= 2
      ? 0.9
      : latestKeywords.length === 1
        ? 0.55
        : 0.2

  return {
    query: projection.context,
    keywords,
    entities: latestKeywords.filter((keyword) => /[a-z0-9_./-]/.test(keyword)),
    categories: ['profile', 'preferences', 'other'],
    scopes: input.assistantId ? ['assistant', 'global'] : ['global'],
    sector: null,
    confidence,
    isReferential: referential,
    source: 'lexical',
  }
}

export const shouldRewriteMemoryRecallTarget = (
  target: MemoryRecallTarget,
  _result: MemoryRecallRewriteResult,
): boolean => {
  return (
    target.confidence < 0.65 ||
    target.isReferential ||
    target.keywords.length < 2
  )
}

const MAX_REWRITE_KEYWORDS = 32
const MAX_REWRITE_ENTITIES = 16
const MAX_REWRITE_FIELD_CHARS = 128

const parseRewriteStrings = (
  value: unknown,
  maximumLength: number,
): string[] | null => {
  if (!Array.isArray(value) || value.length > maximumLength) return null
  const values = value.map((item) =>
    typeof item === 'string' ? item.trim() : '',
  )
  if (values.some((item) => !item || item.length > MAX_REWRITE_FIELD_CHARS))
    return null
  return [...new Set(values)]
}

const parseRewrittenTarget = (
  content: string,
): Omit<
  MemoryRecallTarget,
  'confidence' | 'isReferential' | 'source' | 'sector'
> | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null

  const value = parsed as Record<string, unknown>
  const keys = Object.keys(value).sort()
  const expectedKeys = ['categories', 'entities', 'keywords', 'query', 'scopes']
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index])
  ) {
    return null
  }
  if (
    typeof value.query !== 'string' ||
    !value.query.trim() ||
    value.query.length > MAX_RECALL_QUERY_CHARS
  ) {
    return null
  }

  const keywords = parseRewriteStrings(value.keywords, MAX_REWRITE_KEYWORDS)
  const entities = parseRewriteStrings(value.entities, MAX_REWRITE_ENTITIES)
  const categories = parseRewriteStrings(value.categories, 3)
  const scopes = parseRewriteStrings(value.scopes, 2)
  if (!keywords || !entities || !categories || !scopes) return null
  if (
    !categories.every(
      (category): category is MemoryRecallCategory =>
        category === 'profile' ||
        category === 'preferences' ||
        category === 'other',
    )
  )
    return null
  if (
    !scopes.every(
      (scope): scope is MemoryRecallScope =>
        scope === 'global' || scope === 'assistant',
    )
  )
    return null

  return {
    query: value.query.trim(),
    keywords,
    entities,
    categories,
    scopes,
  }
}

/** Rewrites only ambiguous recall targets; malformed or failed turns stay lexical. */
export const rewriteMemoryRecallTarget = async ({
  target,
  conversationContext,
  result,
  providerClient,
  model,
  signal,
}: MemoryRecallTargetRewriteInput): Promise<MemoryRecallTarget> => {
  if (!shouldRewriteMemoryRecallTarget(target, result)) return target

  const controller = new AbortController()
  const abortForExternalSignal = (): void => controller.abort()
  if (signal?.aborted) {
    controller.abort()
  } else {
    signal?.addEventListener('abort', abortForExternalSignal, { once: true })
  }
  let rejectForTimeout: (reason: Error) => void = () => {}
  const timeoutResult = new Promise<never>((_, reject) => {
    rejectForTimeout = reject
  })
  const timeout = setTimeout(() => {
    controller.abort()
    rejectForTimeout(new Error('Memory recall rewrite timed out'))
  }, MEMORY_RECALL_REWRITE_TIMEOUT_MS)

  try {
    const response = await Promise.race([
      executeSingleTurn({
        providerClient,
        model,
        request: {
          model: model.model,
          messages: [
            {
              role: 'system',
              content:
                'Rewrite the recall target, not an answer. Preserve entities, paths, dates, limits, and language. Resolve pronouns only from the supplied context. Do not invent facts, aliases, or constraints. JSON only. Return exactly query, keywords, entities, categories, scopes. No tools.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                conversation: conversationContext ?? target.query,
                lexicalTarget: target,
              }),
            },
          ],
        },
        tools: undefined,
        signal: controller.signal,
        deliveryMode: 'buffered',
        primaryRequestTimeoutMs: MEMORY_RECALL_REWRITE_TIMEOUT_MS,
        purpose: 'lightweight',
      }),
      timeoutResult,
    ])
    const rewritten = parseRewrittenTarget(response.content)
    if (!rewritten) return target
    return {
      ...rewritten,
      sector: null,
      confidence: 1,
      isReferential: false,
      source: 'model_rewrite',
    }
  } catch {
    return target
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortForExternalSignal)
  }
}
