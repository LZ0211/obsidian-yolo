import type { ResponseInputItem } from 'openai/resources/responses/responses'

import type { LLMProvider } from '../../types/provider.types'
import { ChatGPTOAuthResponsesAdapter } from '../llm/chatgptOAuthResponsesAdapter'

import {
  appendToolOutputItems,
  isResponsesCapable,
  supportsResponsesStatefulContinuation,
} from './responsesContinuation'

describe('responsesContinuation', () => {
  describe('appendToolOutputItems', () => {
    it('appends a function_call_output item and returns a new immutable handle', () => {
      const cont = {
        previousResponseId: 'resp_1',
        pendingInputItems: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{}',
          },
        ] as ResponseInputItem[],
        endTurn: false,
      }

      const next = appendToolOutputItems(cont, 'call_1', '# Hello')

      // The original handle is untouched.
      expect(cont.pendingInputItems).toHaveLength(1)
      expect(cont.previousResponseId).toBe('resp_1')
      expect(cont.endTurn).toBe(false)

      // A new handle carries the appended item and preserves the rest.
      expect(next).not.toBe(cont)
      expect(next.previousResponseId).toBe('resp_1')
      expect(next.endTurn).toBe(false)
      expect(next.pendingInputItems).toEqual([
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '# Hello',
        },
      ])
    })
  })

  describe('isResponsesCapable', () => {
    const provider = (
      presetType: LLMProvider['presetType'],
      apiType: LLMProvider['apiType'],
    ): LLMProvider => ({ id: 'p', presetType, apiType })

    it('is true only for the Responses-capable provider paths', () => {
      expect(isResponsesCapable(provider('openai', 'openai-responses'))).toBe(
        true,
      )
      expect(
        isResponsesCapable(provider('chatgpt-oauth', 'openai-responses')),
      ).toBe(true)
    })

    it('is false for every non-Responses provider', () => {
      expect(
        isResponsesCapable(provider('openai-compatible', 'openai-compatible')),
      ).toBe(false)
      expect(isResponsesCapable(provider('anthropic', 'anthropic'))).toBe(false)
      expect(isResponsesCapable(provider('gemini', 'gemini'))).toBe(false)
      expect(
        isResponsesCapable(provider('amazon-bedrock', 'amazon-bedrock')),
      ).toBe(false)
    })
  })

  describe('supportsResponsesStatefulContinuation', () => {
    it('is true by default and for stateful endpoints', () => {
      expect(supportsResponsesStatefulContinuation()).toBe(true)
      expect(
        supportsResponsesStatefulContinuation('https://api.openai.com/v1'),
      ).toBe(true)
      expect(
        supportsResponsesStatefulContinuation(
          'https://chatgpt.com/backend-api/codex',
        ),
      ).toBe(true)
    })

    it('is false for stateless endpoints like DeepSeek', () => {
      expect(
        supportsResponsesStatefulContinuation('https://api.deepseek.com'),
      ).toBe(false)
      expect(
        supportsResponsesStatefulContinuation('https://api.deepseek.com/v1'),
      ).toBe(false)
    })
  })

  describe('adapter buildRequest continuation branch', () => {
    const adapter = new ChatGPTOAuthResponsesAdapter()

    it('emits previous_response_id + pendingInputItems and sets end_turn from the handle', () => {
      const request = adapter.buildRequest({
        model: 'gpt-5.4',
        stream: false,
        continuation: {
          previousResponseId: 'resp_prev',
          pendingInputItems: [
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: '# Hello',
            },
          ],
          endTurn: false,
        },
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Read README.md' },
        ],
      })

      expect(request.previous_response_id).toBe('resp_prev')
      expect(request.input).toEqual([
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '# Hello',
        },
      ])
      expect(request.end_turn).toBe(false)
    })

    it('falls back to the message-history input when no continuation is present', () => {
      const request = adapter.buildRequest({
        model: 'gpt-5.4',
        stream: false,
        messages: [{ role: 'user', content: 'Read README.md' }],
      })

      expect(request.previous_response_id).toBeUndefined()
      expect(request.input).toEqual([
        { role: 'user', content: 'Read README.md', type: 'message' },
      ])
      expect(request.end_turn).toBeUndefined()
    })

    it('falls back to the message-history input when previousResponseId is null', () => {
      const request = adapter.buildRequest({
        model: 'gpt-5.4',
        stream: false,
        continuation: {
          previousResponseId: null,
          pendingInputItems: [],
          endTurn: false,
        },
        messages: [{ role: 'user', content: 'Read README.md' }],
      })

      expect(request.previous_response_id).toBeUndefined()
      expect(request.input).toEqual([
        { role: 'user', content: 'Read README.md', type: 'message' },
      ])
      expect(request.end_turn).toBeUndefined()
    })
  })
})
