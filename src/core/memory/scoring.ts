import type { MemorySector } from './memoryTypes'

export type { MemorySector } from './memoryTypes'

export type ScoreParams = Readonly<{
  matchRatio: number
  keywordOverlap: number
  effectiveSalience: number
  recencyScore: number
  querySector: MemorySector | null
  entrySector: MemorySector
}>

const SECTOR_RELATIONS: Readonly<
  Record<MemorySector, Readonly<Record<MemorySector, number>>>
> = {
  episodic: {
    episodic: 1,
    semantic: 0.6,
    procedural: 0.6,
    emotional: 0.7,
    reflective: 0.8,
  },
  semantic: {
    episodic: 0.6,
    semantic: 1,
    procedural: 0.8,
    emotional: 0.4,
    reflective: 0.7,
  },
  procedural: {
    episodic: 0.6,
    semantic: 0.8,
    procedural: 1,
    emotional: 0.3,
    reflective: 0.6,
  },
  emotional: {
    episodic: 0.7,
    semantic: 0.4,
    procedural: 0.3,
    emotional: 1,
    reflective: 0.6,
  },
  reflective: {
    episodic: 0.8,
    semantic: 0.7,
    procedural: 0.6,
    emotional: 0.6,
    reflective: 1,
  },
}

const clamp = (value: number): number =>
  Number.isNaN(value) ? 0 : Math.min(1, Math.max(0, value))

export const sectorRelation = (
  querySector: MemorySector | null,
  entrySector: MemorySector,
): number => {
  if (querySector === null) return 0.5
  return SECTOR_RELATIONS[querySector]?.[entrySector] ?? 0.5
}

export const computeCompositeScore = ({
  matchRatio,
  keywordOverlap,
  effectiveSalience,
  recencyScore,
  querySector,
  entrySector,
}: ScoreParams): number => {
  const boundedMatchRatio = clamp(matchRatio)
  const boostedSim =
    boundedMatchRatio === 0 ? 0 : 1 - Math.exp(-3 * boundedMatchRatio)
  const score =
    0.35 * boostedSim +
    0.25 * clamp(keywordOverlap) +
    0.15 * clamp(effectiveSalience) +
    0.15 * clamp(recencyScore) +
    0.1 * clamp(sectorRelation(querySector, entrySector))
  return clamp(score)
}
