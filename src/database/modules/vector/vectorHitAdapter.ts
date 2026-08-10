import type { EmbeddingModelClient } from '../../../types/embedding'
import type { VectorHit } from '../rag/VectorStore'

import type { LegacyEmbeddingRecord } from './legacyEmbeddingTypes'

export type LegacySimilarityRow = LegacyEmbeddingRecord & {
  similarity: number
}

export function adaptVectorHitsToLegacySimilarityRows(
  hits: VectorHit[],
  embeddingModel: EmbeddingModelClient,
  coerceLegacyEmbeddingId: (
    id: string,
    fallbackIndex: number,
  ) => LegacyEmbeddingRecord['id'],
  numberFromMetadata: (value: unknown) => number | undefined,
): LegacySimilarityRow[] {
  return hits.map((hit, index) => ({
    id: coerceLegacyEmbeddingId(hit.id, index),
    path: hit.path,
    mtime: 0,
    content: hit.excerpt,
    content_hash:
      typeof hit.metadataJson.contentHash === 'string'
        ? hit.metadataJson.contentHash
        : null,
    model: embeddingModel.id,
    dimension: embeddingModel.dimension,
    metadata: {
      startLine:
        hit.location.lineStart ??
        numberFromMetadata(hit.metadataJson.startLine) ??
        0,
      endLine:
        hit.location.lineEnd ??
        numberFromMetadata(hit.metadataJson.endLine) ??
        0,
      page: hit.location.page ?? numberFromMetadata(hit.metadataJson.page),
    },
    similarity: hit.score,
  }))
}
