import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  MAX_TOOL_RESULT_MAX_CHARS,
  MIN_TOOL_RESULT_MAX_CHARS,
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
})
