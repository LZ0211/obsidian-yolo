import { backOff } from 'exponential-backoff'
import { App } from 'obsidian'

import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import { createEmbeddingVectorNamespace } from '../../database/modules/rag/embeddingNamespace'
import { vectorNamespaceId } from '../../database/modules/rag/namespaceId'
import { queryEmbeddingCacheKey } from '../../database/modules/rag/queryEmbeddingCache'
import {
  type VectorNamespace,
  VectorStoreError,
} from '../../database/modules/rag/VectorStore'
import {
  type ReconcileOptions,
  ReconcileResult,
  SimilaritySearchResult,
  VectorManager,
} from '../../database/modules/vector/VectorManager'
import { YoloSettings } from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'
import type { RerankModelClient } from '../../types/rerank'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMRateLimitExceededException,
} from '../llm/exception'

import { getEmbeddingModelClient } from './embedding'
import { QueryEmbeddingMemoryCache } from './queryEmbeddingMemoryCache'
import { isAbortLikeError, isTransientRagIndexError } from './ragIndexErrors'
import type { ReconcileScope } from './reconciler'
import { applyLegacyRerankResponse, getRerankModelClient } from './rerank'
import {
  RetrievalTrace,
  RetrievalTraceDiagnostic,
  RetrievalTraceErrorCode,
} from './retrievalTraceTypes'

type RetrievalTraceStoreLike = {
  insertTrace(trace: RetrievalTrace): Promise<void>
  flushPendingWrites?(): Promise<void>
}

export const dedupeRagQueryResults = (
  rows: SimilaritySearchResult[],
): SimilaritySearchResult[] => {
  const deduped = new Map<string, SimilaritySearchResult>()

  for (const row of rows) {
    // content_hash is part of the identity: sub-chunks of oversized code
    // blocks and tables share one line range (the splitter's subSplit*
    // deliberately keeps the full block range), so keying on the range alone
    // would collapse them to the single highest-similarity slice and silently
    // drop content.
    const key = `${row.path}:${row.metadata.page ?? ''}:${row.metadata.startLine}:${row.metadata.endLine}:${row.content_hash ?? ''}`
    const existing = deduped.get(key)
    if (!existing || row.similarity > existing.similarity) {
      deduped.set(key, row)
    }
  }

  return [...deduped.values()]
}

// TODO: do we really need this class? It seems like unnecessary abstraction.
export class RAGEngine {
  private app: App
  private settings: YoloSettings
  private vectorManager: VectorManager | null = null
  private embeddingModel: EmbeddingModelClient | null = null
  private rerankModel: RerankModelClient | null = null
  private indexUpdateQueue: Promise<void> = Promise.resolve()
  private readonly traceStore: RetrievalTraceStoreLike | null
  private pendingTraceWrites = new Set<Promise<void>>()
  private readonly queryEmbeddingCache = new QueryEmbeddingMemoryCache()
  private readonly pendingQueryEmbeddings = new Map<
    string,
    Promise<{ embedding: number[]; diagnostic: RetrievalTraceDiagnostic }>
  >()
  private readonly t: (key: string, fallback?: string) => string

  constructor(
    app: App,
    settings: YoloSettings,
    vectorManager: VectorManager,
    t: (key: string, fallback?: string) => string,
    traceStore?: RetrievalTraceStoreLike | null,
  ) {
    this.app = app
    this.settings = settings
    this.vectorManager = vectorManager
    this.t = t
    this.traceStore = traceStore ?? null
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
    this.rerankModel = getRerankModelClient({
      settings,
      rerankModelId: settings.rerankModelId,
    })
  }

  cleanup() {
    this.embeddingModel = null
    this.vectorManager = null
  }

  // TODO: use addSettingsChangeListener
  setSettings(settings: YoloSettings) {
    this.settings = settings
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
    this.rerankModel = getRerankModelClient({
      settings,
      rerankModelId: settings.rerankModelId,
    })
    this.vectorManager?.setSettings(settings)
  }

  /**
   * Reconcile the vault index against the current settings. The single
   * write entrypoint for indexing — see {@link VectorManager.reconcile}.
   *
   * - `truncate: true, scope: { kind: 'all' }` → "rebuild from scratch"
   * - `truncate: false, scope: { kind: 'all' }` → "sync after settings change"
   * - `truncate: false, scope: { kind: 'paths', paths }` → "sync changed files"
   */
  async updateVaultIndex(
    options: Pick<
      ReconcileOptions,
      'truncate' | 'signal' | 'onPdfTextExtracted'
    > & {
      scope: ReconcileScope
    },
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void,
  ): Promise<ReconcileResult> {
    const run = async (): Promise<ReconcileResult> => {
      if (!this.embeddingModel) {
        throw new Error('Embedding model is not set')
      }
      if (!this.vectorManager) {
        throw new Error('Vector manager is not set')
      }
      return await this.vectorManager.reconcile(
        this.embeddingModel,
        {
          chunkSize: this.settings.ragOptions.chunkSize,
          chunkOverlap: this.settings.ragOptions.chunkOverlap ?? 50,
          excludePatterns: this.settings.ragOptions.excludePatterns,
          excludeYoloBaseDir:
            this.settings.ragOptions.excludeYoloBaseDir ?? true,
          includePatterns: this.settings.ragOptions.includePatterns,
          indexPdf: this.settings.ragOptions.indexPdf ?? true,
          embeddingConcurrency: this.settings.ragOptions.embeddingConcurrency,
          settings: this.settings,
        },
        {
          scope: options.scope,
          truncate: options.truncate,
          signal: options.signal,
          onPdfTextExtracted: options.onPdfTextExtracted,
          onProgress: (indexProgress) => {
            onQueryProgressChange?.({
              type: 'indexing',
              indexProgress,
            })
          },
        },
      )
    }

    const queuedRun = this.indexUpdateQueue.catch(() => undefined).then(run)
    this.indexUpdateQueue = queuedRun.then(
      () => undefined,
      () => undefined,
    )
    return await queuedRun
  }

  async processQuery({
    query,
    scope,
    minSimilarity: minSimilarityOverride,
    limit: limitOverride,
    onQueryProgressChange,
    rerankPolicy = 'legacy-vector',
    signal,
  }: {
    query: string
    scope?: {
      files: string[]
      folders: string[]
    }
    /** Override settings.ragOptions.minSimilarity when set */
    minSimilarity?: number
    /** Override settings.ragOptions.limit when set */
    limit?: number
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
    rerankPolicy?: 'legacy-vector' | 'none'
    signal?: AbortSignal
  }): Promise<SimilaritySearchResult[]> {
    this.throwIfAborted(signal)
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    const embeddingModel = this.embeddingModel
    const startedAt = Date.now()
    const timingsMs: RetrievalTrace['timingsMs'] = {
      normalizeInput: 0,
      resolveScope: 0,
      embedQuery: 0,
      searchBackend: 0,
      assembleEvidence: 0,
      total: 0,
    }
    const normalizedQueryStart = Date.now()
    const normalizedQuery = query
    timingsMs.normalizeInput = Date.now() - normalizedQueryStart

    const resolveScopeStart = Date.now()
    const resolvedScope = scope
      ? {
          files: [...scope.files],
          folders: [...scope.folders],
        }
      : undefined
    timingsMs.resolveScope = Date.now() - resolveScopeStart

    let evidence: RetrievalTrace['evidence'] = []
    const warningCodes: RetrievalTrace['warningCodes'] = []
    let queryDiagnostic: RetrievalTraceDiagnostic | undefined

    // Index updates are handled by RagAutoUpdateService (vault events), manual
    // re-index commands, and settings UI — not on every query — to keep search fast.
    try {
      onQueryProgressChange?.({
        type: 'querying',
      })
      const embedQueryStart = Date.now()
      const embeddingResult = await this.getQueryEmbedding(
        normalizedQuery,
        signal,
      )
      this.throwIfAborted(signal)
      const queryEmbedding = embeddingResult.embedding
      queryDiagnostic = embeddingResult.diagnostic
      timingsMs.embedQuery = Date.now() - embedQueryStart
      const searchBackendStart = Date.now()
      const vectorResult = (await this.vectorManager?.performSimilaritySearch(
        queryEmbedding,
        embeddingModel,
        {
          minSimilarity:
            minSimilarityOverride ?? this.settings.ragOptions.minSimilarity,
          limit: limitOverride ?? this.settings.ragOptions.limit,
          scope: resolvedScope,
          signal,
        },
      )) ?? { rows: [] }
      this.throwIfAborted(signal)
      const queryResult = Array.isArray(vectorResult)
        ? vectorResult
        : vectorResult.rows
      if (!Array.isArray(vectorResult) && vectorResult.trace) {
        if (typeof vectorResult.trace.coarseSearchMs === 'number') {
          timingsMs.coarseSearch = vectorResult.trace.coarseSearchMs
        }
        if (typeof vectorResult.trace.loadFullVectorsMs === 'number') {
          timingsMs.loadFullVectors = vectorResult.trace.loadFullVectorsMs
        }
        if (typeof vectorResult.trace.rerankSimilarityMs === 'number') {
          timingsMs.rerankSimilarity = vectorResult.trace.rerankSimilarityMs
        }
      }
      timingsMs.searchBackend = Date.now() - searchBackendStart

      let rerankedQueryResult = queryResult
      if (
        rerankPolicy === 'legacy-vector' &&
        this.settings.ragOptions.rerankEnabled !== false &&
        this.rerankModel &&
        rerankedQueryResult.length > 1
      ) {
        const rerankStart = Date.now()
        try {
          const documents = rerankedQueryResult.map((row) => row.content)
          const rerankResponse = await this.rerankModel.rerank(
            normalizedQuery,
            documents,
            { topN: rerankedQueryResult.length, signal },
          )
          this.throwIfAborted(signal)
          rerankedQueryResult = applyLegacyRerankResponse(
            rerankedQueryResult,
            rerankResponse,
          )
          if (queryDiagnostic) {
            queryDiagnostic.rerankModelId = this.rerankModel.id
            queryDiagnostic.rerankApplied = true
          }
        } catch (error) {
          if (isAbortLikeError(error) || signal?.aborted) throw error
          console.warn(
            '[YOLO] Rerank failed, continuing with original order:',
            error,
          )
          if (queryDiagnostic) {
            queryDiagnostic.rerankModelId = this.rerankModel?.id
            queryDiagnostic.rerankApplied = false
            queryDiagnostic.rerankError =
              error instanceof Error ? error.message : String(error)
          }
        }
        timingsMs.rerank = Date.now() - rerankStart
      }
      this.throwIfAborted(signal)

      const assembleEvidenceStart = Date.now()
      const dedupedQueryResult = dedupeRagQueryResults(rerankedQueryResult)
      evidence = dedupedQueryResult.map((row) => ({
        id: String(row.id),
        path: row.path,
        score: row.similarity,
      }))
      if (dedupedQueryResult.length === 0) {
        warningCodes.push('empty_result')
      }
      timingsMs.assembleEvidence = Date.now() - assembleEvidenceStart
      timingsMs.total = Date.now() - startedAt

      onQueryProgressChange?.({
        type: 'querying-done',
        queryResult: dedupedQueryResult,
      })

      this.enqueueTraceWrite({
        queryText: query,
        startedAt,
        finishedAt: Date.now(),
        timingsMs,
        evidence,
        warningCodes,
        diagnostic: queryDiagnostic,
      })

      return dedupedQueryResult
    } catch (error) {
      timingsMs.total = Date.now() - startedAt
      queryDiagnostic = this.mergeTraceDiagnostics(
        queryDiagnostic,
        this.getEmbeddingDiagnostic(error),
      )
      this.enqueueTraceWrite({
        queryText: query,
        startedAt,
        finishedAt: Date.now(),
        timingsMs,
        evidence,
        warningCodes,
        errorCode: this.getTraceErrorCode(error),
        diagnostic: this.mergeTraceDiagnostics(
          queryDiagnostic,
          this.getTraceDiagnostic(error),
        ),
      })
      // A failed/aborted query must land on a terminal progress state —
      // without this the chat UI stays stuck on "Querying the vault...".
      onQueryProgressChange?.({
        type: 'querying-error',
        message:
          error instanceof Error ? error.message : 'Query failed unexpectedly',
      })
      throw error
    }
  }

  async flushPendingTraceWritesForTest(): Promise<void> {
    await Promise.allSettled([...this.pendingTraceWrites])
    await this.traceStore?.flushPendingWrites?.()
  }

  private async getQueryEmbedding(
    query: string,
    signal?: AbortSignal,
  ): Promise<{
    embedding: number[]
    diagnostic: RetrievalTraceDiagnostic
  }> {
    const modelId = this.embeddingModel?.id ?? ''
    const key = `${modelId}\u0000${query}`
    const pending = this.pendingQueryEmbeddings.get(key)
    if (pending) return await this.awaitWithAbort(pending, signal)
    const request = this.getQueryEmbeddingUncached(query, signal).finally(
      () => {
        this.pendingQueryEmbeddings.delete(key)
      },
    )
    this.pendingQueryEmbeddings.set(key, request)
    return await this.awaitWithAbort(request, signal)
  }

  private async getQueryEmbeddingUncached(
    query: string,
    signal?: AbortSignal,
  ): Promise<{
    embedding: number[]
    diagnostic: RetrievalTraceDiagnostic
  }> {
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    const embeddingModel = this.embeddingModel
    const cacheKey = `${embeddingModel.id}\u0000${query}`
    const cachedEmbedding = this.queryEmbeddingCache.get(cacheKey)
    if (cachedEmbedding) {
      return {
        embedding: cachedEmbedding,
        diagnostic: {
          providerId: 'cache',
          modelId: embeddingModel.id,
          requestedDimension: embeddingModel.dimension,
          returnedDimension: cachedEmbedding.length,
          embeddingAttemptCount: 0,
          embeddingRetryCount: 0,
          embeddingRecoveredAfterRetry: false,
          embeddingAttemptDurationsMs: [],
        },
      }
    }
    this.throwIfAborted(signal)
    const persistentEmbedding = await this.vectorManager?.getQueryEmbedding?.(
      this.getVectorNamespace(embeddingModel),
      queryEmbeddingCacheKey(embeddingModel.id, query),
    )
    this.throwIfAborted(signal)
    if (persistentEmbedding) {
      this.queryEmbeddingCache.set(cacheKey, persistentEmbedding)
      return {
        embedding: persistentEmbedding,
        diagnostic: {
          providerId: 'cache',
          modelId: embeddingModel.id,
          requestedDimension: embeddingModel.dimension,
          returnedDimension: persistentEmbedding.length,
          embeddingAttemptCount: 0,
          embeddingRetryCount: 0,
          embeddingRecoveredAfterRetry: false,
          embeddingAttemptDurationsMs: [],
        },
      }
    }
    const configuredModel = this.settings.embeddingModels?.find(
      (model) => model.id === embeddingModel.id,
    )
    const attemptDurationsMs: number[] = []
    let attemptCount = 0
    try {
      const embedding = await backOff(
        async () => {
          const activeModel = this.embeddingModel
          if (!activeModel) {
            throw new Error('Embedding model is not set')
          }
          attemptCount += 1
          const attemptStartedAt = Date.now()
          try {
            return await activeModel.getEmbedding(query, { signal })
          } finally {
            attemptDurationsMs.push(Date.now() - attemptStartedAt)
          }
        },
        {
          numOfAttempts: 3,
          startingDelay: 250,
          timeMultiple: 2,
          maxDelay: 1500,
          retry: (error) =>
            !isAbortLikeError(error) && isTransientRagIndexError(error),
        },
      )
      this.throwIfAborted(signal)
      this.queryEmbeddingCache.set(cacheKey, embedding)
      await this.vectorManager?.putQueryEmbedding?.(
        this.getVectorNamespace(embeddingModel),
        queryEmbeddingCacheKey(embeddingModel.id, query),
        embedding,
      )
      return {
        embedding,
        diagnostic: {
          providerId: configuredModel?.providerId ?? 'embedding',
          modelId: embeddingModel.id,
          requestedDimension: embeddingModel.dimension,
          returnedDimension: embedding.length,
          embeddingAttemptCount: attemptCount,
          embeddingRetryCount: Math.max(0, attemptCount - 1),
          embeddingRecoveredAfterRetry: attemptCount > 1,
          embeddingAttemptDurationsMs: attemptDurationsMs,
        },
      }
    } catch (error) {
      throw this.attachEmbeddingDiagnostic(this.normalizeRagQueryError(error), {
        providerId: configuredModel?.providerId ?? 'embedding',
        modelId: embeddingModel.id,
        requestedDimension: embeddingModel.dimension,
        embeddingAttemptCount: attemptCount,
        embeddingRetryCount: Math.max(0, attemptCount - 1),
        embeddingRecoveredAfterRetry: false,
        embeddingAttemptDurationsMs: attemptDurationsMs,
      })
    }
  }

  private normalizeRagQueryError(error: unknown): Error {
    if (
      error instanceof LLMAPIKeyNotSetException ||
      error instanceof LLMAPIKeyInvalidException ||
      error instanceof LLMBaseUrlNotSetException
    ) {
      return this.attachTraceCause(
        new Error(
          this.t(
            'settings.rag.queryEmbeddingConfigError',
            'Embedding provider is not configured. Check the embedding model API key or base URL settings.',
          ),
        ),
        error,
      )
    }
    if (error instanceof LLMRateLimitExceededException) {
      return this.attachTraceCause(
        new Error(
          this.t(
            'settings.rag.queryEmbeddingRateLimitError',
            'Embedding provider is rate limited. Please retry in a moment.',
          ),
        ),
        error,
      )
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  private enqueueTraceWrite(
    trace: Omit<
      RetrievalTrace,
      'queryId' | 'backend' | 'modelId' | 'namespaceId'
    > & {
      errorCode?: RetrievalTraceErrorCode
      diagnostic?: RetrievalTraceDiagnostic
    },
  ): void {
    if (!this.shouldWriteTrace() || !this.embeddingModel || !this.traceStore) {
      return
    }

    const pendingWrite = this.traceStore
      .insertTrace({
        queryId: this.createQueryId(trace.startedAt),
        backend: 'sqlite',
        modelId: this.embeddingModel.id,
        namespaceId: this.buildNamespaceId(this.embeddingModel),
        ...trace,
      })
      .catch((error) => {
        console.warn('[YOLO] Failed to persist retrieval trace', error)
      })
      .finally(() => {
        this.pendingTraceWrites.delete(pendingWrite)
      })

    this.pendingTraceWrites.add(pendingWrite)
  }

  private shouldWriteTrace(): boolean {
    return this.settings.ragOptions.diagnosticsEnabled !== false
  }

  private createQueryId(startedAt: number): string {
    return `rq-${startedAt}-${Math.random().toString(36).slice(2, 10)}`
  }

  private buildNamespaceId(embeddingModel: EmbeddingModelClient): string {
    return vectorNamespaceId(this.getVectorNamespace(embeddingModel))
  }

  private getVectorNamespace(
    embeddingModel: EmbeddingModelClient,
  ): VectorNamespace {
    const configuredModel = this.settings.embeddingModels?.find(
      (model) => model.id === embeddingModel.id,
    )
    return createEmbeddingVectorNamespace({
      model: configuredModel?.model ?? embeddingModel.id,
      dimension: embeddingModel.dimension,
    })
  }

  private getTraceErrorCode(
    error: unknown,
  ): RetrievalTraceErrorCode | undefined {
    const source = this.unwrapErrorCause(error)

    if (source instanceof VectorStoreError) {
      return source.code
    }
    if (
      source instanceof LLMAPIKeyNotSetException ||
      source instanceof LLMAPIKeyInvalidException
    ) {
      return 'configuration_missing_key'
    }
    if (source instanceof LLMBaseUrlNotSetException) {
      return 'configuration_invalid_base_url'
    }
    if (source instanceof LLMRateLimitExceededException) {
      return 'transient_rate_limited'
    }
    if (isAbortLikeError(source)) {
      return 'user_abort'
    }

    const status = this.getNumericProperty(source, 'status')
    if (status === 408) {
      return 'transient_timeout'
    }
    if (status === 429) {
      return 'transient_rate_limited'
    }
    if (status != null && [500, 502, 503, 504].includes(status)) {
      return 'transient_network_failure'
    }

    const code = this.getStringProperty(source, 'code')?.toUpperCase()
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
      return 'transient_timeout'
    }
    if (
      code != null &&
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ENETDOWN',
        'ENETRESET',
        'ENETUNREACH',
        'ENOTFOUND',
        'EPIPE',
      ].includes(code)
    ) {
      return 'transient_network_failure'
    }

    const message =
      source instanceof Error
        ? source.message.toLowerCase()
        : String(source).toLowerCase()
    if (message.includes('timeout') || message.includes('timed out')) {
      return 'transient_timeout'
    }
    if (
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('socket hang up') ||
      message.includes('fetch failed')
    ) {
      return 'transient_network_failure'
    }

    return undefined
  }

  private getTraceDiagnostic(
    error: unknown,
  ): RetrievalTraceDiagnostic | undefined {
    const source = this.unwrapErrorCause(error)
    if (source instanceof VectorStoreError) {
      return {
        backend: source.backend,
        message: source.message,
      }
    }
    return undefined
  }

  private getEmbeddingDiagnostic(
    error: unknown,
  ): RetrievalTraceDiagnostic | undefined {
    if (
      error instanceof Error &&
      'embeddingDiagnostic' in error &&
      typeof (error as Error & { embeddingDiagnostic?: unknown })
        .embeddingDiagnostic === 'object' &&
      (error as Error & { embeddingDiagnostic?: unknown })
        .embeddingDiagnostic != null
    ) {
      return (
        error as Error & {
          embeddingDiagnostic: RetrievalTraceDiagnostic
        }
      ).embeddingDiagnostic
    }
    return undefined
  }

  private unwrapErrorCause(error: unknown): unknown {
    if (
      error instanceof Error &&
      'cause' in error &&
      (error as Error & { cause?: unknown }).cause != null
    ) {
      return this.unwrapErrorCause((error as Error & { cause?: unknown }).cause)
    }
    return error
  }

  private attachTraceCause(error: Error, cause: unknown): Error {
    Object.defineProperty(error, 'cause', {
      value: cause,
      configurable: true,
      enumerable: false,
      writable: true,
    })
    return error
  }

  private attachEmbeddingDiagnostic(
    error: Error,
    diagnostic: RetrievalTraceDiagnostic,
  ): Error {
    Object.defineProperty(error, 'embeddingDiagnostic', {
      value: diagnostic,
      configurable: true,
      enumerable: false,
      writable: true,
    })
    return error
  }

  private mergeTraceDiagnostics(
    base: RetrievalTraceDiagnostic | undefined,
    extra: RetrievalTraceDiagnostic | undefined,
  ): RetrievalTraceDiagnostic | undefined {
    if (!base) return extra
    if (!extra) return base
    return {
      ...base,
      ...extra,
      embeddingAttemptDurationsMs:
        extra.embeddingAttemptDurationsMs ?? base.embeddingAttemptDurationsMs,
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return
    const error = new Error('RAG query aborted')
    error.name = 'AbortError'
    throw error
  }

  private async awaitWithAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.throwIfAborted(signal)
    if (!signal) return await promise
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = () => signal.removeEventListener('abort', onAbort)
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        const error = new Error('RAG query aborted')
        error.name = 'AbortError'
        reject(error)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  private getNumericProperty(value: unknown, key: string): number | undefined {
    if (
      typeof value === 'object' &&
      value !== null &&
      key in value &&
      typeof (value as Record<string, unknown>)[key] === 'number'
    ) {
      return (value as Record<string, number>)[key]
    }
    return undefined
  }

  private getStringProperty(value: unknown, key: string): string | undefined {
    if (
      typeof value === 'object' &&
      value !== null &&
      key in value &&
      typeof (value as Record<string, unknown>)[key] === 'string'
    ) {
      return (value as Record<string, string>)[key]
    }
    return undefined
  }
}
