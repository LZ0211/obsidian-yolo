import { fuseMemoryRecallRanks } from './memoryRecallFusion'

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
