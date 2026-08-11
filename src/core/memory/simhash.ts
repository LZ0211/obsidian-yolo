import { tokenizeMemoryText } from './memoryTokenizer'

export const FNV1A64_OFFSET_BASIS = BigInt('14695981039346656037')
export const FNV1A64_PRIME = BigInt('1099511628211')
export const UINT64_MASK = (BigInt(1) << BigInt(64)) - BigInt(1)
export const ZERO_SIMHASH = '0000000000000000'
export const SIMHASH_RE = /^[0-9a-f]{16}$/

const fnv1a64 = (value: string): bigint => {
  let hash = FNV1A64_OFFSET_BASIS
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV1A64_PRIME) & UINT64_MASK
  }
  return hash
}

const parseSimhash = (value: string): bigint => {
  if (!SIMHASH_RE.test(value)) {
    throw new RangeError(
      `Invalid SimHash: expected 16 lowercase hexadecimal digits`,
    )
  }
  return BigInt(`0x${value}`)
}

export const computeSimhash = (text: string): string => {
  const tokens = tokenizeMemoryText(text)
  if (tokens.length === 0) return ZERO_SIMHASH

  const votes = Array.from({ length: 64 }, () => 0)
  for (const token of tokens) {
    const hash = fnv1a64(token)
    for (let bit = 0; bit < 64; bit += 1) {
      const mask = BigInt(1) << BigInt(bit)
      votes[bit] = (votes[bit] ?? 0) + ((hash & mask) !== BigInt(0) ? 1 : -1)
    }
  }

  let result = BigInt(0)
  for (let bit = 0; bit < 64; bit += 1) {
    if ((votes[bit] ?? 0) > 0) {
      result |= BigInt(1) << BigInt(bit)
    }
  }
  return result.toString(16).padStart(16, '0')
}

export const hammingDistance = (left: string, right: string): number => {
  let value = parseSimhash(left) ^ parseSimhash(right)
  let distance = 0
  while (value !== BigInt(0)) {
    value &= value - BigInt(1)
    distance += 1
  }
  return distance
}

export const isNearDuplicate = (
  left: string,
  right: string,
  threshold = 3,
): boolean => {
  try {
    return hammingDistance(left, right) <= threshold
  } catch {
    return false
  }
}
