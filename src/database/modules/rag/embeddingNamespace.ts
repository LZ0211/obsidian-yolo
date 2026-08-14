import type { VectorNamespace } from './VectorStore'

export function createEmbeddingVectorNamespace(input: {
  model: string
  dimension: number
  providerId?: string
  endpoint?: string
  corpus?: string
}): VectorNamespace {
  const namespace: VectorNamespace = {
    provider: 'embedding',
    model: input.model,
    dimension: input.dimension,
    distanceMetric: 'cosine',
  }
  if (input.providerId?.trim()) {
    namespace.providerIdentity = input.providerId.trim()
  }
  if (input.endpoint?.trim()) {
    namespace.endpointIdentity = input.endpoint.trim()
  }
  if (input.corpus != null) namespace.corpus = input.corpus
  return namespace
}
