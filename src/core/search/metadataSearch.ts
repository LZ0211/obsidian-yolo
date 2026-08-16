import { type App, TFile } from 'obsidian'

import {
  type MetadataAliasEntry,
  type MetadataFilter,
  type MetadataKvRow,
  canonicalizeMetadataKey,
  resolveMetadataFilter,
} from './metadataKeyResolution'
import {
  type MetadataSearchDslQuery,
  parseMetadataSearchDsl,
} from './metadataSearchDsl'

export type MetadataFileSearchHit = {
  kind: 'file'
  path: string
  source: 'metadata'
  matchedKeys: string[]
  metadata: Record<string, Array<string | number | boolean>>
}

export type MetadataDistinctSearchHit = {
  kind: 'distinct'
  key: string
  values: Array<string | number | boolean>
}

export type MetadataSearchHit =
  | MetadataFileSearchHit
  | MetadataDistinctSearchHit

export type MetadataFileSearchOptions = {
  path?: string
  maxResults: number
  isReadablePath?: (path: string) => boolean
}

export function searchFilesByMetadataDsl(
  app: App,
  dsl: string,
  options: MetadataFileSearchOptions,
): MetadataSearchHit[] {
  const query = parseMetadataSearchDsl(dsl)
  return searchFilesByMetadata(app, query.filters, {
    maxResults: Math.min(options.maxResults, query.limit ?? options.maxResults),
    path: query.path ?? options.path,
    isReadablePath: options.isReadablePath,
    select: query.select,
    orderBy: query.orderBy,
  })
}

type MetadataCacheLike = {
  resolvedLinks?: Record<string, Record<string, number>>
  unresolvedLinks?: Record<string, Record<string, number>>
  getFileCache?: (file: TFile) => {
    frontmatter?: Record<string, unknown> | null
    tags?: Array<{ tag: string }>
    links?: Array<{ link: string }>
    embeds?: Array<{ link: string }>
    headings?: Array<{ heading: string; level?: number }>
    sections?: Array<{ type?: string }>
    listItems?: Array<{ task?: string }>
  } | null
}

export function normalizeMetadataPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function folderPathFor(sourcePath: string): string {
  const index = sourcePath.lastIndexOf('/')
  return index === -1 ? '' : sourcePath.slice(0, index)
}

function fileNameFor(sourcePath: string): string {
  const index = sourcePath.lastIndexOf('/')
  return index === -1 ? sourcePath : sourcePath.slice(index + 1)
}

function documentTypeFor(extension: string): string {
  const normalized = extension.trim().toLowerCase()
  if (normalized === 'md' || normalized === 'markdown') return 'markdown'
  if (normalized === 'pdf') return 'pdf'
  return normalized || 'unknown'
}

function pushRow(rows: MetadataKvRow[], row: MetadataKvRow | null): void {
  if (row == null) return
  rows.push(row)
}

export function normalizeMetadataText(value: string): string {
  return value.normalize('NFKC').trim()
}

export function normalizeMetadataTextValues(
  values: Iterable<unknown>,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = normalizeMetadataText(value)
    if (normalized.length === 0 || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export function normalizeMetadataScalarValue(
  value: unknown,
): string | number | boolean | null {
  if (typeof value === 'string') {
    const normalized = normalizeMetadataText(value)
    return normalized.length === 0 ? null : normalized
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  return null
}

function pushTextRow(rows: MetadataKvRow[], key: string, value: unknown): void {
  if (typeof value !== 'string') return
  const normalized = normalizeMetadataText(value)
  if (normalized.length === 0) return
  rows.push({ key, valueType: 'text', value: normalized })
}

function pushUniqueTextRows(
  rows: MetadataKvRow[],
  key: string,
  values: Iterable<unknown>,
): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = normalizeMetadataText(value)
    if (normalized.length === 0 || seen.has(normalized)) continue
    seen.add(normalized)
    rows.push({ key, valueType: 'text', value: normalized })
  }
}

function pushNumberRow(
  rows: MetadataKvRow[],
  key: string,
  value: number,
): void {
  if (!Number.isFinite(value)) return
  rows.push({ key, valueType: 'number', value })
}

function scalarRow(key: string, value: unknown): MetadataKvRow | null {
  if (typeof value === 'string') return { key, valueType: 'text', value }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { key, valueType: 'number', value }
  }
  if (typeof value === 'boolean') return { key, valueType: 'bool', value }
  return null
}

export function collectFileMetadataRows(
  app: App,
  file: TFile,
): MetadataKvRow[] {
  const rows: MetadataKvRow[] = []
  const metadataCache = app.metadataCache as MetadataCacheLike | undefined
  const cache = metadataCache?.getFileCache?.(file)
  const frontmatter = cache?.frontmatter ?? {}
  const sourcePath = normalizeMetadataPath(file.path)

  pushTextRow(rows, '$source_path', sourcePath)
  pushTextRow(rows, '$folder_path', folderPathFor(sourcePath))
  pushTextRow(rows, '$document_type', documentTypeFor(file.extension))
  pushTextRow(rows, '$file_name', fileNameFor(sourcePath))
  pushTextRow(rows, '$title', file.basename)

  for (const [rawKey, rawValue] of Object.entries(frontmatter)) {
    const key = canonicalizeMetadataKey(rawKey)
    if (Array.isArray(rawValue)) {
      const items = rawValue.filter(
        (v): v is string | number | boolean =>
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean',
      )
      if (items.length > 0) {
        rows.push({ key, valueType: 'list', value: items })
      }
      for (const value of rawValue) {
        if (key === 'alias' || key === 'aliases') {
          pushTextRow(rows, '$alias', value)
        }
      }
      continue
    }
    pushRow(rows, scalarRow(key, rawValue))
    if (key === 'alias' || key === 'aliases') {
      pushTextRow(rows, '$alias', rawValue)
    }
  }

  for (const tag of cache?.tags ?? []) {
    const value = tag.tag.normalize('NFKC').replace(/^#/, '')
    if (value) rows.push({ key: '$tag', valueType: 'text', value })
  }

  for (const link of cache?.links ?? []) {
    pushTextRow(rows, '$link', link.link)
  }
  pushUniqueTextRows(
    rows,
    '$outlink',
    Object.keys(metadataCache?.resolvedLinks?.[sourcePath] ?? {}),
  )

  for (const embed of cache?.embeds ?? []) {
    pushTextRow(rows, '$embed', embed.link)
  }

  const inlinks: string[] = []
  for (const [source, targets] of Object.entries(
    metadataCache?.resolvedLinks ?? {},
  )) {
    if (targets[sourcePath] != null) {
      inlinks.push(source)
    }
  }
  pushUniqueTextRows(rows, '$inlink', inlinks)

  for (const heading of cache?.headings ?? []) {
    pushTextRow(rows, '$heading', heading.heading)
    if (typeof heading.level === 'number') {
      pushNumberRow(rows, '$heading_level', heading.level)
    }
  }

  for (const section of cache?.sections ?? []) {
    pushTextRow(rows, '$section_type', section.type)
  }

  const listItemCount = cache?.listItems?.length ?? 0
  pushNumberRow(rows, '$list_item_count', listItemCount)
  const taskCount =
    cache?.listItems?.filter((item) => typeof item.task === 'string').length ??
    0
  pushNumberRow(rows, '$task_count', taskCount)

  return rows
}

export function searchFilesByMetadata(
  app: App,
  filterGroups: MetadataFilter[][],
  options: MetadataFileSearchOptions & {
    select?: MetadataSearchDslQuery['select']
    orderBy?: MetadataSearchDslQuery['orderBy']
  },
): MetadataSearchHit[] {
  const scopePath =
    options.path == null ? '' : normalizeMetadataPath(options.path)
  const matches: Array<{
    file: TFile
    rows: MetadataKvRow[]
    matchedKeys: string[]
  }> = []

  for (const file of app.vault.getFiles()) {
    const filePath = normalizeMetadataPath(file.path)
    if (options.isReadablePath && !options.isReadablePath(filePath)) {
      continue
    }
    if (
      scopePath &&
      filePath !== scopePath &&
      !filePath.startsWith(`${scopePath}/`)
    ) {
      continue
    }

    const rows = collectFileMetadataRows(app, file)
    const matchedKeys: string[] = []
    const matched =
      filterGroups.length === 0 ||
      filterGroups.some((filters) => {
        if (filters.length === 0) return true
        const groupKeys: string[] = []
        const allMatch = filters.every((filter) => {
          const resolved = resolveSearchMetadataKey(filter.key)
          const keyRows = rows.filter((row) => resolved.keys.includes(row.key))
          if (keyRows.length === 0) return false
          const ok = keyRows.some((row) => rowMatchesFilter(row, filter))
          if (ok) groupKeys.push(...keyRows.map((row) => row.key))
          return ok
        })
        if (allMatch) matchedKeys.push(...groupKeys)
        return allMatch
      })

    if (!matched) continue
    matches.push({ file, rows, matchedKeys })
  }

  const select = options.select ?? '**'
  if (typeof select === 'object' && 'distinct' in select) {
    return [buildDistinctResult(matches, select.distinct, options.orderBy)]
  }

  return orderMatchedRows(matches, options.orderBy)
    .slice(0, options.maxResults)
    .map(({ file, rows, matchedKeys }) => ({
      kind: 'file',
      path: file.path,
      source: 'metadata',
      matchedKeys: [...new Set(matchedKeys)],
      metadata: projectMetadata(rows, select),
    }))
}

function buildDistinctResult(
  matches: Array<{ rows: MetadataKvRow[] }>,
  rawKey: string,
  orderBy: MetadataSearchDslQuery['orderBy'],
): MetadataDistinctSearchHit {
  const isKeyDiscovery = canonicalizeMetadataKey(rawKey) === 'available_keys'

  if (!isKeyDiscovery) {
    const resolved = resolveSearchMetadataKey(rawKey)
    const values = new Map<string, string | number | boolean>()
    for (const match of matches) {
      for (const row of match.rows) {
        if (!resolved.keys.includes(row.key)) continue
        if (row.valueType === 'list') continue
        values.set(
          `${row.valueType}:${String(row.value)}`,
          row.value as string | number | boolean,
        )
      }
    }
    const orderedValues = [...values.values()].sort(compareMetadataValues)
    if (orderBy?.direction === 'desc') {
      orderedValues.reverse()
    }
    return {
      kind: 'distinct',
      key: resolved.keys[0] ?? resolved.canonicalUserKey,
      values: orderedValues,
    }
  }

  // Virtual field: `keys(*)` returns metadata key names in pydantic-style:
  //   "field: str", "field: list[str]", "field: str | list[str]" (mixed)
  const TYPE_MAP: Record<string, string> = {
    text: 'str',
    number: 'int',
    bool: 'bool',
  }
  const scalarTypes = new Map<string, Set<string>>()
  const listTypes = new Map<string, Set<string>>()
  for (const match of matches) {
    for (const row of match.rows) {
      if (row.valueType === 'list' && Array.isArray(row.value)) {
        const types = listTypes.get(row.key) ?? new Set()
        for (const item of row.value) {
          const pyType =
            TYPE_MAP[
              typeof item === 'number'
                ? 'number'
                : typeof item === 'boolean'
                  ? 'bool'
                  : 'text'
            ]
          if (pyType) types.add(pyType)
        }
        listTypes.set(row.key, types)
      } else {
        const types = scalarTypes.get(row.key) ?? new Set()
        const pyType = TYPE_MAP[row.valueType]
        if (pyType) types.add(pyType)
        scalarTypes.set(row.key, types)
      }
    }
  }
  const orderedKeys = new Set<string>()
  for (const key of listTypes.keys()) orderedKeys.add(key)
  for (const [key] of scalarTypes) orderedKeys.add(key)
  const result = [...orderedKeys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const parts: string[] = []
      const scalar = scalarTypes.get(key)
      if (scalar && scalar.size > 0) {
        parts.push([...scalar].sort().join('|'))
      }
      const list = listTypes.get(key)
      if (list && list.size > 0) {
        parts.push(`list[${[...list].sort().join('|')}]`)
      }
      return `${key}: ${parts.join(' | ')}`
    })
  return {
    kind: 'distinct',
    key: 'available_keys',
    values: result,
  }
}

function orderMatchedRows<T extends { file: TFile; rows: MetadataKvRow[] }>(
  rows: T[],
  orderBy: MetadataSearchDslQuery['orderBy'],
): T[] {
  if (!orderBy) return rows
  const resolved = resolveSearchMetadataKey(orderBy.key)
  const direction = orderBy.direction === 'desc' ? -1 : 1
  return [...rows].sort((left, right) => {
    const compared = compareMetadataValues(
      firstResolvedRowValue(left.rows, resolved.keys),
      firstResolvedRowValue(right.rows, resolved.keys),
    )
    if (compared !== 0) return compared * direction
    return left.file.path.localeCompare(right.file.path)
  })
}

function firstResolvedRowValue(
  rows: MetadataKvRow[],
  keys: string[],
): string | number | boolean | undefined {
  const row = rows.find((r) => keys.includes(r.key) && r.valueType !== 'list')
  return row?.value as string | number | boolean | undefined
}

function compareMetadataValues(
  left: string | number | boolean | undefined,
  right: string | number | boolean | undefined,
): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function projectMetadata(
  rows: MetadataKvRow[],
  select: '**' | string[],
): Record<string, Array<string | number | boolean>> {
  const selected =
    select === '**'
      ? null
      : new Set(select.flatMap((key) => resolveSearchMetadataKey(key).keys))
  const projected: Record<string, Array<string | number | boolean>> = {}
  for (const row of rows) {
    if (selected != null && !selected.has(row.key)) continue
    if (row.valueType === 'list') continue
    projected[row.key] ??= []
    projected[row.key].push(row.value as string | number | boolean)
  }
  return projected
}

const BUILTIN_METADATA_ALIAS_ENTRIES: MetadataAliasEntry[] = [
  // $title
  {
    alias: 'file title',
    canonicalKeys: ['$title'],
    source: 'builtin',
    priority: 0,
  },
  { alias: 'name', canonicalKeys: ['$title'], source: 'builtin', priority: 1 },
  { alias: 'title', canonicalKeys: ['$title'], source: 'builtin', priority: 0 },
  // $file_name
  {
    alias: 'file name',
    canonicalKeys: ['$file_name'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'filename',
    canonicalKeys: ['$file_name'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'file_name',
    canonicalKeys: ['$file_name'],
    source: 'builtin',
    priority: 0,
  },
  // $source_path
  {
    alias: 'path',
    canonicalKeys: ['$source_path'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'file path',
    canonicalKeys: ['$source_path'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'source',
    canonicalKeys: ['$source_path'],
    source: 'builtin',
    priority: 1,
  },
  {
    alias: 'source_path',
    canonicalKeys: ['$source_path'],
    source: 'builtin',
    priority: 0,
  },
  // $folder_path
  {
    alias: 'folder',
    canonicalKeys: ['$folder_path'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'directory',
    canonicalKeys: ['$folder_path'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'dir',
    canonicalKeys: ['$folder_path'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'folder_path',
    canonicalKeys: ['$folder_path'],
    source: 'builtin',
    priority: 0,
  },
  // $document_type
  {
    alias: 'type',
    canonicalKeys: ['$document_type'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'file type',
    canonicalKeys: ['$document_type'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'extension',
    canonicalKeys: ['$document_type'],
    source: 'builtin',
    priority: 1,
  },
  {
    alias: 'document_type',
    canonicalKeys: ['$document_type'],
    source: 'builtin',
    priority: 0,
  },
  // $tag
  { alias: 'tags', canonicalKeys: ['$tag'], source: 'builtin', priority: 0 },
  { alias: 'tag', canonicalKeys: ['$tag'], source: 'builtin', priority: 0 },
  // $alias
  {
    alias: 'aliases',
    canonicalKeys: ['$alias'],
    source: 'builtin',
    priority: 0,
  },
  { alias: 'alias', canonicalKeys: ['$alias'], source: 'builtin', priority: 0 },
  // $link
  { alias: 'links', canonicalKeys: ['$link'], source: 'builtin', priority: 0 },
  { alias: 'link', canonicalKeys: ['$link'], source: 'builtin', priority: 0 },
  // $outlink
  {
    alias: 'outlinks',
    canonicalKeys: ['$outlink'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'outgoing link',
    canonicalKeys: ['$outlink'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'outgoing links',
    canonicalKeys: ['$outlink'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'outlink',
    canonicalKeys: ['$outlink'],
    source: 'builtin',
    priority: 0,
  },
  // $inlink
  {
    alias: 'backlink',
    canonicalKeys: ['$inlink'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'backlinks',
    canonicalKeys: ['$inlink'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'incoming link',
    canonicalKeys: ['$inlink'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'incoming links',
    canonicalKeys: ['$inlink'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'inlink',
    canonicalKeys: ['$inlink'],
    source: 'builtin',
    priority: 0,
  },
  // $embed
  {
    alias: 'embeds',
    canonicalKeys: ['$embed'],
    source: 'builtin',
    priority: 0,
  },
  { alias: 'embed', canonicalKeys: ['$embed'], source: 'builtin', priority: 0 },
  // $heading
  {
    alias: 'headers',
    canonicalKeys: ['$heading'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'headings',
    canonicalKeys: ['$heading'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'header',
    canonicalKeys: ['$heading'],
    source: 'builtin',
    priority: 0,
  },
  {
    alias: 'heading',
    canonicalKeys: ['$heading'],
    source: 'builtin',
    priority: 0,
  },
  // $heading_level
  {
    alias: 'heading_level',
    canonicalKeys: ['$heading_level'],
    source: 'builtin',
    priority: 0,
  },
  // $section_type
  {
    alias: 'section_type',
    canonicalKeys: ['$section_type'],
    source: 'builtin',
    priority: 0,
  },
  // $list_item_count
  {
    alias: 'list_item_count',
    canonicalKeys: ['$list_item_count'],
    source: 'builtin',
    priority: 0,
  },
  // $task_count
  {
    alias: 'task_count',
    canonicalKeys: ['$task_count'],
    source: 'builtin',
    priority: 0,
  },
]

function resolveSearchMetadataKey(rawKey: string): {
  canonicalUserKey: string
  keys: string[]
} {
  const canonicalUserKey = canonicalizeMetadataKey(rawKey)
  const resolved = resolveMetadataFilter(
    { key: rawKey, op: 'eq', value: '' },
    {
      aliasEntries: [...BUILTIN_METADATA_ALIAS_ENTRIES],
    },
  )

  const keys =
    resolved.resolutionMethod === 'alias'
      ? [...resolved.resolvedKeys, canonicalUserKey]
      : resolved.resolvedKeys
  return { canonicalUserKey, keys }
}

function rowMatchesFilter(row: MetadataKvRow, filter: MetadataFilter): boolean {
  if (row.valueType === 'list' && Array.isArray(row.value)) {
    if (filter.op === 'contains') {
      return row.value.some((item) => item === filter.value)
    }
    if (filter.op === 'like') {
      return row.value.some(
        (item) =>
          typeof item === 'string' &&
          typeof filter.value === 'string' &&
          item.includes(filter.value),
      )
    }
    return false
  }
  if (filter.op === 'contains' || filter.op === 'like') {
    return (
      row.valueType === 'text' &&
      typeof row.value === 'string' &&
      typeof filter.value === 'string' &&
      row.value.includes(filter.value)
    )
  }
  if (filter.op === 'eq') return row.value === filter.value
  if (filter.op === 'neq') return row.value !== filter.value
  if (
    row.valueType === 'number' &&
    typeof row.value === 'number' &&
    typeof filter.value === 'number'
  ) {
    if (filter.op === 'gte') return row.value >= filter.value
    if (filter.op === 'gt') return row.value > filter.value
    if (filter.op === 'lte') return row.value <= filter.value
    return row.value < filter.value
  }

  const rowMs = tryParseDateMs(row.value)
  const filterMs = tryParseDateMs(filter.value)
  if (rowMs != null && filterMs != null) {
    if (filter.op === 'gte') return rowMs >= filterMs
    if (filter.op === 'gt') return rowMs > filterMs
    if (filter.op === 'lte') return rowMs <= filterMs
    return rowMs < filterMs
  }

  return false
}

function tryParseDateMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= -8.64e15 && value <= 8.64e15 ? value : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  const isoMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/,
  )
  if (isoMatch) {
    const ms = Date.UTC(
      Number(isoMatch[1]),
      Number(isoMatch[2]) - 1,
      Number(isoMatch[3]),
      Number(isoMatch[4] ?? 0),
      Number(isoMatch[5] ?? 0),
      Number(isoMatch[6] ?? 0),
    )
    if (Number.isFinite(ms)) return ms
  }

  const epoch = Date.parse(trimmed)
  if (Number.isFinite(epoch)) return epoch

  return null
}
