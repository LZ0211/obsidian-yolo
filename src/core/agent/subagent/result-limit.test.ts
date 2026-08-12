import {
  SUBAGENT_RESULT_MAX_CHARS,
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
