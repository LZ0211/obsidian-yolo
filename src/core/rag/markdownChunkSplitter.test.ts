import { splitMarkdownIntoChunks } from './markdownChunkSplitter'

describe('splitMarkdownIntoChunks', () => {
  it('splits between H1 sections and keeps heading attached to following content', async () => {
    const text = '# A\n\n正文1\n\n# B\n\n正文2'
    const chunks = await splitMarkdownIntoChunks(text, 15, 0)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].content).toBe('# A\n\n正文1')
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(3)
    expect(chunks[1].content).toBe('# B\n\n正文2')
    expect(chunks[1].startLine).toBe(5)
    expect(chunks[1].endLine).toBe(7)
  })

  it('soft-preserves oversized code blocks: every sub-chunk keeps open/close fence', async () => {
    const line = 'const x = 1\n'
    const body = line.repeat(30) // ~360 chars
    const text = '```ts\n' + body + '```'
    const chunks = await splitMarkdownIntoChunks(text, 100, 0)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.content.startsWith('```ts\n')).toBe(true)
      expect(c.content.endsWith('\n```')).toBe(true)
      expect(c.startLine).toBe(1)
      expect(c.endLine).toBe(32)
    }
  })

  it('emits short code blocks atomically (no split)', async () => {
    const text = 'before\n\n```py\nprint(1)\n```\n\nafter'
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    // With chunkSize=1000 everything merges into one chunk; the code block
    // must appear intact (fences unbroken) inside that chunk.
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toContain('```py\nprint(1)\n```')
  })

  it('soft-preserves oversized tables: 2nd+ sub-chunks repeat header + alignment rows', async () => {
    const header = '| A | B |'
    const align = '|---|---|'
    const rows: string[] = []
    for (let i = 0; i < 30; i++) rows.push(`| ${i} | ${i + 1} |`)
    const text = [header, align, ...rows].join('\n')
    const chunks = await splitMarkdownIntoChunks(text, 80, 0)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.content.startsWith('| A | B |\n|---|---|\n')).toBe(true)
      expect(c.startLine).toBe(1)
      expect(c.endLine).toBe(32)
    }
  })

  it('never emits a heading as a standalone chunk', async () => {
    const prose = '正文内容 '.repeat(40) // ~200 chars
    const text = `## H\n\n${prose}`
    const chunks = await splitMarkdownIntoChunks(text, 80, 0)

    for (const c of chunks) {
      expect(c.content.trim()).not.toBe('## H')
    }
    // The first chunk must carry the heading attached to prose.
    expect(chunks[0].content.startsWith('## H\n\n')).toBe(true)
    expect(chunks[0].startLine).toBe(1)
  })

  it('reports accurate 1-based line numbers across separate chunks', async () => {
    const text = 'AAA\n\nBBB'
    const chunks = await splitMarkdownIntoChunks(text, 5, 0)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({
      content: 'AAA',
      startLine: 1,
      endLine: 1,
    })
    // Line 2 is the blank separator; BBB is on line 3.
    expect(chunks[1]).toEqual({
      content: 'BBB',
      startLine: 3,
      endLine: 3,
    })
  })

  // ----- Real-world edge cases -----

  it('handles a realistic mixed Obsidian note (frontmatter + H1/H2 + code + table + prose)', async () => {
    const text = [
      '---',
      'title: Note',
      '---',
      '',
      '# Top',
      '',
      'Intro paragraph one.',
      '',
      '## Section A',
      '',
      '```ts',
      'const a = 1',
      'const b = 2',
      '```',
      '',
      '| col1 | col2 |',
      '|------|------|',
      '| r1a  | r1b  |',
      '| r2a  | r2b  |',
      '',
      'Closing prose.',
    ].join('\n')
    const chunks = await splitMarkdownIntoChunks(text, 500, 0)

    // Frontmatter is treated as prose and merges with `# Top` heading.
    expect(chunks.length).toBeGreaterThan(0)
    // The code block must appear intact somewhere (not split mid-fence).
    const allContent = chunks.map((c) => c.content).join('\n\n')
    expect(allContent).toContain('```ts\nconst a = 1\nconst b = 2\n```')
    // The table must appear intact somewhere (not split mid-row).
    expect(allContent).toContain(
      '| col1 | col2 |\n|------|------|\n| r1a  | r1b  |\n| r2a  | r2b  |',
    )
    // Every chunk's line range must be within the file (1..22).
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1)
      expect(c.endLine).toBeLessThanOrEqual(22)
      expect(c.startLine).toBeLessThanOrEqual(c.endLine)
    }
  })

  it('does not mistake a 4-space-indented code block for a fenced block', async () => {
    const text = ['    const x = 1', '    const y = 2', '', 'para after'].join(
      '\n',
    )
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    // The indented lines should be treated as prose, not wrapped in fences.
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).not.toContain('```')
  })

  it('handles tilde-fenced code blocks', async () => {
    const line = 'const x = 1\n'
    const body = line.repeat(30)
    const text = '~~~ts\n' + body + '~~~'
    const chunks = await splitMarkdownIntoChunks(text, 100, 0)

    expect(chunks.length).toBeGreaterThan(1)
    // Every sub-chunk must be a self-contained fenced block (``` form, since
    // we normalize fence output to backticks).
    for (const c of chunks) {
      expect(c.content.startsWith('```ts\n')).toBe(true)
      expect(c.content.endsWith('\n```')).toBe(true)
    }
  })

  it('handles a fenced code block with no language tag', async () => {
    const line = 'x'.repeat(80) + '\n'
    const body = line.repeat(5)
    const text = '```\n' + body + '```'
    const chunks = await splitMarkdownIntoChunks(text, 100, 0)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      // Empty lang → fence is "```\n" (no trailing space).
      expect(c.content.startsWith('```\n')).toBe(true)
      expect(c.content.endsWith('\n```')).toBe(true)
    }
  })

  it('handles an unclosed fenced code block (EOF mid-block)', async () => {
    const text = '```ts\nconst a = 1\nconst b = 2'
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    // Should not throw; should emit the whole thing as a single chunk.
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe('```ts\nconst a = 1\nconst b = 2\n```')
  })

  it('handles GFM tables without outer pipes', async () => {
    const header = 'A | B'
    const align = '---|---'
    const rows: string[] = []
    for (let i = 0; i < 20; i++) rows.push(`${i} | ${i + 1}`)
    const text = [header, align, ...rows].join('\n')
    const chunks = await splitMarkdownIntoChunks(text, 60, 0)

    // Should still be recognized as a table and sub-split with header repeated.
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.content.startsWith('A | B\n---|---\n')).toBe(true)
    }
  })

  it('pairs a heading with an oversized following code block (heading on first sub-chunk)', async () => {
    const line = 'const x = 1\n'
    const body = line.repeat(30)
    const text = `## Code\n\n\`\`\`ts\n${body}\`\`\``
    const chunks = await splitMarkdownIntoChunks(text, 100, 0)

    expect(chunks.length).toBeGreaterThan(1)
    // First chunk: heading + first code sub-chunk.
    expect(chunks[0].content.startsWith('## Code\n\n```ts\n')).toBe(true)
    expect(chunks[0].startLine).toBe(1)
    // Every subsequent chunk: just fenced code (no heading prefix).
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].content.startsWith('```ts\n')).toBe(true)
      expect(chunks[i].content.endsWith('\n```')).toBe(true)
    }
  })

  it('pairs a heading with an oversized following table (heading on first sub-chunk)', async () => {
    const header = '| A | B |'
    const align = '|---|---|'
    const rows: string[] = []
    for (let i = 0; i < 30; i++) rows.push(`| ${i} | ${i + 1} |`)
    const text = `## Tbl\n\n${[header, align, ...rows].join('\n')}`
    const chunks = await splitMarkdownIntoChunks(text, 80, 0)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].content.startsWith('## Tbl\n\n| A | B |')).toBe(true)
    expect(chunks[0].startLine).toBe(1)
    // Subsequent table chunks: header+align prefix, no heading.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].content.startsWith('| A | B |\n|---|---|\n')).toBe(true)
      expect(chunks[i].content.startsWith('## Tbl')).toBe(false)
    }
  })

  it('hard-breaks a single code line longer than chunkSize', async () => {
    const longLine = 'x'.repeat(250)
    const text = '```ts\n' + longLine + '\n```'
    const chunks = await splitMarkdownIntoChunks(text, 100, 0)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      // Each slice is wrapped in fences.
      expect(c.content.startsWith('```ts\n')).toBe(true)
      expect(c.content.endsWith('\n```')).toBe(true)
      // No slice exceeds chunkSize.
      expect(c.content.length).toBeLessThanOrEqual(120) // ~100 + fence overhead
    }
  })

  it('does not split a heading from a single short following paragraph', async () => {
    const text = '# Title\n\nshort body'
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe('# Title\n\nshort body')
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(3)
  })

  it('handles consecutive headings (H1 immediately followed by H2)', async () => {
    const text = '# A\n\n## A1\n\nbody of A1'
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    // H1 pairs with the next block (which is H2 + its body merged? No — H2 is
    // its own block, paired with its following prose). So H1 has no following
    // non-heading block to pair with at i=0... actually next block is H2
    // (kind=heading). The pairing code pairs H1 with H2 regardless of kind.
    // H2 then pairs with its prose on the next iteration? No — i was advanced
    // past H2. So H1+H2 go in one chunk, and prose goes in another.
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    // No bare heading chunk.
    for (const c of chunks) {
      expect(c.content.trim()).not.toBe('# A')
      expect(c.content.trim()).not.toBe('## A1')
    }
  })

  it('handles an empty document', async () => {
    const chunks = await splitMarkdownIntoChunks('', 1000, 0)
    expect(chunks).toEqual([])
  })

  it('handles a document with only blank lines', async () => {
    const chunks = await splitMarkdownIntoChunks('\n\n\n', 1000, 0)
    expect(chunks).toEqual([])
  })

  it('does not crash on CJK prose (no language-aware separators)', async () => {
    const text = '这是第一段中文内容。这是第二段中文内容。'.repeat(20)
    const chunks = await splitMarkdownIntoChunks(text, 50, 0)

    expect(chunks.length).toBeGreaterThan(0)
    // Each chunk content length stays within chunkSize + some tolerance.
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(200)
      expect(c.startLine).toBeGreaterThanOrEqual(1)
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine)
    }
  })

  // ----- Non-standard / messy real-world documents -----

  it('recognizes a code block that immediately follows prose (no blank line)', async () => {
    const text = [
      'intro paragraph',
      '```ts',
      'const x = 1',
      '```',
      'outro',
    ].join('\n')
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    const all = chunks.map((c) => c.content).join('\n\n')
    // The fence must be recognized as a code block (kept intact), not merged
    // into the surrounding prose as bare backticks.
    expect(all).toContain('```ts\nconst x = 1\n```')
    // No chunk should contain the fence opening glued onto a prose word.
    for (const c of chunks) {
      expect(c.content).not.toMatch(/intro paragraph```/)
    }
  })

  it('recognizes a table that immediately follows prose (no blank line)', async () => {
    const text = [
      'intro paragraph',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n')
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    const all = chunks.map((c) => c.content).join('\n\n')
    expect(all).toContain('| A | B |\n|---|---|\n| 1 | 2 |')
    // The intro paragraph should not be glued onto the table header row.
    for (const c of chunks) {
      expect(c.content).not.toMatch(/intro paragraph\| A \| B \|/)
    }
  })

  it('recognizes a heading that immediately follows prose (no blank line)', async () => {
    const text = ['intro paragraph', '# Heading', 'body'].join('\n')
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    // Three separate blocks → may merge into one chunk, but the heading must
    // not be glued onto the previous prose word.
    for (const c of chunks) {
      expect(c.content).not.toMatch(/intro paragraph# Heading/)
    }
  })

  it('handles Windows CRLF line endings', async () => {
    const text = '# A\r\n\r\nbody1\r\n\r\n# B\r\n\r\nbody2'
    const chunks = await splitMarkdownIntoChunks(text, 15, 0)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].content).toBe('# A\n\nbody1')
    expect(chunks[1].content).toBe('# B\n\nbody2')
    // No stray \r should leak into chunk content.
    for (const c of chunks) {
      expect(c.content).not.toContain('\r')
    }
  })

  it('treats "blank" lines containing only whitespace as separators', async () => {
    const text = 'para1\n   \t  \npara2'
    const chunks = await splitMarkdownIntoChunks(text, 5, 0)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].content).toBe('para1')
    expect(chunks[1].content).toBe('para2')
  })

  it('handles multiple consecutive blank lines between blocks', async () => {
    const text = 'para1\n\n\n\npara2'
    const chunks = await splitMarkdownIntoChunks(text, 5, 0)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ content: 'para1', startLine: 1, endLine: 1 })
    // para2 is on line 5 (after 3 blank lines).
    expect(chunks[1]).toEqual({ content: 'para2', startLine: 5, endLine: 5 })
  })

  it('handles a heading at end of document with no following content', async () => {
    const text = 'para1\n\n## trailing heading'
    // Small chunkSize forces the heading (18 chars) to exceed the limit on
    // its own; with no following block to pair with, it is emitted as a
    // standalone last-resort chunk rather than dropped.
    const chunks = await splitMarkdownIntoChunks(text, 10, 0)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].content).toBe('para1')
    expect(chunks[1]).toEqual({
      content: '## trailing heading',
      startLine: 3,
      endLine: 3,
    })
  })

  it('handles a plain-text document with no markdown structure', async () => {
    const text = 'just a plain paragraph with no markdown at all, only words.'
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(text)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(1)
  })

  it('handles a single very long prose line (no line breaks at all)', async () => {
    const text = 'word '.repeat(200) // ~1000 chars, single line
    const chunks = await splitMarkdownIntoChunks(text, 100, 0)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.startLine).toBe(1)
      expect(c.endLine).toBe(1)
    }
  })

  it('recognizes a 3-space-indented fence (valid GFM)', async () => {
    const line = 'const x = 1\n'
    const body = line.repeat(30)
    const text = '   ```ts\n' + body + '   ```'
    const chunks = await splitMarkdownIntoChunks(text, 100, 0)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.content.startsWith('```ts\n')).toBe(true)
      expect(c.content.endsWith('\n```')).toBe(true)
    }
  })

  it('does not mistake inline backticks for a fence open', async () => {
    const text = 'use the `code` keyword to do stuff'
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(text)
  })

  it('handles a code block nested inside a list (indented fence under a list item)', async () => {
    const text = [
      '- list item',
      '  ```ts',
      '  const x = 1',
      '  const y = 2',
      '  ```',
      '',
      'after list',
    ].join('\n')
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    // The 2-space-indented fence should be recognized as a code block.
    const all = chunks.map((c) => c.content).join('\n\n')
    expect(all).toContain('```ts\n  const x = 1\n  const y = 2\n```')
  })

  it('handles a fence with extra whitespace around the language tag', async () => {
    const line = 'const x = 1\n'
    const body = line.repeat(30)
    const text = '```  ts  \n' + body + '```'
    const chunks = await splitMarkdownIntoChunks(text, 100, 0)

    expect(chunks.length).toBeGreaterThan(1)
    // The lang is trimmed; output fence uses the trimmed lang.
    for (const c of chunks) {
      expect(c.content.startsWith('```ts\n')).toBe(true)
    }
  })

  it('does not treat a `---` horizontal rule / frontmatter delimiter as a table alignment row', async () => {
    const text = ['para1', '', '---', '', 'para2'].join('\n')
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    // `---` should not be misread as a table alignment row. The content
    // should be preserved (as prose / horizontal rule) without wrapping in
    // table pipes.
    const all = chunks.map((c) => c.content).join('\n\n')
    expect(all).toContain('---')
    for (const c of chunks) {
      expect(c.content).not.toMatch(/^\|.*\|/m)
    }
  })

  it('handles back-to-back tables separated by a blank line', async () => {
    const t1 = ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n')
    const t2 = ['| C | D |', '|---|---|', '| 3 | 4 |'].join('\n')
    const text = `${t1}\n\n${t2}`
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    const all = chunks.map((c) => c.content).join('\n\n')
    expect(all).toContain(t1)
    expect(all).toContain(t2)
  })

  it('preserves Wikilink / Obsidian image syntax inside prose without breaking', async () => {
    const text = 'see [[note A]] and ![[image.png]] for details'
    const chunks = await splitMarkdownIntoChunks(text, 1000, 0)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(text)
  })
})
