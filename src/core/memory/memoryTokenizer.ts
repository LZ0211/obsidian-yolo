export const MAX_SIMHASH_TOKEN_CODE_POINTS = 80
export const MAX_SIMHASH_TOKENS = 256

// Function words only — deliberately excludes content words (topic/domain
// terms) so real memory keywords are never dropped. Follows the "kept small
// on purpose" principle of TencentDB-Agent-Memory: only high-frequency
// grammatical particles, pronouns, and connectors add noise to retrieval.
export const MEMORY_STOP_WORDS = new Set([
  // English
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'what',
  'with',
  // 代词
  '我',
  '你',
  '您',
  '他',
  '她',
  '它',
  '我们',
  '你们',
  '他们',
  '她们',
  '它们',
  '自己',
  '大家',
  '这个',
  '那个',
  '这些',
  '那些',
  '这',
  '那',
  '谁',
  '什么',
  '怎么',
  '怎样',
  '哪里',
  '哪儿',
  // 助词/虚词
  '的',
  '了',
  '着',
  '过',
  '是',
  '在',
  '有',
  '和',
  '与',
  '及',
  '或',
  '也',
  '都',
  '就',
  '才',
  '再',
  '又',
  '还',
  '很',
  '太',
  '最',
  '更',
  '不',
  '没',
  '没有',
  '别',
  '要',
  '会',
  '能',
  '可以',
  '应该',
  '必须',
  '得',
  '地',
  '所',
  '被',
  '把',
  '让',
  '给',
  '对',
  '向',
  '从',
  '往',
  '到',
  '于',
  '以',
  '为',
  '因',
  '所以',
  '但是',
  '但',
  '而',
  '而且',
  '如果',
  '如',
  '虽然',
  '即使',
  '无论',
  '只要',
  '只有',
  '由于',
  '通过',
  '作为',
  // 语气词
  '吗',
  '吧',
  '呢',
  '啊',
  '呀',
  '哦',
  '嗯',
  '哈',
  '唉',
  // 数量/指代虚用
  '一个',
  '一些',
  '一下',
  '一点',
  '一次',
  '每',
  '各',
  '该',
  '此',
  '本',
  '某',
  '任何',
  '所有',
  '一切',
  // 用户/助手指称（记忆上下文高频）
  '用户',
  '助手',
  '请问',
  '请',
  '谢谢',
  '感谢',
  '可以吗',
])

const ASCII_TOKEN_RE = /[a-z0-9_./-]{2,}/g
const CJK_RUN_RE = /[\u3400-\u9fff]+/g

type Segmenter = {
  segment(value: string): Iterable<{ segment: string; isWordLike?: boolean }>
}

type SegmenterConstructor = new (
  locale: string,
  options: { granularity: 'word' },
) => Segmenter

export const normalizeMemoryText = (value: string): string =>
  value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')

const hasWordCharacter = (value: string): boolean =>
  /[a-z0-9\u3400-\u9fff]/.test(value)

const addToken = (tokens: Set<string>, value: string): void => {
  const token = normalizeMemoryText(value)
  if (token && hasWordCharacter(token) && !MEMORY_STOP_WORDS.has(token)) {
    tokens.add(token)
  }
}

/**
 * CutForSearch-style supplementation: long segmented words also contribute
 * their bigram sub-tokens, so a query mentioning only part of a word (or a
 * different segmentation of it) still hits. Mirrors TencentDB-Agent-Memory's
 * jieba `cutForSearch` behavior ("北京烤鸭" → 北京/烤鸭/北京烤鸭) without
 * requiring a native tokenizer dependency — whole word + sub-tokens both
 * index.
 */
const BIGRAM_SUBTOKEN_MAX_WORD_LENGTH = 6
const BIGRAM_SUBTOKEN_MAX_COUNT = 4

const getBigramSubTokens = (word: string): string[] => {
  if (
    word.length <= 2 ||
    word.length > BIGRAM_SUBTOKEN_MAX_WORD_LENGTH
  ) {
    return []
  }
  const tokens: string[] = []
  for (let index = 0; index < word.length - 1; index += 1) {
    tokens.push(word.slice(index, index + 2))
  }
  return tokens.slice(0, BIGRAM_SUBTOKEN_MAX_COUNT)
}

const getCjkTokens = (value: string): string[] => {
  const tokens: string[] = []
  const segmenterConstructor = (
    Intl as unknown as { Segmenter?: SegmenterConstructor }
  ).Segmenter

  for (const run of value.match(CJK_RUN_RE) ?? []) {
    if (segmenterConstructor) {
      tokens.push(run)
      const segmenter = new segmenterConstructor('zh-CN', {
        granularity: 'word',
      })
      for (const item of segmenter.segment(run)) {
        if (item.isWordLike !== false) {
          tokens.push(item.segment)
          tokens.push(...getBigramSubTokens(item.segment))
        }
      }
      continue
    }

    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2))
    }
  }

  return tokens
}

const tokenizeMemoryTextUnbounded = (value: string): string[] => {
  const tokens = new Set<string>()
  const normalized = normalizeMemoryText(value)
  if (!normalized) return []

  for (const token of normalized.match(ASCII_TOKEN_RE) ?? []) {
    addToken(tokens, token)
  }
  for (const token of getCjkTokens(normalized)) {
    addToken(tokens, token)
  }

  return [...tokens]
}

const compareUtf8Bytes = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index]
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

const boundSimhashTokens = (tokens: Iterable<string>): string[] => {
  const bounded = new Set<string>()
  for (const token of tokens) {
    const boundedToken = [...token]
      .slice(0, MAX_SIMHASH_TOKEN_CODE_POINTS)
      .join('')
    if (boundedToken && hasWordCharacter(boundedToken)) {
      bounded.add(boundedToken)
    }
  }
  return [...bounded].sort(compareUtf8Bytes).slice(0, MAX_SIMHASH_TOKENS)
}

export const tokenizeMemoryText = (value: string): string[] =>
  boundSimhashTokens(tokenizeMemoryTextUnbounded(value))

export const sortMemoryRecallKeywords = (tokens: Iterable<string>): string[] =>
  [...new Set(tokens)].sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length
    return left.localeCompare(right)
  })

export const extractMemoryQueryKeywords = (query: string): string[] =>
  sortMemoryRecallKeywords(tokenizeMemoryTextUnbounded(query))
