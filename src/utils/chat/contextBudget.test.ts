import type { ContentPart } from '../../types/llm/request'

import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  MAX_TOOL_RESULT_MAX_CHARS,
  MAX_USER_MESSAGE_CONTEXT_CHARS,
  MIN_TOOL_RESULT_MAX_CHARS,
  boundRequestMessagesForContext,
  resolveToolResultMaxChars,
  truncateContextText,
} from './contextBudget'

describe('context budget helpers', () => {
  it('keeps a truncated value within the configured character ceiling', () => {
    const result = truncateContextText('a'.repeat(100), 80, 'tool result')

    expect(result.length).toBeLessThanOrEqual(80)
    expect(result).toContain('truncated')
    expect(result.startsWith('a')).toBe(true)
    expect(result.endsWith('a')).toBe(true)
  })

  it('normalizes the configured tool result limit to the supported range', () => {
    expect(resolveToolResultMaxChars(undefined)).toBe(
      DEFAULT_TOOL_RESULT_MAX_CHARS,
    )
    expect(resolveToolResultMaxChars(1)).toBe(MIN_TOOL_RESULT_MAX_CHARS)
    expect(resolveToolResultMaxChars(MAX_TOOL_RESULT_MAX_CHARS + 1)).toBe(
      MAX_TOOL_RESULT_MAX_CHARS,
    )
  })

  it('keeps image and document content parts intact when bounding user messages', () => {
    const imagePart: ContentPart = {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${'A'.repeat(500_000)}`,
      },
    }
    const documentPart: ContentPart = {
      type: 'document',
      mediaType: 'application/pdf',
      name: 'doc.pdf',
      data: 'AA'.repeat(100_000),
      pageCount: 3,
    }
    const oversizedText: ContentPart = {
      type: 'text',
      text: 'x'.repeat(300_000),
    }

    const bounded = boundRequestMessagesForContext(
      [{ role: 'user', content: [imagePart, oversizedText, documentPart] }],
      16_000,
    )

    expect(bounded[0].content).toHaveLength(3)
    const content = bounded[0].content as ContentPart[]
    expect(content[0]).toBe(imagePart)
    expect(content[2]).toBe(documentPart)
    expect((content[1] as { type: 'text'; text: string }).text.length).toBeLessThanOrEqual(
      MAX_USER_MESSAGE_CONTEXT_CHARS,
    )
  })
})
