import { truncateContextText } from './contextBudget'

/**
 * Content-aware tool-result compression (headroom-style): when a tool result
 * exceeds the budget, preserve structure and high-signal fragments instead of
 * cutting by position alone.
 *
 * - JSON payloads: keys and short values survive intact; long string values
 *   are head/tail-truncated with a marker; oversized arrays are sampled
 *   (head + tail + an omission count). Numbers/booleans/null pass through.
 * - Plain text: consecutive repeated lines collapse to `line (×N)` before the
 *   positional truncation.
 *
 * Conservative by design: only invoked when the text exceeds `maxChars`, and
 * the result is never longer than `maxChars`.
 */

/** Strings at or below this length are kept verbatim. */
const SHORT_VALUE_FULL_CHARS = 64
/** Long string values are truncated to this many chars on the first pass. */
const FIRST_PASS_VALUE_CHARS = 4_000
/** Progressive value budgets tried before falling back to a skeleton. */
const VALUE_BUDGET_STEPS = [FIRST_PASS_VALUE_CHARS, 2_000, 800, 256] as const
/** Oversized arrays keep the first N and last N entries plus a count. */
const ARRAY_SAMPLE_HEAD = 10
const ARRAY_SAMPLE_TAIL = 5
const ARRAY_SAMPLE_THRESHOLD = 20
/** Repeated lines merge only at or above this repetition count. */
const REPEATED_LINE_MIN = 3

export const compressToolResult = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text

  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return compressJsonPreservingStructure(parsed, maxChars)
    } catch {
      // Not strict JSON — fall through to the text path.
    }
  }

  const merged = mergeRepeatedLines(text)
  return merged.length <= maxChars
    ? merged
    : truncateContextText(merged, maxChars, 'tool result')
}

const compressJsonPreservingStructure = (
  value: unknown,
  maxChars: number,
): string => {
  for (const budget of VALUE_BUDGET_STEPS) {
    const compressed = compressValue(value, budget)
    const serialized = JSON.stringify(compressed)
    if (serialized.length <= maxChars) return serialized
  }
  // Last resort: keys plus the shortest value form — the structure skeleton
  // still answers "what did the tool return" even when every value is gone.
  return truncateContextText(
    JSON.stringify(compressValue(value, SHORT_VALUE_FULL_CHARS)),
    maxChars,
    'tool result',
  )
}

const compressValue = (value: unknown, budget: number): unknown => {
  if (typeof value === 'string') {
    return value.length <= budget ? value : truncateContextText(value, budget, 'value')
  }
  if (Array.isArray(value)) {
    if (value.length <= ARRAY_SAMPLE_THRESHOLD) {
      return value.map((item) => compressValue(item, budget))
    }
    const head = value
      .slice(0, ARRAY_SAMPLE_HEAD)
      .map((item) => compressValue(item, budget))
    const tail = value
      .slice(-ARRAY_SAMPLE_TAIL)
      .map((item) => compressValue(item, budget))
    const omitted = value.length - ARRAY_SAMPLE_HEAD - ARRAY_SAMPLE_TAIL
    return [
      ...head,
      `[${omitted} more items omitted]`,
      ...tail,
    ]
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        compressValue(entry, budget),
      ]),
    )
  }
  return value
}

const mergeRepeatedLines = (text: string): string => {
  const lines = text.split('\n')
  const merged: string[] = []
  let runStart = 0
  for (let index = 1; index <= lines.length; index += 1) {
    if (index < lines.length && lines[index] === lines[runStart]) continue
    const runLength = index - runStart
    if (runLength >= REPEATED_LINE_MIN && lines[runStart]) {
      merged.push(`${lines[runStart]} (×${runLength})`)
    } else {
      for (let offset = runStart; offset < index; offset += 1) {
        merged.push(lines[offset])
      }
    }
    runStart = index
  }
  return merged.join('\n')
}
