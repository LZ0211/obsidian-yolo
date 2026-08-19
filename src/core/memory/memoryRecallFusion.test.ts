import {
  estimateTextTokens,
  setTokenizerProviderForTests,
} from '../../utils/llm/contextTokenEstimate'

import { fuseMemoryRecallRanks } from './memoryRecallFusion'
import {
  MAX_RECALL_RENDER_TOKENS,
  MemoryRecallOrchestrator,
} from './memoryRecallOrchestrator'
import type { MemoryRecallContext } from './memoryRecallOrchestrator'

describe('memoryRecallFusion (RRF)', () => {
  it('merges rank positions across paths, promoting shared hits', () => {
    const lexical = ['a', 'b', 'c']
    const vector = ['c', 'a', 'd']
    const graph = ['b', 'c']

    const fused = fuseMemoryRecallRanks(lexical, vector, graph)

    // 'c' appears in all three lists (high ranks) → first.
    expect(fused[0]).toBe('c')
    // 'a' and 'b' appear in two lists → next, in score order.
    expect(fused.slice(0, 3).sort()).toEqual(['a', 'b', 'c'])
    // 'd' appears in one list only → last.
    expect(fused[fused.length - 1]).toBe('d')
  })

  it('keeps the order of a single list unchanged', () => {
    expect(fuseMemoryRecallRanks(['x', 'y', 'z'])).toEqual(['x', 'y', 'z'])
  })

  it('deduplicates and preserves the best combined rank', () => {
    const fused = fuseMemoryRecallRanks(['a', 'b', 'a'], ['a'])
    expect(fused.filter((key) => key === 'a')).toHaveLength(1)
    expect(fused[0]).toBe('a')
  })

  it('returns empty when every list is empty', () => {
    expect(fuseMemoryRecallRanks([], [], [])).toEqual([])
  })
})

/**
 * C1+C2 RED tests: the token packer must traverse the fused order without
 * letting one oversize entry block later candidates, and the final
 * <recalled_memory> block must stay within the token budget.
 */
describe('fused order → token-budget packing (C1+C2)', () => {
  const translate = (key: string, fallback: string): string => fallback

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

  beforeEach(() => {
    setTokenizerProviderForTests({
      count: async (text: string) => Array.from(text).length,
    })
  })

  afterEach(() => {
    setTokenizerProviderForTests(null)
  })

  it('truncates an oversize entry and continues with later candidates in fused order', async () => {
    const fusedOrder = fuseMemoryRecallRanks(['long', 'short', 'later'])
    const contentByKey: Record<string, string> = {
      long: 'L'.repeat(4000),
      short: 'short content',
      later: 'later content',
    }
    const entries = fusedOrder.map((memoryKey) => ({
      memoryKey,
      content: contentByKey[memoryKey],
      category: 'other',
    }))
    const context: MemoryRecallContext = {
      partition: { scope: 'global', assistantId: null, partitionKey: 'global' },
      sourceFileFingerprint: 'fp',
      entries,
      paths: ['lexical'],
      candidateCounts: { lexical: entries.length, vector: 0, graph: 0 },
      candidateLimitHit: false,
    }
    const result: unknown = await Promise.resolve(
      makeOrchestrator().render(context, translate),
    )
    const content =
      typeof result === 'string'
        ? result
        : typeof result === 'object' && result !== null && 'content' in result
          ? (result as { content: unknown }).content
          : null
    // RED: today the renderer breaks out of its loop at the first entry that
    // exceeds the 3000-character budget, so the whole block comes back null
    // and short/later never get a chance to render. Truncate-first packing
    // renders the oversize entry as a leading prefix and still lets the
    // short candidates enter after it.
    if (typeof content !== 'string') {
      throw new Error(
        'RED: expected a rendered <recalled_memory> block; today the oversize first entry breaks the loop and render returns null',
      )
    }
    expect(content).toContain('[other] short content')
    expect(content).toContain('[other] later content')
    expect(content).not.toContain('L'.repeat(4000))
    expect(await estimateTextTokens(content)).toBeLessThanOrEqual(
      MAX_RECALL_RENDER_TOKENS,
    )
  })
})
