import { compressToolResult } from './contentCompressor'

describe('compressToolResult', () => {
  it('returns short content unchanged', () => {
    expect(compressToolResult('ok', 100)).toBe('ok')
  })

  it('preserves JSON keys, short values, and primitives while truncating long values', () => {
    const payload = JSON.stringify({
      status: 'ok',
      file: 'src/main.ts',
      error: null,
      count: 42,
      longOutput: 'x'.repeat(10_000),
      nested: { path: '/vault/a.md', detail: 'y'.repeat(5_000) },
    })

    const result = compressToolResult(payload, 800)

    expect(result.length).toBeLessThanOrEqual(800)
    expect(result).toContain('"status"')
    expect(result).toContain('"ok"')
    expect(result).toContain('"file"')
    expect(result).toContain('src/main.ts')
    expect(result).toContain('"count"')
    expect(result).toContain('42')
    expect(result).toContain('"error"')
    expect(result).toContain('"nested"')
    expect(result).toContain('/vault/a.md')
    // Long values are truncated, not dropped wholesale.
    expect(result).toContain('truncated')
  })

  it('samples oversized arrays with an omission count', () => {
    const payload = JSON.stringify({
      items: Array.from({ length: 100 }, (_, index) => `item-${index}`),
    })

    // Budget below the payload length so compression actually runs.
    const result = compressToolResult(payload, 300)

    expect(result.length).toBeLessThanOrEqual(2_000)
    expect(result).toContain('item-0')
    expect(result).toContain('item-99')
    expect(result).toMatch(/more items omitted/)
    // Keys survive the sampling.
    expect(result).toContain('"items"')
  })

  it('merges repeated lines in plain text before truncating', () => {
    const payload = `${'retry failed\n'.repeat(50)}final status: ok`
    const result = compressToolResult(payload, 200)

    expect(result.length).toBeLessThanOrEqual(200)
    expect(result).toContain('retry failed (×50)')
    expect(result).toContain('final status: ok')
  })

  it('falls back to positional truncation for non-JSON oversized text', () => {
    const payload = 'a'.repeat(5_000)
    const result = compressToolResult(payload, 200)

    expect(result.length).toBeLessThanOrEqual(200)
    expect(result.startsWith('a')).toBe(true)
    expect(result.endsWith('a')).toBe(true)
    expect(result).toContain('truncated')
  })

  it('does not corrupt malformed JSON-looking content', () => {
    const payload = `{"broken": [unclosed`
    const result = compressToolResult(payload, 100)

    expect(result.length).toBeLessThanOrEqual(100)
    expect(result).toContain('broken')
  })
})
