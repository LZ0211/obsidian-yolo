import type { ResponseInputItem } from 'openai/resources/responses/responses'

import { ChatGPTOAuthResponsesAdapter } from '../llm/chatgptOAuthResponsesAdapter'
import type { LLMRequestStreaming } from '../../types/llm/request'

describe('Responses continuation request encoding', () => {
  const adapter = new ChatGPTOAuthResponsesAdapter()

  it('sends previous_response_id + accumulated items + end_turn on continuation turns', () => {
    const pendingInputItems: ResponseInputItem[] = [
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      { type: 'function_call_output', call_id: 'call_2', output: '42' },
    ]
    const request = {
      model: 'gpt-5',
      messages: [
        { role: 'user' as const, content: 'what is 2+2?' },
      ],
      stream: true,
      continuation: {
        previousResponseId: 'resp_123',
        pendingInputItems,
        endTurn: false,
      },
    } as LLMRequestStreaming

    const body = adapter.buildRequest(request) as Record<string, unknown>

    expect(body.previous_response_id).toBe('resp_123')
    expect(body.end_turn).toBe(false)
    // Continuation turns send the accumulated tool-output items as input,
    // NOT the message history.
    expect(body.input).toEqual(pendingInputItems)
    expect(body.model).toBe('gpt-5')
  })

  it('stays on the full message-history path without a continuation handle', () => {
    const request = {
      model: 'gpt-5',
      messages: [
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: 'hi' },
      ],
      stream: true,
    } as LLMRequestStreaming

    const body = adapter.buildRequest(request) as Record<string, unknown>

    expect(body.previous_response_id).toBeUndefined()
    expect(body.end_turn).toBeUndefined()
    expect(body.input).toEqual([
      { role: 'user', content: 'hello', type: 'message' },
      { role: 'assistant', content: 'hi', type: 'message' },
    ])
  })
})
