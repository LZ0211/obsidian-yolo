import type { EmbeddingModelClient } from '../../../types/embedding'
import type { VectorHit } from '../rag/VectorStore'

import { adaptVectorHitsToLegacySimilarityRows } from './vectorHitAdapter'

describe('adaptVectorHitsToLegacySimilarityRows', () => {
  const embeddingModel: EmbeddingModelClient = {
    id: 'test-model',
    dimension: 1536,
    getEmbedding: jest.fn(),
  }

  const coerceLegacyEmbeddingId = jest.fn((value: string, _index: number) =>
    Number(value.replace('chunk-', '')),
  )
  const numberFromMetadata = jest.fn((value: unknown) =>
    typeof value === 'number' ? value : undefined,
  )

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('maps hits using location values before metadata fallbacks', () => {
    const hits: VectorHit[] = [
      {
        id: 'chunk-1',
        chunkId: 'chunk-1',
        path: 'notes/a.md',
        excerpt: 'matched text',
        score: 0.91,
        source: 'vector',
        location: {
          lineStart: 4,
          lineEnd: 6,
          page: 2,
        },
        metadataJson: {
          startLine: 40,
          endLine: 60,
          page: 20,
          contentHash: 'hash-1',
        },
      },
    ]

    expect(
      adaptVectorHitsToLegacySimilarityRows(
        hits,
        embeddingModel,
        coerceLegacyEmbeddingId,
        numberFromMetadata,
      ),
    ).toEqual([
      {
        id: 1,
        path: 'notes/a.md',
        mtime: 0,
        content: 'matched text',
        content_hash: 'hash-1',
        model: 'test-model',
        dimension: 1536,
        metadata: {
          startLine: 4,
          endLine: 6,
          page: 2,
        },
        similarity: 0.91,
      },
    ])

    expect(coerceLegacyEmbeddingId).toHaveBeenCalledWith('chunk-1', 0)
    expect(numberFromMetadata).not.toHaveBeenCalledWith(40)
    expect(numberFromMetadata).not.toHaveBeenCalledWith(60)
    expect(numberFromMetadata).not.toHaveBeenCalledWith(20)
  })

  it('falls back to numeric metadata when location values are absent', () => {
    const hits: VectorHit[] = [
      {
        id: 'chunk-2',
        chunkId: 'chunk-2',
        path: 'notes/b.md',
        excerpt: 'fallback text',
        score: 0.5,
        source: 'vector',
        location: {},
        metadataJson: {
          startLine: 8,
          endLine: 11,
          page: 3,
        },
      },
    ]

    expect(
      adaptVectorHitsToLegacySimilarityRows(
        hits,
        embeddingModel,
        coerceLegacyEmbeddingId,
        numberFromMetadata,
      ),
    ).toEqual([
      {
        id: 2,
        path: 'notes/b.md',
        mtime: 0,
        content: 'fallback text',
        content_hash: null,
        model: 'test-model',
        dimension: 1536,
        metadata: {
          startLine: 8,
          endLine: 11,
          page: 3,
        },
        similarity: 0.5,
      },
    ])
  })

  it('ignores nonnumeric metadata and defaults missing line values to 0', () => {
    const hits: VectorHit[] = [
      {
        id: 'chunk-3',
        chunkId: 'chunk-3',
        path: 'notes/c.md',
        excerpt: 'bad metadata',
        score: 0.25,
        source: 'vector',
        location: {},
        metadataJson: {
          startLine: '4',
          endLine: null,
          page: '9',
          contentHash: 123,
        },
      },
    ]

    expect(
      adaptVectorHitsToLegacySimilarityRows(
        hits,
        embeddingModel,
        coerceLegacyEmbeddingId,
        numberFromMetadata,
      ),
    ).toEqual([
      {
        id: 3,
        path: 'notes/c.md',
        mtime: 0,
        content: 'bad metadata',
        content_hash: null,
        model: 'test-model',
        dimension: 1536,
        metadata: {
          startLine: 0,
          endLine: 0,
          page: undefined,
        },
        similarity: 0.25,
      },
    ])
  })
})
