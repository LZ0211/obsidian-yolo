export type MetadataValueType = 'text' | 'number' | 'bool' | 'list'

export type MetadataKvRow = {
  key: string
  valueType: MetadataValueType
  value: string | number | boolean | Array<string | number | boolean>
}

export type MetadataFilter = {
  key: string
  op: 'eq' | 'neq' | 'contains' | 'like' | 'gte' | 'lte' | 'gt' | 'lt'
  value: string | number | boolean
}

export type ResolvedMetadataFilter = MetadataFilter & {
  canonicalUserKey: string
  resolvedKeys: string[]
  resolutionMethod: 'exact' | 'alias' | 'semantic'
}

export type MetadataAliasEntry = {
  alias: string
  canonicalKeys: string[]
  source: 'builtin' | 'user'
  priority: number
}

export type MetadataResolutionOptions = {
  aliasEntries?: MetadataAliasEntry[]
}

export class MetadataResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataResolutionError'
  }
}

function resolutionError(message: string): MetadataResolutionError {
  return new MetadataResolutionError(message)
}

function compareAscii(a: string, b: string): number {
  return a.localeCompare(b, 'en')
}

function canonicalizeAliasTargets(canonicalKeys: string[]): string[] {
  const unique = new Set<string>()
  for (const canonicalKey of canonicalKeys) {
    unique.add(canonicalizeMetadataKey(canonicalKey))
  }
  return [...unique].sort(compareAscii)
}

export function canonicalizeMetadataKey(input: string): string {
  const normalized = input.normalize('NFKC').trim()
  if (normalized.length === 0) {
    throw resolutionError('unresolved metadata key')
  }

  let canonical = ''
  for (const char of normalized) {
    const code = char.charCodeAt(0)
    if (code >= 65 && code <= 90) {
      canonical += String.fromCharCode(code + 32)
      continue
    }
    canonical += char
  }

  canonical = canonical.replace(/[\s\-/]+/g, '_')
  if (canonical.length === 0) {
    throw resolutionError('unresolved metadata key')
  }
  return canonical
}

function bestAliasCandidates(
  aliasEntries: MetadataAliasEntry[],
  canonicalUserKey: string,
): MetadataAliasEntry[] {
  const candidates = aliasEntries
    .map((entry) => ({
      ...entry,
      alias: canonicalizeMetadataKey(entry.alias),
      canonicalKeys: canonicalizeAliasTargets(entry.canonicalKeys),
    }))
    .filter((entry) => entry.alias === canonicalUserKey)

  if (candidates.length === 0) {
    return []
  }

  const lowestPriority = Math.min(...candidates.map((entry) => entry.priority))
  return candidates
    .filter((entry) => entry.priority === lowestPriority)
    .sort((left, right) => {
      if (left.source !== right.source) {
        return left.source.localeCompare(right.source, 'en')
      }
      return left.alias.localeCompare(right.alias, 'en')
    })
}

export function resolveMetadataFilter(
  filter: MetadataFilter,
  options: MetadataResolutionOptions = {},
): ResolvedMetadataFilter {
  const canonicalUserKey = canonicalizeMetadataKey(filter.key)

  if (canonicalUserKey === 'tag' || canonicalUserKey === 'alias') {
    return {
      ...filter,
      canonicalUserKey,
      resolvedKeys: [canonicalUserKey],
      resolutionMethod: 'exact',
    }
  }

  const aliasCandidates = bestAliasCandidates(
    options.aliasEntries ?? [],
    canonicalUserKey,
  )
  if (aliasCandidates.length === 0) {
    return {
      ...filter,
      canonicalUserKey,
      resolvedKeys: [canonicalUserKey],
      resolutionMethod: 'exact',
    }
  }

  const uniqueTargetSets = new Set(
    aliasCandidates.map((entry) => entry.canonicalKeys.join('\u0000')),
  )
  if (uniqueTargetSets.size > 1) {
    throw resolutionError('ambiguous metadata key')
  }

  const resolvedKeys = aliasCandidates[0]?.canonicalKeys ?? []
  if (resolvedKeys.length === 0) {
    throw resolutionError('unresolved metadata key')
  }

  return {
    ...filter,
    canonicalUserKey,
    resolvedKeys,
    resolutionMethod: 'alias',
  }
}
