import {
  extractMemoryQueryKeywords,
  tokenizeMemoryText,
} from './memoryTokenizer'

describe('memory tokenizer', () => {
  it('normalizes text and extracts de-duplicated ASCII and CJK tokens', () => {
    expect(tokenizeMemoryText('  The OBSIDIAN 插件，插件开发。  ')).toEqual(
      expect.arrayContaining(['obsidian', '插件', '开发', '插件开发']),
    )
    expect(
      tokenizeMemoryText('  The OBSIDIAN 插件，插件开发。  '),
    ).not.toContain('the')
    expect(
      tokenizeMemoryText('  The OBSIDIAN 插件，插件开发。 OBSIDIAN  '),
    ).toHaveLength(
      new Set(tokenizeMemoryText('  The OBSIDIAN 插件，插件开发。 OBSIDIAN  '))
        .size,
    )
  })

  it('drops pure punctuation while preserving identifier punctuation', () => {
    const tokens = tokenizeMemoryText(
      '--- ... ___ // foo-bar path/to/file v1.2',
    )

    expect(tokens).toEqual(
      expect.arrayContaining(['foo-bar', 'path/to/file', 'v1.2']),
    )
    expect(tokens).not.toEqual(
      expect.arrayContaining(['---', '...', '___', '//']),
    )
  })

  it('keeps the legacy recall ordering separate from SimHash ordering', () => {
    const tokens = ['aa', 'longest', 'bbb']
    expect(extractMemoryQueryKeywords('aa longest bbb')).toEqual([
      'longest',
      'bbb',
      'aa',
    ])
    expect(tokenizeMemoryText('aa longest bbb')).toEqual(
      [...new Set(tokens)].sort(
        (left, right) =>
          new TextEncoder().encode(left)[0] -
          new TextEncoder().encode(right)[0],
      ),
    )
  })

  it('limits SimHash tokens by code points and count', () => {
    const longToken = `ab${'界'.repeat(100)}`
    const input = `${longToken} ${Array.from({ length: 300 }, (_, index) => `t${index}`).join(' ')}`
    const tokens = tokenizeMemoryText(input)

    expect(tokens).toHaveLength(256)
    expect([...tokens[0]].length).toBeLessThanOrEqual(80)
    expect(tokens).toEqual(
      [...tokens].sort((left, right) => {
        const leftBytes = new TextEncoder().encode(left)
        const rightBytes = new TextEncoder().encode(right)
        const length = Math.min(leftBytes.length, rightBytes.length)
        for (let index = 0; index < length; index += 1) {
          if (leftBytes[index] !== rightBytes[index])
            return leftBytes[index] - rightBytes[index]
        }
        return leftBytes.length - rightBytes.length
      }),
    )
  })

  it('does not retain punctuation after truncating a long token', () => {
    const tokens = tokenizeMemoryText(`${'-'.repeat(100)}a`)

    expect(tokens.every((token) => /[a-z0-9\u3400-\u9fff]/.test(token))).toBe(
      true,
    )
    expect(tokens).not.toContain('-'.repeat(80))
  })

  it('splits a Chinese sentence into whole-run and word-level tokens', () => {
    const tokens = tokenizeMemoryText(
      '\u4eca\u5929\u5929\u6c14\u5f88\u597d\uff0c\u9002\u5408\u6563\u6b65',
    )

    // Whole CJK run (segmenter unavailable) plus segmented words are both kept.
    expect(tokens).toEqual(
      expect.arrayContaining([
        '\u4eca\u5929\u5929\u6c14\u5f88\u597d',
        '\u9002\u5408\u6563\u6b65',
        '\u5929\u6c14',
        '\u5f88\u597d',
        '\u6563\u6b65',
      ]),
    )
    // Stop words are dropped even when they appear as part of a run.
    expect(tokens).not.toContain('\u7684')
  })

  it('keeps CJK whole-run tokens for phrases without a segmenter split', () => {
    const tokens = tokenizeMemoryText(
      '\u5168\u6781\u8033\u7535\u82af\u8bbe\u8ba1\u53c2\u6570',
    )

    expect(tokens).toContain(
      '\u5168\u6781\u8033\u7535\u82af\u8bbe\u8ba1\u53c2\u6570',
    )
    expect(tokens).toEqual(
      expect.arrayContaining([
        '\u53c2\u6570',
        '\u8bbe\u8ba1',
        '\u5168',
        '\u6781',
        '\u8033',
        '\u82af',
        '\u7535',
      ]),
    )
  })

  it('normalizes mixed CJK and ASCII while preserving punctuation-bound tokens', () => {
    const tokens = tokenizeMemoryText(
      '4680\u5168\u6781\u8033\u7535\u82afN/P\u6bd4\u8bbe\u8ba1 v1.2',
    )

    expect(tokens).toEqual(
      expect.arrayContaining([
        '4680',
        'n/p',
        'v1.2',
        '\u6bd4\u8bbe\u8ba1',
        '\u8bbe\u8ba1',
      ]),
    )
    expect(
      tokens.every((token) => /[a-z0-9\u3400-\u9fff/.-]/.test(token)),
    ).toBe(true)
  })

  it('extracts recall keywords longest-first and de-duplicated', () => {
    expect(
      extractMemoryQueryKeywords(
        '\u4eca\u5929\u5929\u6c14\u5f88\u597d\uff0c\u9002\u5408\u6563\u6b65',
      ),
    ).toEqual([
      '\u4eca\u5929\u5929\u6c14\u5f88\u597d',
      '\u9002\u5408\u6563\u6b65',
      '\u5f88\u597d',
      '\u4eca\u5929',
      '\u6563\u6b65',
      '\u9002\u5408',
      '\u5929\u6c14',
    ])
  })
})
