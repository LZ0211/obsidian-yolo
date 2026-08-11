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

type GraphRelation = {
  key: string
  left: string
  right: string
  edges: MemoryGraphEdge[]
  weight: number
  createdAt: number
  updatedAt: number
}

const relationKey = (edge: MemoryGraphEdge): string => {
  const [left, right] = [edge.srcLocalId, edge.dstLocalId].sort()
  return `${edge.partitionKey}\u0000${left}\u0000${right}`
}

export const pruneMemoryGraphEdges = (
  edges: readonly MemoryGraphEdge[],
  options: {
    maxDegree?: number
    maxPartitionEdges?: number
  } = {},
): MemoryGraphEdge[] => {
  const maxDegree = Math.max(
    0,
    Math.trunc(options.maxDegree ?? MAX_GRAPH_DEGREE),
  )
  const maxPartitionEdges = Math.max(
    0,
    Math.trunc(options.maxPartitionEdges ?? MAX_PARTITION_GRAPH_EDGES),
  )
  const uniqueEdges = new Map<string, MemoryGraphEdge>()
  for (const edge of edges) {
    if (edge.srcLocalId === edge.dstLocalId) continue
    const key = edgeKey(edge)
    const previous = uniqueEdges.get(key)
    if (
      !previous ||
      edge.weight > previous.weight ||
      (edge.weight === previous.weight && edge.updatedAt > previous.updatedAt)
    ) {
      uniqueEdges.set(key, edge)
    }
  }

  const partitions = new Map<string, Map<string, GraphRelation>>()
  for (const edge of uniqueEdges.values()) {
    const relations = partitions.get(edge.partitionKey) ?? new Map()
    partitions.set(edge.partitionKey, relations)
    const key = relationKey(edge)
    const existing = relations.get(key)
    const [left, right] = [edge.srcLocalId, edge.dstLocalId].sort()
    if (!existing) {
      relations.set(key, {
        key,
        left: left,
        right: right,
        edges: [edge],
        weight: edge.weight,
        createdAt: edge.createdAt,
        updatedAt: edge.updatedAt,
      })
      continue
    }
    existing.edges.push(edge)
    existing.weight = Math.min(existing.weight, edge.weight)
    existing.createdAt = Math.min(existing.createdAt, edge.createdAt)
    existing.updatedAt = Math.min(existing.updatedAt, edge.updatedAt)
  }

  const selected: MemoryGraphEdge[] = []
  for (const relations of partitions.values()) {
    const degree = new Map<string, number>()
    let edgeCount = 0
    const ranked = [...relations.values()].sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight
      if (right.updatedAt !== left.updatedAt)
        return right.updatedAt - left.updatedAt
      if (right.createdAt !== left.createdAt)
        return right.createdAt - left.createdAt
      return left.key.localeCompare(right.key)
    })
    for (const relation of ranked) {
      if ((degree.get(relation.left) ?? 0) >= maxDegree) continue
      if ((degree.get(relation.right) ?? 0) >= maxDegree) continue
      if (edgeCount + relation.edges.length > maxPartitionEdges) continue
      selected.push(...relation.edges)
      edgeCount += relation.edges.length
      degree.set(relation.left, (degree.get(relation.left) ?? 0) + 1)
      degree.set(relation.right, (degree.get(relation.right) ?? 0) + 1)
    }
  }
  return selected
}

export const scoreGraphExpansion = (
  sourceScore: number,
  edgeWeight: number,
): number => clampUnit(sourceScore) * clampUnit(edgeWeight) * 0.8
