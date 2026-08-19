jest.mock('./memoryJiebaTokenizer', () => ({
  cutForSearchWithJieba: jest.fn(async () => ['minimal', 'design']),
}))

import {
  estimateTextTokens,
  setTokenizerProviderForTests,
} from '../../utils/llm/contextTokenEstimate'

import {
  MAX_RECALL_CANDIDATE_CHARS,
  MAX_RECALL_CANDIDATE_ENTRIES,
  MAX_RECALL_RENDER_ENTRIES,
  MAX_RECALL_RENDER_TOKENS,
  MemoryRecallOrchestrator,
} from './memoryRecallOrchestrator'
import type { MemoryRecallContext } from './memoryRecallOrchestrator'
import type { MemoryAgentEntryLike } from './memoryRecallOrchestrator'

/**
 * C1+C2 (candidate pool vs final token budget) tests for the token packer.
 * The deterministic tokenizer seam injects a code-point counter so every
 * expected token count is exact; production code only ever calls
 * `estimateTextTokens`, the character counting in these tests never leaves
 * the test files.
 */

const countCodePoints = (text: string): number => Array.from(text).length

const translate = (key: string, fallback: string): string => fallback

const makeEntry = (
  memoryKey: string,
  content: string,
  category = 'other',
): MemoryAgentEntryLike => ({ memoryKey, content, category })

const makeOrchestrator = (): MemoryRecallOrchestrator =>
  new MemoryRecallOrchestrator(
    {
      query: jest.fn(async () => []),
      reinforce: jest.fn(async () => undefined),
      expandViaEdges: jest.fn(async () => []),
    } as never,
    {} as never,
    async () => null,
  )

const renderContext = (
  entries: readonly MemoryAgentEntryLike[],
): MemoryRecallContext => ({
  partition: { scope: 'global', assistantId: null, partitionKey: 'global' },
  sourceFileFingerprint: 'fp',
  entries: [...entries],
  paths: ['lexical'],
  candidateCounts: { lexical: entries.length, vector: 0, graph: 0 },
  candidateLimitHit: false,
})

const renderContent = async (
  orchestrator: MemoryRecallOrchestrator,
  context: MemoryRecallContext,
): Promise<string> => {
  // Task 4: render is async and returns MemoryRecallRenderResult; the block
  // is its `.content` (null only when nothing fit the budget).
  const result: unknown = await Promise.resolve(
    orchestrator.render(context, translate),
  )
  if (typeof result === 'string') return result
  if (typeof result === 'object' && result !== null && 'content' in result) {
    const content = (result as { content: unknown }).content
    if (typeof content === 'string') return content
  }
  throw new Error(
    'render did not produce a block: a too-long entry must be skipped instead of breaking the loop (today it returns null)',
  )
}

describe('MemoryRecallOrchestrator token packer (C1+C2)', () => {
  beforeEach(() => {
    setTokenizerProviderForTests({
      count: async (text: string) => countCodePoints(text),
    })
  })

  afterEach(() => {
    setTokenizerProviderForTests(null)
  })

  it('keeps small entries verbatim while the block stays within the token budget', async () => {
    const entries = [
      makeEntry('first', 'first entry content'),
      ...Array.from({ length: 9 }, (_, index) =>
        makeEntry(`bulk-${index + 1}`, 'b'.repeat(400)),
      ),
    ]
    const content = await renderContent(
      makeOrchestrator(),
      renderContext(entries),
    )

    // Entries that fit must stay verbatim…
    expect(content).toContain('[other] first entry content')
    // …but the whole XML block must stay within the token budget. RED: today
    // the renderer only counts characters (3000), so it renders far more than
    // the 768-token budget allows.
    expect(await estimateTextTokens(content)).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_TOKENS,
    )
  })

  it('truncates an over-budget Chinese entry to fit the token budget', async () => {
    const chineseText = '中文记忆'.repeat(600)
    const content = await renderContent(
      makeOrchestrator(),
      renderContext([makeEntry('cn', chineseText)]),
    )
    expect(content).toContain('<recalled_memory')
    // Truncation must keep the leading code points of the entry…
    expect(content).toContain('中文记忆')
    // …RED: today there is no truncation — the whole 2400-character entry is
    // rendered and blows past the token budget.
    expect(content).not.toContain(chineseText)
    expect(await estimateTextTokens(content)).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_TOKENS,
    )
  })

  it('truncates emoji and surrogate-pair mixed text on code-point boundaries', async () => {
    const mixedText = '🐍 中文 🎉 const x = 1; 👨‍👩‍👧‍👦\n'.repeat(40)
    const content = await renderContent(
      makeOrchestrator(),
      renderContext([makeEntry('mixed', mixedText)]),
    )
    // Truncation must keep the leading code points (astral emoji included)…
    expect(content).toContain('🐍 中文 🎉')
    expect(content).not.toContain(mixedText)
    // …and must never split a surrogate pair (Array.from-style code-point
    // awareness).
    expect(content.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')).not.toMatch(
      /[\uD800-\uDFFF]/,
    )
    expect(await estimateTextTokens(content)).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_TOKENS,
    )
  })

  it('truncates English and code text under the same token budget', async () => {
    const codeText = 'const handle = (x: number): number => x * 2\n'.repeat(60)
    const content = await renderContent(
      makeOrchestrator(),
      renderContext([makeEntry('code', codeText)]),
    )
    // Truncation must keep the leading code points of the code text…
    expect(content).toContain('const handle = (x: number)')
    expect(content).not.toContain(codeText)
    expect(await estimateTextTokens(content)).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_TOKENS,
    )
  })

  it('truncates an entry to the remaining budget after an earlier entry', async () => {
    const bigContent = 'b'.repeat(680)
    const smallContent = 'small entry '.repeat(5)
    const content = await renderContent(
      makeOrchestrator(),
      renderContext([
        makeEntry('big', bigContent),
        makeEntry('small', smallContent),
      ]),
    )
    // The big entry fits in full; the small entry no longer fits the
    // remaining budget and must be truncated, keeping its leading code
    // points. RED: today both entries are rendered in full.
    expect(content).toContain(`[other] ${bigContent}`)
    expect(content).toContain(smallContent.slice(0, 5))
    expect(content).not.toContain(smallContent)
    expect(await estimateTextTokens(content)).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_TOKENS,
    )
  })

  it('reports candidates that cannot fit even truncated with an omitted hint', async () => {
    // Truncate-first arithmetic (code-point tokenizer): the block wrapper is
    // 54 tokens and each full 100-code-point entry line is 108 tokens, so
    // six full lines (648) plus one truncated line (66) fill the 714-token
    // line budget and the three trailing candidates cannot fit even a
    // one-code-point prefix — they must be omitted. The [+3 more omitted]
    // hint (17 tokens) counts into the same budget: the straddling line's
    // truncation reserves the hint's token space first, so the line lands at
    // 49 tokens and the final block is exactly 648 + 49 + 17 = 714.
    const padded = (label: string): string =>
      `${label}${'x'.repeat(100 - label.length)}`
    const fullContents = Array.from({ length: 7 }, (_, index) =>
      padded(`full-${index + 1}: `),
    )
    const tailContents = Array.from({ length: 3 }, (_, index) =>
      padded(`tail-${index + 1}: `),
    )
    const content = await renderContent(
      makeOrchestrator(),
      renderContext([
        ...fullContents.map((entryContent, index) =>
          makeEntry(`full-${index + 1}`, entryContent),
        ),
        ...tailContents.map((entryContent, index) =>
          makeEntry(`tail-${index + 1}`, entryContent),
        ),
      ]),
    )
    // Leading entries that fit are kept in full…
    expect(content).toContain(`[other] ${fullContents[0]}`)
    // …the exhausted candidates are reported with the correct count…
    expect(content).toContain('[+3 more omitted]')
    expect(content).not.toContain('tail')
    // …and the hint itself counts into the same token budget. RED: today
    // there is no omission — all ten entries render (1000 chars ≤ 3000) and
    // no hint exists.
    expect(await estimateTextTokens(content)).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_TOKENS,
    )
  })

  it('returns token and discard statistics alongside the rendered block', async () => {
    const context = renderContext([makeEntry('only', 'only entry')])
    // render is sync today and becomes async in Task 4; Promise.resolve keeps
    // this call valid for both shapes.
    const result: unknown = await Promise.resolve(
      makeOrchestrator().render(context, translate),
    )
    // RED: today render returns a plain string with no token statistics.
    if (
      typeof result !== 'object' ||
      result === null ||
      !('content' in result)
    ) {
      throw new Error(
        'RED: render must return MemoryRecallRenderResult with content/tokenCount/selectedCount/truncatedCount/omittedCount',
      )
    }
    const stats = result as {
      content: string | null
      tokenCount: number
      selectedCount: number
      truncatedCount: number
      omittedCount: number
    }
    expect(stats.content).toContain('[other] only entry')
    expect(stats.selectedCount).toBe(1)
    expect(stats.truncatedCount).toBe(0)
    expect(stats.omittedCount).toBe(0)
    expect(stats.tokenCount).toBe(await estimateTextTokens(stats.content ?? ''))
  })

  it('queries the candidate pool with candidate limits and renders with final limits', async () => {
    const categoryFor = (index: number): string => {
      if (index % 3 === 0) return 'preferences'
      if (index % 3 === 1) return 'profile'
      return 'other'
    }
    const fusedRows = Array.from({ length: 10 }, (_, index) => {
      const memoryKey = `global::k${index + 1}`
      // Categories chosen so a category-sorted row order (preferences →
      // profile → other) differs from the fused order.
      return {
        memoryKey,
        content: `candidate ${index + 1} `.repeat(12),
        category: categoryFor(index),
      }
    })
    const categoryRank = (category: string): number =>
      category === 'preferences' ? 0 : category === 'profile' ? 1 : 2
    const categorySortedRows = [...fusedRows].sort(
      (left, right) =>
        categoryRank(left.category) - categoryRank(right.category),
    )
    const query = jest
      .fn()
      .mockResolvedValueOnce(fusedRows)
      .mockResolvedValueOnce(categorySortedRows)
      .mockResolvedValue(categorySortedRows)
    const store = {
      query,
      reinforce: jest.fn(async () => undefined),
      expandViaEdges: jest.fn(async () => []),
    }
    const orchestrator = new MemoryRecallOrchestrator(
      store as never,
      {} as never,
      async () => null,
    )
    const context = await orchestrator.recall(
      { latestQuery: 'minimal design', recentUserMessages: [] },
      { scope: 'global', assistantId: null, partitionKey: 'global' },
      'fp',
    )

    const calls = query.mock.calls as Array<
      [{ maxEntries: number; maxChars: number; memoryKeys?: readonly string[] }]
    >
    expect(calls).toHaveLength(2)
    for (const [input] of calls) {
      // RED: today both queries are still limited to the final 8 entries /
      // 3000 chars; the candidate pool must use its own larger limits.
      expect(input.maxEntries).toBe(MAX_RECALL_CANDIDATE_ENTRIES)
      expect(input.maxChars).toBe(MAX_RECALL_CANDIDATE_CHARS)
    }
    // The fused-key resolve must receive the fused keys in fused order.
    expect(calls[1]?.[0].memoryKeys).toEqual(
      fusedRows.map(({ memoryKey }) => memoryKey),
    )

    // The final render applies its own entry cap…
    const content = await renderContent(orchestrator, context)
    expect(content).toContain('[preferences] candidate 1 ')
    const renderedNumbers: number[] = []
    for (const line of content.split('\n')) {
      const match = /^\[(?:preferences|profile|other)\] candidate (\d+)/.exec(
        line,
      )
      if (match) renderedNumbers.push(Number(match[1]))
    }
    expect(renderedNumbers.length).toBeGreaterThan(0)
    expect(renderedNumbers.length).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_ENTRIES,
    )
    // …in fused order: category-sorted resolve rows must not reorder it.
    expect(renderedNumbers).toEqual(
      Array.from({ length: renderedNumbers.length }, (_, index) => index + 1),
    )
    expect(await estimateTextTokens(content)).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_TOKENS,
    )
  })

  it('omits the [+N more omitted] notice when it cannot fit the remaining budget', async () => {
    // Tight injected budget: the wrapper is 54 tokens and "[other] " is 8,
    // so exactly one 8-code-point entry fits (70 tokens). The 17-token
    // notice cannot fit even after removing that entry, so it must be
    // omitted and the block must stay within the budget.
    const limits = { maxTokens: 70 }
    const result = await makeOrchestrator().render(
      renderContext([
        makeEntry('tiny', 'x'.repeat(9)),
        makeEntry('huge-1', 'y'.repeat(1000)),
        makeEntry('huge-2', 'z'.repeat(1000)),
        makeEntry('huge-3', 'w'.repeat(1000)),
      ]),
      translate,
      limits,
    )
    expect(result.content).toContain(`[other] ${'x'.repeat(8)}`)
    expect(result.content).not.toContain('omitted')
    expect(result.tokenCount).toBe(limits.maxTokens)
    expect(result.tokenCount).toBeLessThanOrEqual(limits.maxTokens)
    expect(result.selectedCount).toBe(1)
    expect(result.truncatedCount).toBe(1)
    expect(result.omittedCount).toBe(3)
  })

  it('packs content exactly at the token budget and truncates one token over', async () => {
    // Wrapper 54 + "[other] " 8 = 62; a 10-code-point entry lands the block
    // exactly on the 72-token budget (off-by-one guard on both sides).
    const limits = { maxTokens: 72 }
    const under = await makeOrchestrator().render(
      renderContext([makeEntry('under', 'x'.repeat(9))]),
      translate,
      limits,
    )
    expect(under.content).toContain(`[other] ${'x'.repeat(9)}`)
    expect(under.truncatedCount).toBe(0)
    expect(under.tokenCount).toBe(limits.maxTokens - 1)

    const exact = await makeOrchestrator().render(
      renderContext([makeEntry('exact', 'x'.repeat(10))]),
      translate,
      limits,
    )
    expect(exact.content).toContain(`[other] ${'x'.repeat(10)}`)
    expect(exact.truncatedCount).toBe(0)
    expect(exact.tokenCount).toBe(limits.maxTokens)

    const over = await makeOrchestrator().render(
      renderContext([makeEntry('over', 'x'.repeat(11))]),
      translate,
      limits,
    )
    // One code point over the budget: the entry is truncated by exactly one
    // code point and the block lands back on the budget.
    expect(over.content).toContain(`[other] ${'x'.repeat(10)}`)
    expect(over.content).not.toContain('x'.repeat(11))
    expect(over.truncatedCount).toBe(1)
    expect(over.tokenCount).toBe(limits.maxTokens)
  })

  it('never splits a surrogate pair when the truncation cut lands inside an emoji', async () => {
    // 200 emoji = 400 UTF-16 units. Budget 181 = wrapper 54 + "[other] " 8 +
    // 119 code points: the cut falls at an odd code-point index, which a
    // UTF-16-unit cut would land mid-pair (lone surrogate).
    const limits = { maxTokens: 181 }
    const result = await makeOrchestrator().render(
      renderContext([makeEntry('emoji', '🎉'.repeat(200))]),
      translate,
      limits,
    )
    expect(result.content).toContain(`[other] ${'🎉'.repeat(119)}`)
    expect(result.content).not.toContain('🎉'.repeat(120))
    const content = result.content ?? ''
    expect(content.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')).not.toMatch(
      /[\uD800-\uDFFF]/,
    )
    expect(result.tokenCount).toBe(limits.maxTokens)
    expect(result.truncatedCount).toBe(1)
  })
})
