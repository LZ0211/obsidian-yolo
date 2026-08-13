import type { YoloSettings } from '../../settings/schema/setting.types'

/**
 * ragOptions keys whose change alters WHAT gets indexed (the index scope).
 * Chunking/retrieval-only keys (`minSimilarity`, `limit`, `rerankEnabled`,
 * `embeddingConcurrency`, ...) do not invalidate the stored index content
 * and are deliberately excluded: changing them must not demand a rebuild.
 */
export const RAG_INDEX_SCOPE_KEYS = [
  'chunkSize',
  'chunkOverlap',
  'indexPdf',
  'includePatterns',
  'excludePatterns',
  'excludeYoloBaseDir',
] as const

export type RagIndexScopeSnapshot = {
  chunkSize: number
  chunkOverlap: number
  indexPdf: boolean
  includePatterns: string[]
  excludePatterns: string[]
  excludeYoloBaseDir: boolean
}

/** Snapshots the current index-scope options (persisted after each successful run). */
export function captureRagIndexScope(
  ragOptions: YoloSettings['ragOptions'],
): RagIndexScopeSnapshot {
  return {
    chunkSize: ragOptions.chunkSize,
    chunkOverlap: ragOptions.chunkOverlap,
    indexPdf: ragOptions.indexPdf,
    includePatterns: [...ragOptions.includePatterns],
    excludePatterns: [...ragOptions.excludePatterns],
    excludeYoloBaseDir: ragOptions.excludeYoloBaseDir,
  }
}

/**
 * True when the current scope options differ from the options the index was
 * last built with. Pattern lists are compared by value (capture copies the
 * arrays, so reference equality would never hold). No baseline (fresh install
 * / pre-feature settings) never reports a change — there is nothing to compare
 * against, and the store's own "empty index" status already drives the
 * not-indexed state.
 */
export function ragIndexScopeChanged(
  current: RagIndexScopeSnapshot,
  lastIndexed: RagIndexScopeSnapshot | undefined,
): boolean {
  if (!lastIndexed) {
    return false
  }
  return RAG_INDEX_SCOPE_KEYS.some((key) => {
    const currentValue = current[key]
    const lastIndexedValue = lastIndexed[key]
    if (Array.isArray(currentValue) && Array.isArray(lastIndexedValue)) {
      return (
        currentValue.length !== lastIndexedValue.length ||
        currentValue.some((item, index) => item !== lastIndexedValue[index])
      )
    }
    return currentValue !== lastIndexedValue
  })
}
