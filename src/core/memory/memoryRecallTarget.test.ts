import {
  MAX_RECALL_CONTEXT_CHARS,
  buildMemoryRecallTarget,
} from './memoryRecallTarget'

describe('memory recall target', () => {
  it('keeps the latest query while bounding newest-first context', () => {
    const target = buildMemoryRecallTarget({
      latestQuery: 'Tell me about the current plugin plan',
      recentUserMessages: [
        'oldest message '.repeat(300),
        'newer message about Obsidian memory',
      ],
      compactionSummary: 'summary '.repeat(300),
    })

    expect(target.query).toContain('Tell me about the current plugin plan')
    expect(target.query).toContain('newer message about Obsidian memory')
    expect(target.query.length).toBeLessThanOrEqual(MAX_RECALL_CONTEXT_CHARS)
  })

  it('derives recall fields only from the bounded latest query and five newest messages', () => {
    const target = buildMemoryRecallTarget({
      latestQuery:
        'boundedlatest alpha beta ' + 'x'.repeat(1970) + ' outsidelatesttoken',
      recentUserMessages: [
        'ignoredoldone',
        'ignoredoldtwo',
        'selectedone',
        'selectedtwo',
        'selectedthree',
        'selectedfour',
        'selectedfive',
      ],
    })

    expect(target.query.length).toBeLessThanOrEqual(MAX_RECALL_CONTEXT_CHARS)
    expect(target.entities).toEqual(
      expect.arrayContaining(['boundedlatest', 'alpha', 'beta']),
    )
    expect(target.keywords).toEqual(
      expect.arrayContaining([
        'selectedone',
        'selectedtwo',
        'selectedthree',
        'selectedfour',
        'selectedfive',
      ]),
    )
    expect(target.keywords).not.toContain('outsidelatesttoken')
    expect(target.keywords).not.toContain('ignoredoldone')
    expect(target.keywords).not.toContain('ignoredoldtwo')
    expect(target.entities).not.toContain('outsidelatesttoken')
  })

  it('bounds whitespace processing while retaining selected message and summary content', () => {
    const paddedMessage = `  selected-message ${' '.repeat(100_000)}`
    const paddedSummary = `  selected-summary ${' '.repeat(100_000)}`
    const trimSpy = jest.spyOn(String.prototype, 'trim')

    try {
      const target = buildMemoryRecallTarget({
        latestQuery: 'latest query',
        recentUserMessages: [paddedMessage],
        compactionSummary: paddedSummary,
      })

      expect(target.query).toContain('selected-message')
      expect(target.query).toContain('selected-summary')
      expect(target.query.length).toBeLessThanOrEqual(MAX_RECALL_CONTEXT_CHARS)
      expect(
        Math.max(...trimSpy.mock.contexts.map((value) => String(value).length)),
      ).toBeLessThanOrEqual(MAX_RECALL_CONTEXT_CHARS)
    } finally {
      trimSpy.mockRestore()
    }
  })

  it('uses an explicit mixed-language query without rewrite', () => {
    const target = buildMemoryRecallTarget({
      latestQuery: 'Explain the Obsidian memoryAgent lifecycle',
      recentUserMessages: [],
    })

    expect(target.sector).toBeNull()
    expect(target.keywords).toEqual(
      expect.arrayContaining(['obsidian', 'memoryagent']),
    )
    expect(target.source).toBe('lexical')
  })

  it('retains persisted phrases only when they occur in query or context', () => {
    const matchingTarget = buildMemoryRecallTarget({
      latestQuery: 'Continue the Smart RAG setup',
      recentUserMessages: [],
      knownMemoryKeywords: ['Smart RAG', 'unrelated profile phrase'],
    })
    const unrelatedTarget = buildMemoryRecallTarget({
      latestQuery: 'Continue the plugin setup',
      recentUserMessages: [],
      knownMemoryKeywords: ['Smart RAG'],
    })

    expect(matchingTarget.keywords).toContain('smart rag')
    expect(unrelatedTarget.keywords).not.toContain('smart rag')
  })
})
