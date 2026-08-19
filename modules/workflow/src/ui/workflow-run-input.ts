import type { JsonValue } from '../execution/workflow-run-types'
import { isJsonValue } from '../execution/workflow-run-types'

/**
 * Parses the Run panel input before it reaches the Coordinator.
 *
 * Blank input is rejected. The trimmed text is parsed first, and only
 * accepted when the parsed value is JSON-compatible (non-finite numbers such
 * as `Infinity` from `JSON.parse('1e999')` are rejected). Text that fails to
 * parse is rejected only when it starts with `{` or `[` — a structural JSON
 * attempt that must not silently become a string — while any other text is
 * passed through as the trimmed string, even when its first character could
 * also open a JSON value (a sentence starting with "t" is not a mistyped
 * `true`).
 */
export function parseWorkflowRunInput(
  text: string,
): Readonly<{ ok: true; value: JsonValue } | { ok: false; message: string }> {
  const trimmed = text.trim()
  if (trimmed.length === 0)
    return { ok: false, message: 'Workflow run input is empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    if (/^[[{]/.test(trimmed))
      return { ok: false, message: 'Workflow run input is not valid JSON' }
    return { ok: true, value: trimmed }
  }
  if (!isJsonValue(parsed))
    return {
      ok: false,
      message: 'Workflow run input is not JSON-compatible',
    }
  return { ok: true, value: parsed }
}
