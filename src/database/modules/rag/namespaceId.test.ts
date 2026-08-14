import { vectorNamespaceId } from './namespaceId'
import type { VectorNamespace } from './VectorStore'

describe('vectorNamespaceId', () => {
  const baseNamespace: VectorNamespace = {
    provider: 'openai',
    model: 'text-embedding-3-large',
    dimension: 1536,
    distanceMetric: 'cosine',
    tokenizer: 'cl100k_base',
  }

  it('keeps the legacy Vault namespace unchanged when corpus is absent', () => {
    expect(vectorNamespaceId(baseNamespace)).toBe(
      'text-embedding-3-large-d1536',
    )
  })

  it('adds a readable corpus prefix for conversation history', () => {
    expect(
      vectorNamespaceId({
        ...baseNamespace,
        corpus: 'conversation-history-v1',
      }),
    ).toBe('conversation-history-v1--text-embedding-3-large-d1536')
  })

  it('normalizes corpus labels and omits empty normalized prefixes', () => {
    expect(
      vectorNamespaceId({
        ...baseNamespace,
        corpus: ' ._Conversation HISTORY---V1_. ',
      }),
    ).toBe('conversation-history-v1--text-embedding-3-large-d1536')
    expect(
      vectorNamespaceId({
        ...baseNamespace,
        corpus: ' -._- ',
      }),
    ).toBe('text-embedding-3-large-d1536')
  })

  it('uses only the last path segment when model is configured as a path', () => {
    expect(
      vectorNamespaceId({
        ...baseNamespace,
        model: 'C:/models/bge-m3/',
        dimension: 1024,
      }),
    ).toBe('bge-m3-d1024')
  })

  it('normalizes case and unsafe path characters deterministically', () => {
    expect(
      vectorNamespaceId({
        ...baseNamespace,
        model: 'Vendor/My Embedding Model@V2',
        dimension: 768,
      }),
    ).toBe('my-embedding-model-v2-d768')
  })

  it('keeps the legacy global namespace id when embeddingEncoding is absent', () => {
    const namespaceWithoutEncoding = {
      ...baseNamespace,
      embeddingEncoding: undefined,
    }

    expect(vectorNamespaceId(namespaceWithoutEncoding)).toBe(
      'text-embedding-3-large-d1536',
    )
  })

  it('keeps the legacy global namespace id when embeddingEncoding is null', () => {
    const namespaceWithNullEncoding = {
      ...baseNamespace,
      embeddingEncoding: null,
    } as VectorNamespace & { embeddingEncoding: null }

    expect(vectorNamespaceId(namespaceWithNullEncoding)).toBe(
      'text-embedding-3-large-d1536',
    )
  })

  it('isolates provider and endpoint identities', () => {
    const openAi = vectorNamespaceId({
      ...baseNamespace,
      providerIdentity: 'provider-a',
      endpointIdentity: 'https://api.example.com/v1/',
    })
    const otherProvider = vectorNamespaceId({
      ...baseNamespace,
      providerIdentity: 'provider-b',
      endpointIdentity: 'https://api.example.com/v1/',
    })
    const otherEndpoint = vectorNamespaceId({
      ...baseNamespace,
      providerIdentity: 'provider-a',
      endpointIdentity: 'https://proxy.example.com/v1',
    })

    expect(openAi).not.toBe(otherProvider)
    expect(openAi).not.toBe(otherEndpoint)
    expect(
      vectorNamespaceId({
        ...baseNamespace,
        providerIdentity: 'provider-a',
        endpointIdentity: 'https://api.example.com/v1',
      }),
    ).toBe(openAi)
  })
})
