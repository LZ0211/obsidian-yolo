import { type MetadataFilter } from './metadataKeyResolution'

export type MetadataFilterGroups = MetadataFilter[][]

export type MetadataFilterDslErrorCode =
  | 'malformed_query'
  | 'unsupported_operator'
  | 'unsupported_syntax'

export class MetadataFilterDslError extends Error {
  readonly code: MetadataFilterDslErrorCode

  constructor(code: MetadataFilterDslErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'MetadataFilterDslError'
    this.code = code
  }
}

const KEY_FORBIDDEN_CHARS = /[,;]/
const UNSUPPORTED_WORDS = new Set([
  'in',
  'from',
  'where',
  'limit',
  'order',
  'by',
  'asc',
  'desc',
  'select',
  'delete',
  'update',
  'insert',
  'drop',
  'join',
])

export function parseMetadataFilterDsl(input: string): MetadataFilterGroups {
  const source = input.trim()
  if (source.length === 0) return []

  let cursor = consumeWherePrefix(source, 0)
  cursor = skipWhitespace(source, cursor)
  if (cursor >= source.length) return []

  const unsupportedSyntax = hasUnsupportedSyntax(source, cursor)
  if (unsupportedSyntax) {
    throw new MetadataFilterDslError(
      'unsupported_syntax',
      unsupportedSyntax === true
        ? 'unsupported metadata filter syntax'
        : `unsupported keyword: "${unsupportedSyntax}". Use [...], \`...\`, or quoted DSL key syntax.`,
    )
  }

  const result = parseOrExpr(source, cursor)
  if (result.nextIndex < source.length) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'unexpected trailing content in metadata filter query',
    )
  }
  return result.groups
}

// --- recursive descent parser ---

type ParseResult = { groups: MetadataFilterGroups; nextIndex: number }

function parseOrExpr(source: string, start: number): ParseResult {
  let result = parseAndExpr(source, start)
  let cursor = skipWhitespace(source, result.nextIndex)

  while (cursor < source.length && startsWithWord(source, cursor, 'or')) {
    cursor = skipWhitespace(source, cursor + 2)
    if (cursor >= source.length) {
      throw new MetadataFilterDslError(
        'malformed_query',
        'query cannot end with OR',
      )
    }
    const right = parseAndExpr(source, cursor)
    result = {
      groups: [...result.groups, ...right.groups],
      nextIndex: right.nextIndex,
    }
    cursor = skipWhitespace(source, result.nextIndex)
  }

  return { ...result, nextIndex: cursor }
}

function parseAndExpr(source: string, start: number): ParseResult {
  let result = parseNotExpr(source, start)
  let cursor = skipWhitespace(source, result.nextIndex)

  while (cursor < source.length && startsWithWord(source, cursor, 'and')) {
    cursor = skipWhitespace(source, cursor + 3)
    if (cursor >= source.length) {
      throw new MetadataFilterDslError(
        'malformed_query',
        'query cannot end with AND',
      )
    }
    const right = parseNotExpr(source, cursor)
    result = {
      groups: andGroups(result.groups, right.groups),
      nextIndex: right.nextIndex,
    }
    cursor = skipWhitespace(source, result.nextIndex)
  }

  return { ...result, nextIndex: cursor }
}

function parseNotExpr(source: string, start: number): ParseResult {
  let cursor = skipWhitespace(source, start)
  if (startsWithWord(source, cursor, 'not')) {
    cursor = skipWhitespace(source, cursor + 3)
    if (cursor >= source.length) {
      throw new MetadataFilterDslError(
        'malformed_query',
        'query cannot end with NOT',
      )
    }
    const inner = parseAtom(source, cursor)
    return { groups: negateGroups(inner.groups), nextIndex: inner.nextIndex }
  }
  return parseAtom(source, cursor)
}

function parseAtom(source: string, start: number): ParseResult {
  let cursor = skipWhitespace(source, start)
  if (source[cursor] === '(') {
    cursor += 1
    const result = parseOrExpr(source, cursor)
    cursor = skipWhitespace(source, result.nextIndex)
    if (source[cursor] !== ')') {
      throw new MetadataFilterDslError(
        'malformed_query',
        'unclosed parenthesis',
      )
    }
    return { groups: result.groups, nextIndex: cursor + 1 }
  }

  const keyResult = parseKey(source, cursor)
  const operatorResult = parseOperator(source, keyResult.nextIndex)
  const valueResult = parseValue(source, operatorResult.nextIndex)

  const value =
    (operatorResult.op === 'contains' || operatorResult.op === 'like') &&
    typeof valueResult.value === 'string'
      ? valueResult.value.replace(/^%+|%+$/g, '')
      : valueResult.value

  return {
    groups: [[{ key: keyResult.key, op: operatorResult.op, value }]],
    nextIndex: valueResult.nextIndex,
  }
}

// --- group algebra ---

function andGroups(
  left: MetadataFilterGroups,
  right: MetadataFilterGroups,
): MetadataFilterGroups {
  const result: MetadataFilterGroups = []
  for (const la of left) {
    for (const ra of right) {
      result.push([...la, ...ra])
    }
  }
  return result
}

function negateGroups(groups: MetadataFilterGroups): MetadataFilterGroups {
  if (groups.length === 0) return groups
  // De Morgan: NOT (A or B) = NOT A and NOT B
  //            NOT (A and B) = NOT A or NOT B
  // Single group = AND of filters → negate each filter, wrap as OR groups
  if (groups.length === 1 && groups[0].length > 0) {
    return groups[0].map((filter) => [{ ...filter, op: negateOp(filter.op) }])
  }
  // Multiple groups = OR of AND-groups → negate each group and AND them
  let result = negateGroups([groups[0]])
  for (let i = 1; i < groups.length; i++) {
    result = andGroups(result, negateGroups([groups[i]]))
  }
  return result
}

function negateOp(op: MetadataFilter['op']): MetadataFilter['op'] {
  if (op === 'eq') return 'neq'
  if (op === 'neq') return 'eq'
  if (op === 'contains') return 'neq' // best-effort: NOT contains → check !=
  if (op === 'like') return 'neq' // best-effort: NOT like → check !=
  if (op === 'gte') return 'lt'
  if (op === 'lte') return 'gt'
  if (op === 'gt') return 'lte'
  return 'gte'
}

function hasUnsupportedSyntax(source: string, start = 0): boolean | string {
  let index = start

  while (index < source.length) {
    const char = source[index]

    if (char === '"' || char === "'" || char === '`') {
      index = skipQuotedString(source, index, char)
      continue
    }

    if (char === '[') {
      const closeIndex = source.indexOf(']', index + 1)
      index = closeIndex === -1 ? source.length : closeIndex + 1
      continue
    }

    if (char != null && /[,;]/.test(char)) {
      return true
    }

    if (char != null && /[\p{L}_]/u.test(char)) {
      const start = index
      index += 1
      while (
        index < source.length &&
        /[\p{L}\p{N}_]/u.test(source[index] ?? '')
      ) {
        index += 1
      }
      const word = source.slice(start, index).toLowerCase()
      if (UNSUPPORTED_WORDS.has(word)) {
        return word
      }
      continue
    }

    index += 1
  }

  return false
}

function skipQuotedString(
  source: string,
  start: number,
  quote: '"' | "'" | '`',
): number {
  let index = start + 1

  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      return index + 1
    }
    index += 1
  }

  return source.length
}

function consumeWherePrefix(source: string, start: number): number {
  if (!startsWithWord(source, start, 'where')) {
    return start
  }

  const afterWhere = start + 5
  if (afterWhere < source.length && !isWhitespace(source[afterWhere])) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'WHERE must be followed by whitespace or end of input',
    )
  }

  return afterWhere
}

function parseKey(
  source: string,
  start: number,
): { key: string; nextIndex: number } {
  let index = skipWhitespace(source, start)

  if (source[index] === '`') {
    const parsed = parseQuotedString(source, index, '`')
    return {
      key: parsed.value.trim(),
      nextIndex: parsed.nextIndex,
    }
  }

  if (source[index] === '[') {
    const endIndex = source.indexOf(']', index + 1)
    if (endIndex === -1) {
      throw new MetadataFilterDslError(
        'malformed_query',
        'unterminated bracket quoted metadata key',
      )
    }
    const key = source.slice(index + 1, endIndex).trim()
    if (key.length === 0) {
      throw new MetadataFilterDslError(
        'malformed_query',
        'metadata filter key is required',
      )
    }
    return {
      key,
      nextIndex: endIndex + 1,
    }
  }

  const keyStart = index

  while (index < source.length) {
    const char = source[index]

    if (char == null) {
      break
    }

    if (KEY_FORBIDDEN_CHARS.test(char)) {
      throw new MetadataFilterDslError(
        'unsupported_syntax',
        'metadata filter key contains unsupported punctuation',
      )
    }

    if (char === '=' || char === '<' || char === '>' || char === '!') {
      break
    }

    if (
      isWhitespace(char) &&
      (startsWithWord(source, skipWhitespace(source, index), 'contains') ||
        startsWithWord(source, skipWhitespace(source, index), 'includes') ||
        startsWithWord(source, skipWhitespace(source, index), 'like') ||
        startsWithWord(source, skipWhitespace(source, index), 'ilike') ||
        startsWithWord(source, skipWhitespace(source, index), 'is') ||
        startsWithOperator(source, skipWhitespace(source, index)))
    ) {
      break
    }

    index += 1
  }

  const key = source.slice(keyStart, index).trim()

  if (key.length === 0) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'metadata filter key is required',
    )
  }

  return {
    key,
    nextIndex: index,
  }
}

function parseOperator(
  source: string,
  start: number,
): { op: MetadataFilter['op']; nextIndex: number } {
  const index = skipWhitespace(source, start)
  const twoChars = source.slice(index, index + 2)
  const oneChar = source[index]

  if (twoChars === '>=') {
    return { op: 'gte', nextIndex: index + 2 }
  }
  if (twoChars === '<=') {
    return { op: 'lte', nextIndex: index + 2 }
  }
  if (twoChars === '==') {
    return { op: 'eq', nextIndex: index + 2 }
  }
  if (twoChars === '!=' || twoChars === '<>') {
    return { op: 'neq', nextIndex: index + 2 }
  }
  if (oneChar === '=') {
    return { op: 'eq', nextIndex: index + 1 }
  }
  if (oneChar === '>') {
    return { op: 'gt', nextIndex: index + 1 }
  }
  if (oneChar === '<') {
    return { op: 'lt', nextIndex: index + 1 }
  }
  if (startsWithWord(source, index, 'contains')) {
    return { op: 'contains', nextIndex: index + 'contains'.length }
  }
  if (startsWithWord(source, index, 'includes')) {
    return { op: 'contains', nextIndex: index + 'includes'.length }
  }
  if (startsWithWord(source, index, 'ilike')) {
    return { op: 'contains', nextIndex: index + 'ilike'.length }
  }
  if (startsWithWord(source, index, 'like')) {
    return { op: 'like', nextIndex: index + 'like'.length }
  }
  if (startsWithWord(source, index, 'is')) {
    const afterIs = skipWhitespace(source, index + 'is'.length)
    if (startsWithWord(source, afterIs, 'not')) {
      return { op: 'neq', nextIndex: afterIs + 'not'.length }
    }
    return { op: 'eq', nextIndex: index + 'is'.length }
  }

  if (oneChar === '!' || twoChars.startsWith('!')) {
    throw new MetadataFilterDslError(
      'unsupported_operator',
      'unsupported metadata filter operator',
    )
  }

  throw new MetadataFilterDslError(
    'malformed_query',
    'metadata filter operator is required',
  )
}

function parseValue(
  source: string,
  start: number,
): { value: string | number | boolean; nextIndex: number } {
  const index = skipWhitespace(source, start)
  const char = source[index]

  if (char === '"' || char === "'") {
    return parseQuotedString(source, index, char)
  }

  if (startsWithWord(source, index, 'true')) {
    return { value: true, nextIndex: index + 4 }
  }

  if (startsWithWord(source, index, 'false')) {
    return { value: false, nextIndex: index + 5 }
  }

  const numberMatch = source
    .slice(index)
    .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)

  if (numberMatch?.[0] != null) {
    const value = Number(numberMatch[0])

    if (!Number.isFinite(value)) {
      throw new MetadataFilterDslError(
        'malformed_query',
        'metadata filter number must be finite',
      )
    }

    return {
      value,
      nextIndex: index + numberMatch[0].length,
    }
  }

  throw new MetadataFilterDslError(
    'malformed_query',
    'metadata filter value must be a quoted string, finite number, or boolean',
  )
}

function parseQuotedString(
  source: string,
  start: number,
  quote: '"' | "'" | '`',
): { value: string; nextIndex: number } {
  let index = start + 1
  let value = ''

  while (index < source.length) {
    const char = source[index]

    if (char === '\\') {
      const nextChar = source[index + 1]
      if (nextChar == null) {
        throw new MetadataFilterDslError(
          'malformed_query',
          'unterminated string escape in metadata filter query',
        )
      }
      if (nextChar === quote || nextChar === '\\') {
        value += nextChar
        index += 2
        continue
      }
      value += nextChar
      index += 2
      continue
    }

    if (char === quote) {
      return {
        value,
        nextIndex: index + 1,
      }
    }

    value += char
    index += 1
  }

  throw new MetadataFilterDslError(
    'malformed_query',
    'unterminated string in metadata filter query',
  )
}

function startsWithOperator(source: string, index: number): boolean {
  return ['=', '>', '<', '!'].includes(source[index] ?? '')
}

function startsWithWord(source: string, index: number, word: string): boolean {
  const candidate = source.slice(index, index + word.length)
  if (
    candidate.localeCompare(word, undefined, { sensitivity: 'accent' }) === 0
  ) {
    return (
      isWordBoundary(source[index - 1]) &&
      isWordBoundary(source[index + word.length])
    )
  }
  if (candidate.toLowerCase() !== word.toLowerCase()) {
    return false
  }
  return (
    isWordBoundary(source[index - 1]) &&
    isWordBoundary(source[index + word.length])
  )
}

function isWordBoundary(char: string | undefined): boolean {
  if (char == null) {
    return true
  }
  return !/[\p{L}\p{N}_]/u.test(char)
}

function skipWhitespace(source: string, index: number): number {
  let current = index
  while (current < source.length && isWhitespace(source[current])) {
    current += 1
  }
  return current
}

function isWhitespace(char: string | undefined): boolean {
  return char != null && /\s/.test(char)
}
