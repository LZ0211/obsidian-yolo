export type VectorMetaData = {
  startLine: number
  endLine: number
  page?: number
}

export type LegacyEmbeddingRecord = {
  id: string | number
  path: string
  mtime: number
  content: string
  content_hash: string | null
  model: string
  dimension: number
  metadata: VectorMetaData
}
