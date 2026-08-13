import { cutForSearchWithJieba } from './memoryJiebaTokenizer'
import {
  extractMemoryQueryKeywords,
  normalizeMemoryText,
} from './memoryTokenizer'
import type { MemorySector } from './memoryTypes'

export const MAX_RECALL_CONTEXT_CHARS = 4000
export const MAX_RECALL_QUERY_CHARS = 2000
export const MAX_KNOWN_MEMORY_KEYWORDS = 256
export const MAX_RECENT_USER_MESSAGES = 5

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
  source: 'lexical'
}

export type MemoryRecallTargetInput = {
  latestQuery: string
  recentUserMessages: string[]
  compactionSummary?: string
  knownMemoryKeywords?: string[]
  assistantId?: string
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

/**
 * jieba-enhanced variant of {@link buildMemoryRecallTarget}: when the
 * jieba-engine component is available, lexical keywords come from jieba's
 * search-engine mode (accurate Chinese word segmentation — long words plus
 * sub-tokens); otherwise it falls back to the built-in tokenizer. Callers
 * with an async context (requestContextBuilder, recall orchestration) use
 * this instead of the synchronous build.
 */
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

/**
 * jieba-enhanced variant of {@link buildMemoryRecallTarget}: when the
 * jieba-engine component is available, lexical keywords come from jieba's
 * search-engine mode (accurate Chinese word segmentation — long words plus
 * sub-tokens); otherwise it falls back to the built-in tokenizer. Callers
 * with an async context (requestContextBuilder, recall orchestration) use
 * this instead of the synchronous build.
 */
export const buildMemoryRecallTargetWithJieba = async (
  input: MemoryRecallTargetInput,
): Promise<MemoryRecallTarget> => {
  const projection = buildContext(input)
  const [jiebaContextKeywords, jiebaLatestKeywords] = await Promise.all([
    cutForSearchWithJieba(projection.context),
    cutForSearchWithJieba(projection.latestQuery),
  ])
  const lexicalKeywords =
    jiebaContextKeywords ?? extractMemoryQueryKeywords(projection.context)
  const knownKeywords = findMatchingKnownKeywords(
    input.knownMemoryKeywords,
    projection.context,
  )
  const keywords = [...new Set([...knownKeywords, ...lexicalKeywords])].slice(
    0,
    MAX_KNOWN_MEMORY_KEYWORDS,
  )
  const latestKeywords =
    jiebaLatestKeywords ?? extractMemoryQueryKeywords(projection.latestQuery)
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
