/**
 * Deterministic JSON serialization with sorted object keys, so output is
 * byte-identical regardless of key insertion order. Useful for building stable
 * cache keys and fingerprints from logically-equivalent objects.
 *
 * Cycle handling: a circular reference (an object reachable again on the
 * current recursion path) is serialized as `"[Circular]"` instead of recursing
 * forever (stack overflow). All current callers compute fingerprints/cache
 * keys, so a poisoned value must degrade to a stable marker rather than crash
 * the calling path. Shared-but-not-circular references are serialized fully on
 * each occurrence (the seen-set only tracks the current path).
 */
export function stableStringify(value: unknown): string {
  return stableStringifyAtPath(value, new Set<object>())
}

function stableStringifyAtPath(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (seen.has(value)) {
    return JSON.stringify('[Circular]')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return (
        '[' +
        value.map((item) => stableStringifyAtPath(item, seen)).join(',') +
        ']'
      )
    }
    const record = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            stableStringifyAtPath(record[key], seen),
        )
        .join(',') +
      '}'
    )
  } finally {
    seen.delete(value)
  }
}
