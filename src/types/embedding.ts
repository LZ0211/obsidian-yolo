export type EmbeddingModelClient = {
  id: string
  dimension: number
  getEmbedding: (text: string, options?: { signal?: AbortSignal }) => Promise<number[]>
}

export type EmbeddingDbStats = {
  model: string
  rowCount: number
  totalDataBytes: number
}
