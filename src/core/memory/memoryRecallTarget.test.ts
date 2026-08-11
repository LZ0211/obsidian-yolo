jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

import { executeSingleTurn } from '../ai/single-turn'

import { selectRelevantMemoryEntries } from './memoryAgent'
import {
  MAX_RECALL_CONTEXT_CHARS,
  buildMemoryRecallConversationContext,
  buildMemoryRecallTarget,
  rewriteMemoryRecallTarget,
  shouldRewriteMemoryRecallTarget,
} from './memoryRecallTarget'

const mockExecuteSingleTurn = jest.mocked(executeSingleTurn)

describe('memory recall target', () => {
  beforeEach(() => {
    mockExecuteSingleTurn.mockReset()
  })

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

  it('routes referential queries to rewrite', () => {
    const target = buildMemoryRecallTarget({
      latestQuery: '继续那个方案',
      recentUserMessages: ['我们刚才讨论了 Smart RAG 的迁移方案'],
    })

    expect(shouldRewriteMemoryRecallTarget(target, { hitCount: 1 })).toBe(true)
  })

  it('routes a referential latest query even after a zero hit without context', () => {
    const target = buildMemoryRecallTarget({
      latestQuery: '继续那个方案',
      recentUserMessages: [],
    })

    expect(
      shouldRewriteMemoryRecallTarget(target, {
        hitCount: 0,
        hasUsableRecentContext: false,
      }),
    ).toBe(true)
  })

  it('does not treat referential text in prior context as a latest-query rewrite signal', () => {
    const target = buildMemoryRecallTarget({
      latestQuery: 'Explain the Obsidian memoryAgent lifecycle',
      recentUserMessages: ['Could you explain it one more time?'],
    })

    expect(shouldRewriteMemoryRecallTarget(target, { hitCount: 1 })).toBe(false)
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
    expect(shouldRewriteMemoryRecallTarget(target, { hitCount: 0 })).toBe(false)
  })

  it('keeps rewritten targets sector-neutral without changing the JSON schema', async () => {
    mockExecuteSingleTurn.mockResolvedValue({
      content: JSON.stringify({
        query: 'Smart RAG migration plan',
        keywords: ['smart rag', 'migration'],
        entities: ['smart-rag'],
        categories: ['other'],
        scopes: ['global'],
      }),
      toolCalls: [],
    })
    const target = buildMemoryRecallTarget({
      latestQuery: 'continue that one',
      recentUserMessages: [],
    })

    const rewritten = await rewriteMemoryRecallTarget({
      target,
      result: { hitCount: 1 },
      providerClient: {} as never,
      model: { id: 'chat-model', model: 'chat-model' } as never,
    })

    expect(rewritten.sector).toBeNull()
    const request = mockExecuteSingleTurn.mock.calls[0]?.[0]?.request
    const systemPrompt = request?.messages[0]?.content
    expect(systemPrompt).toContain(
      'Return exactly query, keywords, entities, categories, scopes.',
    )
    expect(systemPrompt).not.toContain('sector')
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

  it('does not route high-confidence zero hits even with usable recent context', () => {
    const target = buildMemoryRecallTarget({
      latestQuery: 'Explain the Obsidian memoryAgent lifecycle',
      recentUserMessages: [
        'We configured the Smart RAG integration yesterday.',
      ],
    })

    expect(
      shouldRewriteMemoryRecallTarget(target, {
        hitCount: 0,
        hasUsableRecentContext: true,
      }),
    ).toBe(false)
    expect(
      shouldRewriteMemoryRecallTarget(target, {
        hitCount: 0,
        hasUsableRecentContext: false,
      }),
    ).toBe(false)
  })

  it('does not rewrite an unrelated high-confidence zero-hit query', () => {
    const target = buildMemoryRecallTarget({
      latestQuery: 'What is the weather in Shanghai tomorrow?',
      recentUserMessages: [],
    })

    expect(
      shouldRewriteMemoryRecallTarget(target, {
        hitCount: 0,
        hasUsableRecentContext: false,
      }),
    ).toBe(false)
  })

  it('rewrites a low-confidence target through a bounded JSON-only turn', async () => {
    mockExecuteSingleTurn.mockResolvedValue({
      content: JSON.stringify({
        query: 'Smart RAG migration plan',
        keywords: ['smart rag', 'migration'],
        entities: ['smart-rag'],
        categories: ['other'],
        scopes: ['assistant', 'global'],
      }),
      toolCalls: [],
    })
    const target = buildMemoryRecallTarget({
      latestQuery: 'continue that one',
      recentUserMessages: ['We discussed the Smart RAG migration plan.'],
      assistantId: 'assistant-1',
    })
    const conversationContext = buildMemoryRecallConversationContext({
      latestQuery: 'continue that one',
      recentUserMessages: ['We discussed the Smart RAG migration plan.'],
    })

    const rewritten = await rewriteMemoryRecallTarget({
      target,
      conversationContext,
      result: { hitCount: 1, hasUsableRecentContext: true },
      providerClient: {} as never,
      model: { id: 'chat-model', model: 'chat-model' } as never,
    })

    expect(rewritten).toMatchObject({
      query: 'Smart RAG migration plan',
      keywords: ['smart rag', 'migration'],
      source: 'model_rewrite',
    })
    expect(mockExecuteSingleTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
        deliveryMode: 'buffered',
        primaryRequestTimeoutMs: 2000,
      }),
    )
    const request = mockExecuteSingleTurn.mock.calls[0]?.[0]?.request
    const systemPrompt = request?.messages[0]?.content
    const userPrompt = request?.messages[1]?.content
    expect(typeof systemPrompt).toBe('string')
    expect(typeof userPrompt).toBe('string')
    if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string') {
      throw new Error('Expected string memory recall prompts')
    }
    expect(systemPrompt).toContain('Rewrite the recall target, not an answer.')
    expect(systemPrompt).toContain(
      'Preserve entities, paths, dates, limits, and language.',
    )
    expect(systemPrompt).toContain(
      'Resolve pronouns only from the supplied context.',
    )
    expect(systemPrompt).toContain(
      'Do not invent facts, aliases, or constraints.',
    )
    expect(systemPrompt).toContain('JSON only.')

    const payload = JSON.parse(userPrompt)
    expect(payload).toEqual({
      conversation: conversationContext,
      lexicalTarget: target,
    })
    expect(JSON.stringify(payload)).not.toContain('Private memory entry')
  })

  it('ranks an entry by a rewritten keyword absent from the original query', async () => {
    mockExecuteSingleTurn.mockResolvedValue({
      content: JSON.stringify({
        query: 'deploy it',
        keywords: ['release-candidate'],
        entities: ['release-candidate'],
        categories: ['other'],
        scopes: ['global'],
      }),
      toolCalls: [],
    })
    const target = buildMemoryRecallTarget({
      latestQuery: 'continue that one',
      recentUserMessages: [],
    })
    const rewritten = await rewriteMemoryRecallTarget({
      target,
      conversationContext: buildMemoryRecallConversationContext({
        latestQuery: 'continue that one',
        recentUserMessages: [],
      }),
      result: { hitCount: 1 },
      providerClient: {} as never,
      model: { id: 'chat-model', model: 'chat-model' } as never,
    })

    expect(
      selectRelevantMemoryEntries(
        [
          {
            id: 'Memory_1',
            content: 'Use the release candidate deployment procedure.',
            keywords: ['release-candidate'],
            category: 'other',
            scope: 'global',
          },
        ],
        rewritten,
      ),
    ).toHaveLength(1)
  })

  it.each([new Error('timeout'), { content: '{not json}', toolCalls: [] }])(
    'falls back to lexical target when rewrite fails or is invalid',
    async (failure) => {
      const target = buildMemoryRecallTarget({
        latestQuery: 'continue that one',
        recentUserMessages: ['We discussed the Smart RAG migration plan.'],
      })
      if (failure instanceof Error) {
        mockExecuteSingleTurn.mockRejectedValue(failure)
      } else {
        mockExecuteSingleTurn.mockResolvedValue(failure)
      }

      await expect(
        rewriteMemoryRecallTarget({
          target,
          result: { hitCount: 1, hasUsableRecentContext: true },
          providerClient: {} as never,
          model: { id: 'chat-model', model: 'chat-model' } as never,
        }),
      ).resolves.toEqual(target)
    },
  )

  it('does not call the model for a high-confidence target', async () => {
    const target = buildMemoryRecallTarget({
      latestQuery: 'Explain the Obsidian memoryAgent lifecycle',
      recentUserMessages: [],
    })

    await expect(
      rewriteMemoryRecallTarget({
        target,
        result: { hitCount: 1 },
        providerClient: {} as never,
        model: { id: 'chat-model', model: 'chat-model' } as never,
      }),
    ).resolves.toEqual(target)
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()
  })

  it('does not call the model for a high-confidence zero-hit target with recent context', async () => {
    const target = buildMemoryRecallTarget({
      latestQuery: 'Explain the Obsidian memoryAgent lifecycle',
      recentUserMessages: [
        'We configured the Smart RAG integration yesterday.',
      ],
    })

    await expect(
      rewriteMemoryRecallTarget({
        target,
        result: { hitCount: 0, hasUsableRecentContext: true },
        providerClient: {} as never,
        model: { id: 'chat-model', model: 'chat-model' } as never,
      }),
    ).resolves.toEqual(target)
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()
  })

  it('aborts a hanging rewrite after the bounded timeout and returns lexical target', async () => {
    jest.useFakeTimers()
    const target = buildMemoryRecallTarget({
      latestQuery: 'continue that one',
      recentUserMessages: ['We discussed the Smart RAG migration plan.'],
    })
    let observedAbort = false
    mockExecuteSingleTurn.mockImplementation(
      ({ signal }) =>
        new Promise(() => {
          signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true
            },
            { once: true },
          )
        }),
    )

    try {
      const rewritten = rewriteMemoryRecallTarget({
        target,
        result: { hitCount: 1, hasUsableRecentContext: true },
        providerClient: {} as never,
        model: { id: 'chat-model', model: 'chat-model' } as never,
      })

      await jest.advanceTimersByTimeAsync(2000)
      await expect(rewritten).resolves.toEqual(target)
      expect(observedAbort).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})
