import type { JsonValue } from '../execution/workflow-run-types'
import { isJsonValue } from '../execution/workflow-run-types'

/**
 * Parses the Run panel input before it reaches the Coordinator.
 *
 * Blank input is rejected. Text that looks like JSON is parsed and only
 * accepted when the parsed value is JSON-compatible (non-finite numbers such
 * as `Infinity` from `JSON.parse('1e999')` are rejected); JSON-shaped text
 * that fails to parse is rejected instead of silently becoming a string, so a
 * mistyped value never turns into a different object. Any other text is
 * passed through as the trimmed string.
 */
export function parseWorkflowRunInput(
  text: string,
): Readonly<{ ok: true; value: JsonValue } | { ok: false; message: string }> {
  const trimmed = text.trim()
  if (trimmed.length === 0)
    return { ok: false, message: 'Workflow run input is empty' }
  if (!looksLikeJson(trimmed)) return { ok: true, value: trimmed }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, message: 'Workflow run input is not valid JSON' }
  }
  if (!isJsonValue(parsed))
    return {
      ok: false,
      message: 'Workflow run input is not JSON-compatible',
    }
  return { ok: true, value: parsed }
}

/** First characters a JSON document can start with, once trimmed. */
function looksLikeJson(trimmed: string): boolean {
  return /^[[{0-9tfn"-]/.test(trimmed)
}
