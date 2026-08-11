import {
  type MemoryGraphEdge,
  type MemoryGraphNode,
  buildBidirectionalGraphEdges,
  buildGraphCandidates,
  normalizedJaccard,
  pruneMemoryGraphEdges,
  scoreGraphExpansion,
} from './memoryGraph'

const node = (
  localId: string,
  keywords: string[],
  overrides: Partial<MemoryGraphNode> = {},
): MemoryGraphNode => ({
  partitionKey: 'global',
  localId,
  keywords,
  salience: 0.8,
  ...overrides,
})

describe('memory graph primitives', () => {
  it('normalizes keyword sets before calculating Jaccard overlap', () => {
    expect(
      normalizedJaccard([' Tea ', 'tea', 'Coffee'], ['coffee', 'tea']),
    ).toBe(1)
    expect(normalizedJaccard(['tea'], ['coffee'])).toBe(0)
  })

  it('caps keyword candidates at 64 and excludes self, low salience, and other scopes', () => {
    const source = node('source', ['shared', 'tea'])
    const candidates = [
      source,
      node('low', ['shared', 'tea'], { salience: 0.29 }),
      node('assistant', ['shared', 'tea'], {
        partitionKey: 'assistant:other',
      }),
      ...Array.from({ length: 70 }, (_, index) =>
        node(`candidate-${index}`, ['shared', 'tea']),
      ),
    ]

    expect(buildGraphCandidates(source, candidates)).toHaveLength(64)
    expect(buildGraphCandidates(source, candidates)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localId: 'source' }),
        expect.objectContaining({ localId: 'low' }),
        expect.objectContaining({ localId: 'assistant' }),
      ]),
    )
  })

  it('requires strict Jaccard overlap above 0.5 and emits fresh double edges', () => {
    const source = node('source', ['a', 'b', 'c'])
    const candidates = [
      node('match', ['a', 'b', 'c']),
      node('boundary', ['a', 'b', 'd', 'e']),
    ]
    const edges = buildBidirectionalGraphEdges(source, candidates, [], 100)

    expect(edges).toEqual([
      expect.objectContaining({
        srcLocalId: 'source',
        dstLocalId: 'match',
        weight: 1,
      }),
      expect.objectContaining({
        srcLocalId: 'match',
        dstLocalId: 'source',
        weight: 1,
      }),
    ])
    expect(edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ srcLocalId: 'source', dstLocalId: 'source' }),
      ]),
    )
  })

  it('keeps the stronger existing weight for a matching edge', () => {
    const source = node('source', ['a', 'b'])
    const candidate = node('target', ['a', 'b', 'c'])
    const existing: MemoryGraphEdge[] = [
      {
        partitionKey: 'global',
        srcLocalId: 'source',
        dstLocalId: 'target',
        weight: 0.9,
        createdAt: 1,
        updatedAt: 2,
      },
    ]

    expect(
      buildBidirectionalGraphEdges(source, [candidate], existing, 100),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          srcLocalId: 'source',
          dstLocalId: 'target',
          weight: 0.9,
        }),
        expect.objectContaining({
          srcLocalId: 'target',
          dstLocalId: 'source',
          weight: 2 / 3,
        }),
      ]),
    )
  })

  it('enforces per-node degree and partition edge caps by evicting weakest oldest edges', () => {
    const edges: MemoryGraphEdge[] = Array.from({ length: 40 }, (_, index) => [
      {
        partitionKey: 'global',
        srcLocalId: 'source',
        dstLocalId: `target-${index}`,
        weight: index < 2 ? 0.9 : 0.2,
        createdAt: index,
        updatedAt: index,
      },
      {
        partitionKey: 'global',
        srcLocalId: `target-${index}`,
        dstLocalId: 'source',
        weight: index < 2 ? 0.9 : 0.2,
        createdAt: index,
        updatedAt: index,
      },
    ]).flat()
    const pruned = pruneMemoryGraphEdges(edges, {
      maxDegree: 2,
      maxPartitionEdges: 4,
    })

    expect(pruned).toHaveLength(4)
    expect(pruned).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dstLocalId: 'target-0' }),
        expect.objectContaining({ dstLocalId: 'target-1' }),
      ]),
    )
  })

  it('scores one-hop expansion with the bounded 0.8 multiplier', () => {
    expect(scoreGraphExpansion(0.75, 0.6)).toBeCloseTo(0.36)
    expect(scoreGraphExpansion(2, 2)).toBeLessThanOrEqual(1)
  })
})
