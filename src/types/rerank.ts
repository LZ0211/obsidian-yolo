export type RerankResult = {
  index: number
  relevanceScore: number
}

export type RerankResponse =
  | {
      kind: 'scores'
      results: readonly RerankResult[]
    }
  | {
      kind: 'ordering'
      indices: readonly number[]
    }

export type RerankRequestOptions = {
  topN: number
  signal?: AbortSignal
}

export type RerankModelClient = {
  id: string
  providerId: string
  maxDocuments?: number
  maxInputChars?: number
  ready?: boolean
  isReady?: boolean
  status?: 'ready' | 'not_ready' | 'building' | 'failed'
  rerank: (
    query: string,
    documents: string[],
    options: RerankRequestOptions,
  ) => Promise<RerankResponse>
}

export type RerankDiagnostics = {
  attempted: boolean
  applied: boolean
  reason:
    | 'applied'
    | 'disabled'
    | 'missing_model'
    | 'not_ready'
    | 'insufficient_candidates'
    | 'capacity_mismatch'
    | 'timeout'
    | 'provider_error'
    | 'malformed_response'
    | 'partial_response'
    | 'cooldown_open'
  modelId?: string
  universeSize: number
  poolSize: number
  overflowSize: number
  durationMs: number
  healthState: 'closed' | 'open' | 'half_open'
  previewMissingCount?: number
  ineligibleGraphEvidenceCount?: number
}
