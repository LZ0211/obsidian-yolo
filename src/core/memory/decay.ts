export const DAY_MS = 86_400_000
export const RECENCY_DECAY_LAMBDA = 0.015
export const SALIENCE_DECAY_LAMBDA = 0.05
/**
 * Cold-archive threshold. Stored salience never drops below the 0.08 decay
 * floor, so the cutoff sits just above the floor; a cold entry also needs a
 * long gap since its last recall (no reinforcement for 30 days).
 */
export const COLD_ARCHIVE_SALIENCE = 0.1
export const COLD_ARCHIVE_DAYS = 30
export const COLD_ARCHIVE_MS = COLD_ARCHIVE_DAYS * DAY_MS

export type EffectiveSalienceParams = Readonly<{
  storedSalience: number
  createdAtMs: number
  lastRecalledAtMs: number | null
  nowMs: number
  lambda: number
}>

const clamp = (value: number): number =>
  Number.isNaN(value) ? 0 : Math.min(1, Math.max(0, value))

const finiteOrZero = (value: number): number =>
  Number.isFinite(value) ? value : 0

const elapsedDays = (
  lastRecalledAtMs: number | null,
  createdAtMs: number,
  nowMs: number,
): number => {
  const reference = lastRecalledAtMs ?? createdAtMs
  const elapsed = finiteOrZero(nowMs) - finiteOrZero(reference)
  return Math.max(0, elapsed / DAY_MS)
}

export const calcEffectiveSalience = ({
  storedSalience,
  createdAtMs,
  lastRecalledAtMs,
  nowMs,
  lambda,
}: EffectiveSalienceParams): number => {
  const days = elapsedDays(lastRecalledAtMs, createdAtMs, nowMs)
  const safeLambda = Math.max(0, finiteOrZero(lambda))
  const decay = Math.exp(-safeLambda * days)
  const decayed = clamp(storedSalience) * decay
  const reinforcementFloor = 0.08 * (1 - decay)
  return clamp(decayed + reinforcementFloor)
}

export const applyReinforcement = (storedSalience: number): number => {
  const clamped = clamp(storedSalience)
  return Math.min(1, clamped + 0.18 * (1 - clamped))
}

export const calcRecencyScore = (
  lastRecalledAtMs: number | null,
  createdAtMs: number,
  nowMs: number,
): number =>
  clamp(
    Math.exp(
      -RECENCY_DECAY_LAMBDA * elapsedDays(lastRecalledAtMs, createdAtMs, nowMs),
    ),
  )
