import type { VectorNamespace } from './VectorStore'

export function createEmbeddingVectorNamespace(input: {
  model: string
  dimension: number
  providerId?: string
  endpoint?: string
  corpus?: string
}): VectorNamespace {
  // providerId/endpoint 不进入命名空间（见 namespaceId.ts 的说明）——
  // 嵌入命名空间只按模型+维度键控，同一模型换服务器不产生新索引表。
  const namespace: VectorNamespace = {
    provider: 'embedding',
    model: input.model,
    dimension: input.dimension,
    distanceMetric: 'cosine',
  }
  if (input.corpus != null) namespace.corpus = input.corpus
  return namespace
}
