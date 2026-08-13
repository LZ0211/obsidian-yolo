import type { ChatMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import {
  SUBAGENT_RESULT_MAX_CHARS,
  truncateLiveTranscriptMessages,
  truncateSubagentResult,
} from './result-limit'

describe('truncateSubagentResult', () => {
  it('truncates oversized results to a head+tail window with a marker', () => {
    const long = 'a'.repeat(10_000)
    const { text, truncated, originalLength } = truncateSubagentResult(
      long,
      8_000,
    )
    expect(truncated).toBe(true)
    expect(originalLength).toBe(10_000)
    // The content budget is the cap (4_000 head + 4_000 tail); the marker is
    // additive on top (see `truncateOutput`), so the total is cap + marker.
    expect(text.length).toBe(SUBAGENT_RESULT_MAX_CHARS + '…[truncated]…'.length)
    expect(text.startsWith('a'.repeat(4_000))).toBe(true)
    expect(text.endsWith('a'.repeat(4_000))).toBe(true)
    expect(text).toContain('…[truncated]…')
  })

  it('leaves short results untouched', () => {
    expect(truncateSubagentResult('hi')).toEqual({
      text: 'hi',
      truncated: false,
      originalLength: 2,
    })
  })
})

describe('truncateLiveTranscriptMessages (S4)', () => {
  const huge = 'x'.repeat(SUBAGENT_RESULT_MAX_CHARS * 2)

  const makeTranscript = (): ChatMessage[] => [
    {
      role: 'user',
      id: 'u1',
      content: null,
      promptContent: 'prompt',
      mentionables: [],
    },
    { role: 'assistant', id: 'a1', content: huge },
    {
      role: 'tool',
      id: 't1',
      toolCalls: [
        {
          request: { id: 'c1', name: 'fs_read' },
          response: {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: huge },
          },
        },
      ],
    },
    { role: 'assistant', id: 'a2', content: 'small' },
  ]

  it('truncates oversized assistant content and tool-result text to the cap window', () => {
    const truncated = truncateLiveTranscriptMessages(makeTranscript(), 200)

    expect(truncated).toHaveLength(4)
    const assistant = truncated[1]
    expect(assistant.role).toBe('assistant')
    if (assistant.role !== 'assistant') return
    expect(assistant.content.length).toBeLessThan(huge.length)
    expect(assistant.content).toContain('…[truncated]…')
    expect(assistant.content.startsWith('x'.repeat(100))).toBe(true)
    expect(assistant.content.endsWith('x'.repeat(100))).toBe(true)

    const tool = truncated[2]
    expect(tool.role).toBe('tool')
    if (tool.role !== 'tool') return
    const text = tool.toolCalls[0].response.data.text
    expect(text.length).toBeLessThan(huge.length)
    expect(text).toContain('…[truncated]…')

    // Untruncated pieces are preserved byte-for-byte.
    expect(truncated[3]).toEqual({ role: 'assistant', id: 'a2', content: 'small' })
  })

  it('returns the input reference unchanged when nothing exceeds the cap', () => {
    const transcript = [
      { role: 'assistant', id: 'a1', content: 'short' } as ChatMessage,
    ]
    expect(truncateLiveTranscriptMessages(transcript, 200)).toBe(transcript)
  })
})
