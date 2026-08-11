// src/core/agent/responsesContinuation.ts
//
// Codex-style stateful continuation for Responses-capable providers. A
// per-run handle keeps one logical response open across tool calls by
// carrying the prior response id plus the accumulated tool-output input
// items, so the adapter can send `previous_response_id` + `input` instead of
// resending the full message history on every iteration. Non-Responses
// providers never construct a handle (`isResponsesCapable` gates it), so
// they stay byte-for-byte on the message-history path.
import type { ResponseInputItem } from 'openai/resources/responses/responses'

import type { LLMProvider } from '../../types/provider.types'

export type ResponsesContinuation = {
  previousResponseId: string | null
  pendingInputItems: ResponseInputItem[]
  endTurn: boolean
}

/**
 * Append one executed tool call's output to the per-run handle. The handle is
 * CUMULATIVE across turns: each `function_call_output` item is added to the
 * list, so a later turn resends every item accumulated so far as `input`
 * alongside `previous_response_id`. The API is expected to deduplicate against
 * the items already in the open response. If a live-API smoke test later shows
 * the API duplicating earlier items, convert this to a per-turn delta instead.
 */
export function appendToolOutputItems(
  cont: ResponsesContinuation,
  toolCallId: string,
  output: string,
): ResponsesContinuation {
  return {
    ...cont,
    pendingInputItems: [
      ...cont.pendingInputItems,
      {
        type: 'function_call_output',
        call_id: toolCallId,
        output,
      },
    ],
  }
}

export function isResponsesCapable(provider: LLMProvider): boolean {
  return provider.apiType === 'openai-responses'
}

/**
 * Whether a Responses-capable provider supports STATEFUL continuation via
 * `previous_response_id`. DeepSeek's `/v1/responses` is a stateless API: it
 * returns `previous_response_id: null` and rejects a delta-only `input` of
 * `function_call_output` items without the preceding assistant tool-call
 * message (400 "No tool call found"). For such providers the continuation must
 * resend the FULL structured input (`toInputItems` of the message history)
 * instead of `previous_response_id` + accumulated items. Defaults to stateful;
 * known stateless endpoints are listed here.
 */
export function supportsResponsesStatefulContinuation(baseUrl?: string): boolean {
  const host = (baseUrl ?? '').toLowerCase()
  return !host.includes('deepseek.com')
}
