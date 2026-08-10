import type { VectorNamespace } from './VectorStore'

export function createEmbeddingVectorNamespace(input: {
  model: string
  dimension: number
  corpus?: string
}): VectorNamespace {
  const namespace: VectorNamespace = {
    provider: 'embedding',
    model: input.model,
    dimension: input.dimension,
    distanceMetric: 'cosine',
  }
  if (input.corpus != null) namespace.corpus = input.corpus
  return namespace
}
