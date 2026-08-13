import type { VectorMetaData } from '../../database/modules/vector/legacyEmbeddingTypes'

/**
 * The "shape" of a reconcile pass. Determines how the universe of paths is
 * computed before chunkifying and diffing.
 *
 * - `all`: scan the whole vault (filtered by patterns / indexPdf).
 * - `paths`: only consider these paths. Paths outside this list are left
 *   alone, even if they would otherwise be in or out of scope.
 */
export type ReconcileScope =
  | { kind: 'all' }
  | { kind: 'paths'; paths: string[] }

/**
 * A chunk that *should* exist in the index for a given file under the
 * current configuration.
 */
export type DesiredChunk = {
  path: string
  content: string
  contentHash: string
  metadata: VectorMetaData
  mtime: number
}
