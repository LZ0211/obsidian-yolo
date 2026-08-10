import { vectorNamespaceId } from './namespaceId'
import type { VectorNamespace } from './VectorStore'

describe('namespaceId workspace encoding isolation', () => {
  const baseNamespace: VectorNamespace = {
    provider: 'openai',
    model: 'text-embedding-3-large',
    dimension: 1536,
    distanceMetric: 'cosine',
    tokenizer: 'cl100k_base',
  }

  it('suffixes the base namespace id with the first 12 hex chars of the encoding sha256', () => {
    expect(
      vectorNamespaceId({
        ...baseNamespace,
        embeddingEncoding: 'float32',
      }),
    ).toBe('text-embedding-3-large-d1536-6a937d727b77')
  })

  it('produces distinct ids for distinct workspace embedding encodings', () => {
    const float32Id = vectorNamespaceId({
      ...baseNamespace,
      embeddingEncoding: 'float32',
    })
    const int8Id = vectorNamespaceId({
      ...baseNamespace,
      embeddingEncoding: 'int8',
    })

    expect(float32Id).toBe('text-embedding-3-large-d1536-6a937d727b77')
    expect(int8Id).toBe('text-embedding-3-large-d1536-cb1525bced78')
    expect(float32Id).not.toBe(int8Id)
  })
})
