import {
  MetadataFilterDslError,
  parseMetadataFilterDsl,
} from './metadataFilterDsl'
import { type MetadataFilter } from './metadataKeyResolution'

export type MetadataSearchDslQuery = {
  select: '**' | string[] | { distinct: string }
  path?: string
  filters: MetadataFilter[][]
  orderBy?: {
    key: string
    direction: 'asc' | 'desc'
  }
  limit?: number
}

const SELECT_PATTERN = /^(select|table)\s+/i
const LIMIT_PATTERN = /\s+limit\s+(\d+)\s*$/i
const ORDER_BY_PATTERN = /\s+order\s+by\s+(.+?)(?:\s+(asc|desc))?\s*$/i

export function parseMetadataSearchDsl(input: string): MetadataSearchDslQuery {
  const source = input.trim()
  if (!source) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'metadata query is required',
    )
  }

  if (!SELECT_PATTERN.test(source)) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'metadata query must start with SELECT or TABLE',
    )
  }

  const afterSelect = source.replace(SELECT_PATTERN, '')
  const fromMatch = /\s+from\s+/i.exec(afterSelect)
  if (fromMatch == null) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'metadata query SELECT must include FROM',
    )
  }
  const rawSelect = afterSelect.slice(0, fromMatch.index).trim()
  let afterFrom = afterSelect
    .slice(fromMatch.index + fromMatch[0].length)
    .trim()
  const limitResult = parseAndStripLimit(afterFrom)
  afterFrom = limitResult.source
  const orderByResult = parseAndStripOrderBy(afterFrom)
  afterFrom = orderByResult.source
  const whereMatch = /\s+where\s+/i.exec(afterFrom)
  const rawPath =
    whereMatch == null
      ? afterFrom.trim()
      : afterFrom.slice(0, whereMatch.index).trim()
  const where =
    whereMatch == null
      ? ''
      : afterFrom.slice(whereMatch.index + whereMatch[0].length).trim()

  const path = parsePath(rawPath)
  return {
    select: parseSelect(rawSelect),
    path,
    filters: where ? parseMetadataFilterDsl(`where ${where}`) : [],
    ...(orderByResult.orderBy ? { orderBy: orderByResult.orderBy } : {}),
    ...(limitResult.limit != null ? { limit: limitResult.limit } : {}),
  }
}

function parseSelect(input: string): MetadataSearchDslQuery['select'] {
  if (input === '**' || input === '*') return '**'
  if (/^keys\s*\(\s*\*\s*\)$/i.test(input.trim())) {
    return { distinct: 'available_keys' }
  }
  const keys = input
    .split(',')
    .map((key) => unquoteIdentifier(key.trim()))
    .filter(Boolean)
  if (keys.length === 0) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'metadata query SELECT requires ** or at least one key',
    )
  }
  return keys
}

function parseAndStripLimit(source: string): {
  source: string
  limit?: number
} {
  const match = LIMIT_PATTERN.exec(source)
  if (!match) return { source }

  const limit = Number(match[1])
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'metadata query LIMIT must be a positive integer',
    )
  }

  return {
    source: source.slice(0, match.index).trim(),
    limit,
  }
}

function parseAndStripOrderBy(source: string): {
  source: string
  orderBy?: MetadataSearchDslQuery['orderBy']
} {
  const match = ORDER_BY_PATTERN.exec(source)
  if (!match?.[1]) return { source }

  const key = unquoteIdentifier(match[1].trim())
  if (!key) {
    throw new MetadataFilterDslError(
      'malformed_query',
      'metadata query ORDER BY requires a key',
    )
  }

  return {
    source: source.slice(0, match.index).trim(),
    orderBy: {
      key,
      direction: match[2]?.toLowerCase() === 'desc' ? 'desc' : 'asc',
    },
  }
}

function parsePath(input: string): string | undefined {
  if (!input || input === '*' || input === '**' || input === '/') {
    return undefined
  }
  if (
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return input.slice(1, -1).replace(/\\(["'\\])/g, '$1')
  }
  return input
}

function unquoteIdentifier(input: string): string {
  if (
    (input.startsWith('`') && input.endsWith('`')) ||
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return input.slice(1, -1).replace(/\\(["'`\\])/g, '$1')
  }
  if (input.startsWith('[') && input.endsWith(']')) {
    return input.slice(1, -1).trim()
  }
  return input
}
