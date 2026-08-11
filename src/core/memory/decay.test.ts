import {
  RECENCY_DECAY_LAMBDA,
  applyReinforcement,
  calcEffectiveSalience,
  calcRecencyScore,
} from './decay'

const DAY_MS = 86_400_000

describe('memory salience decay', () => {
  it('uses the last recall timestamp and deterministic exponential decay', () => {
    const result = calcEffectiveSalience({
      storedSalience: 0.8,
      createdAtMs: 0,
      lastRecalledAtMs: DAY_MS,
      nowMs: 3 * DAY_MS,
      lambda: 0.1,
    })
    const days = 2
    const expected =
      0.8 * Math.exp(-0.1 * days) + 0.08 * (1 - Math.exp(-0.1 * days))

    expect(result).toBeCloseTo(expected, 12)
  })

  it('uses creation time for null recall and clamps negative elapsed time', () => {
    expect(
      calcEffectiveSalience({
        storedSalience: 0.4,
        createdAtMs: DAY_MS,
        lastRecalledAtMs: null,
        nowMs: 0,
        lambda: 0.2,
      }),
    ).toBeCloseTo(0.4, 12)
  })

  it('clamps stored salience and applies bounded reinforcement', () => {
    expect(
      calcEffectiveSalience({
        storedSalience: 2,
        createdAtMs: 0,
        lastRecalledAtMs: 0,
        nowMs: 0,
        lambda: 1,
      }),
    ).toBe(1)
    expect(
      calcEffectiveSalience({
        storedSalience: -1,
        createdAtMs: 0,
        lastRecalledAtMs: 0,
        nowMs: 0,
        lambda: 1,
      }),
    ).toBe(0)
    expect(applyReinforcement(0.5)).toBeCloseTo(0.59, 12)
    expect(applyReinforcement(2)).toBe(1)
    expect(applyReinforcement(-1)).toBeCloseTo(0.18, 12)
  })
})

describe('memory recency score', () => {
  it('uses the recall or creation timestamp and a documented decay constant', () => {
    expect(RECENCY_DECAY_LAMBDA).toBe(0.015)
    expect(calcRecencyScore(null, 0, 0)).toBe(1)
    expect(calcRecencyScore(0, 0, DAY_MS)).toBeCloseTo(
      Math.exp(-RECENCY_DECAY_LAMBDA),
      12,
    )
    expect(calcRecencyScore(null, DAY_MS, 0)).toBe(1)
  })
})
