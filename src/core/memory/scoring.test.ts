import {
  type ScoreParams,
  computeCompositeScore,
  sectorRelation,
} from './scoring'

const baseParams: ScoreParams = {
  matchRatio: 0,
  keywordOverlap: 0,
  effectiveSalience: 0,
  recencyScore: 0,
  querySector: null,
  entrySector: 'semantic',
}

describe('memory sector scoring', () => {
  it('uses the asymmetric sector relation matrix', () => {
    expect(sectorRelation('episodic', 'reflective')).toBe(0.8)
    expect(sectorRelation('semantic', 'procedural')).toBe(0.8)
    expect(sectorRelation('emotional', 'procedural')).toBe(0.3)
    expect(sectorRelation('episodic', 'episodic')).toBe(1)
  })

  it('uses a neutral sector score when the query sector is absent', () => {
    expect(computeCompositeScore(baseParams)).toBeCloseTo(0.05, 12)
    expect(
      computeCompositeScore({
        ...baseParams,
        querySector: 'semantic',
        entrySector: 'semantic',
      }),
    ).toBeGreaterThan(computeCompositeScore(baseParams))
  })

  it('clamps inputs and keeps the weighted score in range', () => {
    expect(
      computeCompositeScore({
        ...baseParams,
        matchRatio: 2,
        keywordOverlap: 2,
        effectiveSalience: 2,
        recencyScore: 2,
        querySector: 'semantic',
        entrySector: 'semantic',
      }),
    ).toBeLessThanOrEqual(1)
    expect(
      computeCompositeScore({
        ...baseParams,
        matchRatio: -1,
        keywordOverlap: -1,
        effectiveSalience: -1,
        recencyScore: -1,
      }),
    ).toBeCloseTo(0.05, 12)
  })

  it('increases monotonically with match and keyword overlap', () => {
    const low = computeCompositeScore(baseParams)
    const moreMatch = computeCompositeScore({ ...baseParams, matchRatio: 0.4 })
    const moreKeywords = computeCompositeScore({
      ...baseParams,
      keywordOverlap: 0.4,
    })

    expect(moreMatch).toBeGreaterThan(low)
    expect(moreKeywords).toBeGreaterThan(low)
  })
})
