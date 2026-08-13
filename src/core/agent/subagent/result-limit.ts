import type { ChatMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'

/** Cap for a child subagent result injected back into the parent conversation. */
export const SUBAGENT_RESULT_MAX_CHARS = 8_000

const SUBAGENT_RESULT_TRUNCATION_MARKER = '…[truncated]…'

/**
 * Length of the truncation marker. Callers that want the configured cap to be a
 * real ceiling pass `maxChars - SUBAGENT_RESULT_TRUNCATION_MARKER_LENGTH` as the
 * content budget, so the marker fits inside the cap instead of on top of it.
 */
export const SUBAGENT_RESULT_TRUNCATION_MARKER_LENGTH =
  SUBAGENT_RESULT_TRUNCATION_MARKER.length

type SubagentResultMaxCharsSettingsGetter = () => number | undefined

let settingsGetter: SubagentResultMaxCharsSettingsGetter | undefined

/**
 * Optional live read of the configured result cap. The host wires this once at
 * startup to the current run settings (via a getter that re-reads the settings
 * object each call), so changing `subagentResultMaxChars` in settings takes
 * effect without a restart. `undefined` falls back to the built-in default.
 */
export function setSubagentResultMaxCharsSettingsGetter(
  getter: SubagentResultMaxCharsSettingsGetter,
): void {
  settingsGetter = getter
}

/** Test/teardown hook: drop the settings getter, falling back to the default. */
export function resetSubagentResultMaxCharsSettingsGetter(): void {
  settingsGetter = undefined
}

/** The effective result cap: the settings getter wins over the built-in default. */
export function getSubagentResultMaxChars(): number {
  return settingsGetter?.() ?? SUBAGENT_RESULT_MAX_CHARS
}

/**
 * Bound a child subagent result to a head+tail window so a single runaway
 * child cannot bloat the parent context on every re-send.
 *
 * Oversized text keeps the first ~maxChars/2 chars and the last ~maxChars/2
 * chars, joined by a truncation marker. The content budget is `maxChars`
 * (mirroring `truncateOutput`); the marker is additive on top. The full result
 * stays in the child's durable session transcript — this only caps the copy
 * re-sent to the parent.
 */
export function truncateSubagentResult(
  text: string,
  maxChars: number = SUBAGENT_RESULT_MAX_CHARS,
): { text: string; truncated: boolean; originalLength: number } {
  const originalLength = text.length
  if (originalLength <= maxChars) {
    return { text, truncated: false, originalLength }
  }

  const headChars = Math.floor(maxChars / 2)
  const tailChars = maxChars - headChars
  return {
    text:
      text.slice(0, headChars) +
      SUBAGENT_RESULT_TRUNCATION_MARKER +
      text.slice(originalLength - tailChars),
    truncated: true,
    originalLength,
  }
}

/**
 * Bound a live-transcript snapshot before the runner stores it in the task
 * registry (S4). The UI renders this array live (SubagentCard preview + detail
 * modal) and a runaway child can emit megabyte tool results or final answers;
 * without a cap the registry holds the whole blob for the task's lifetime.
 * Each oversized text piece (assistant content, Success tool-result text) is
 * cut to the same configured head+tail window that bounds the parent-side
 * result injection — the settings-driven cap applies at subscription time.
 * Returns the input reference unchanged when nothing exceeds the cap, so
 * subscribers can keep referential-equality short-circuits.
 */
export function truncateLiveTranscriptMessages(
  messages: ChatMessage[],
  maxChars: number = getSubagentResultMaxChars(),
): ChatMessage[] {
  if (messages.length === 0) return messages
  let changed = false
  const result = messages.map((message) => {
    if (message.role === 'assistant') {
      const { text, truncated } = truncateSubagentResult(message.content, maxChars)
      if (!truncated) return message
      changed = true
      return { ...message, content: text }
    }
    if (message.role === 'tool') {
      const toolCalls = message.toolCalls.map((toolCall) => {
        const response = toolCall.response
        if (response.status !== ToolCallResponseStatus.Success) {
          return toolCall
        }
        const { text, truncated } = truncateSubagentResult(
          response.data.text,
          maxChars,
        )
        if (!truncated) return toolCall
        changed = true
        return {
          ...toolCall,
          response: {
            ...response,
            data: { ...response.data, text },
          },
        }
      })
      if (toolCalls === message.toolCalls) return message
      return { ...message, toolCalls }
    }
    return message
  })
  return changed ? result : messages
}
