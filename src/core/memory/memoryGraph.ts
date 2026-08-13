import { normalizeMemoryText } from './memoryTokenizer'

export const MAX_GRAPH_CANDIDATES = 64
export const MAX_GRAPH_DEGREE = 32
export const MAX_PARTITION_GRAPH_EDGES = 2048
export const MAX_GRAPH_EXPANSIONS = 5
export const MIN_GRAPH_SALIENCE = 0.3
export const MIN_GRAPH_JACCARD = 0.5

export type MemoryGraphNode = Readonly<{
  partitionKey: string
  localId: string
  keywords: readonly string[]
  salience: number
}>

export type MemoryGraphCandidate = MemoryGraphNode &
  Readonly<{
    overlap: number
  }>

export type MemoryGraphEdge = Readonly<{
  partitionKey: string
  srcLocalId: string
  dstLocalId: string
  weight: number
  createdAt: number
  updatedAt: number
}>

const clampUnit = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0

const normalizeKeywords = (keywords: readonly string[]): Set<string> => {
  const normalized = new Set<string>()
  for (const keyword of keywords) {
    const value = normalizeMemoryText(keyword)
    if (value) normalized.add(value)
  }
  return normalized
}

export const normalizedJaccard = (
  left: readonly string[],
  right: readonly string[],
): number => {
  const leftSet = normalizeKeywords(left)
  const rightSet = normalizeKeywords(right)
  if (leftSet.size === 0 && rightSet.size === 0) return 0
  let intersection = 0
  for (const keyword of leftSet) {
    if (rightSet.has(keyword)) intersection += 1
  }
  return intersection / (leftSet.size + rightSet.size - intersection)
}

export const buildGraphCandidates = (
  source: MemoryGraphNode,
  candidates: readonly MemoryGraphNode[],
  maxCandidates = MAX_GRAPH_CANDIDATES,
): MemoryGraphCandidate[] =>
  candidates
    .filter(
      (candidate) =>
        candidate.partitionKey === source.partitionKey &&
        candidate.localId !== source.localId &&
        candidate.salience >= MIN_GRAPH_SALIENCE,
    )
    .map((candidate) => ({
      ...candidate,
      overlap: normalizedJaccard(source.keywords, candidate.keywords),
    }))
    .filter((candidate) => candidate.overlap > MIN_GRAPH_JACCARD)
    .sort((left, right) => {
      if (right.overlap !== left.overlap) return right.overlap - left.overlap
      if (right.salience !== left.salience)
        return right.salience - left.salience
      return left.localId.localeCompare(right.localId)
    })
    .slice(0, Math.max(0, Math.trunc(maxCandidates)))

const edgeKey = (edge: {
  partitionKey: string
  srcLocalId: string
  dstLocalId: string
}): string =>
  `${edge.partitionKey}\u0000${edge.srcLocalId}\u0000${edge.dstLocalId}`

export const buildBidirectionalGraphEdges = (
  source: MemoryGraphNode,
  candidates: readonly MemoryGraphNode[],
  existingEdges: readonly MemoryGraphEdge[],
  nowMs: number,
): MemoryGraphEdge[] => {
  const existingByKey = new Map(
    existingEdges.map((edge) => [edgeKey(edge), edge]),
  )
  const timestamp = Math.max(0, Math.trunc(nowMs))
  const edges: MemoryGraphEdge[] = []
  for (const candidate of buildGraphCandidates(source, candidates)) {
    for (const [srcLocalId, dstLocalId] of [
      [source.localId, candidate.localId],
      [candidate.localId, source.localId],
    ] as const) {
      if (srcLocalId === dstLocalId) continue
      const key = edgeKey({
        partitionKey: source.partitionKey,
        srcLocalId,
        dstLocalId,
      })
      const existing = existingByKey.get(key)
      edges.push({
        partitionKey: source.partitionKey,
        srcLocalId,
        dstLocalId,
        weight: Math.max(existing?.weight ?? 0, candidate.overlap),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      })
    }
  }
  return edges
}


export const scoreGraphExpansion = (
  sourceScore: number,
  edgeWeight: number,
): number => clampUnit(sourceScore) * clampUnit(edgeWeight) * 0.8
