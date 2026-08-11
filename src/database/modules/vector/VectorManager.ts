import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { backOff } from 'exponential-backoff'
import { App, TFile } from 'obsidian'

import { IndexProgress } from '../../../components/chat-view/QueryProgress'
import { isRagIndexablePath } from '../../../core/rag/indexSourcePolicy'
import { splitMarkdownIntoChunks } from '../../../core/rag/markdownChunkSplitter'
import {
  RagIndexFailureKind,
  RagIndexIncompleteError,
  classifyRagIndexError,
  isTransientRagIndexError,
} from '../../../core/rag/ragIndexErrors'
import {
  type DesiredChunk,
  type ReconcileScope,
} from '../../../core/rag/reconciler'
import { hashProjectionSource } from '../../../core/search/index/projectionSegmenter'
import { EmbeddingModelClient } from '../../../types/embedding'
import { EmbeddingModel } from '../../../types/embedding-model.types'
import type { YoloSettingsLike } from '../../../types/yoloSettingsLike'
import { sha256HexPrefix16 } from '../../../utils/common/content-hash'
import { yieldToMain } from '../../../utils/common/yield-to-main'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfText,
} from '../../../utils/pdf/extractPdfText'
import { createEmbeddingVectorNamespace } from '../rag/embeddingNamespace'
import {
  type VectorChunkWrite,
  type VectorFileWrite,
  type VectorNamespace,
  type VectorSearchTimings,
  type VectorStore,
} from '../rag/VectorStore'

import type {
  LegacyEmbeddingRecord,
  VectorMetaData,
} from './legacyEmbeddingTypes'
import { adaptVectorHitsToLegacySimilarityRows } from './vectorHitAdapter'

const PDF_PAGE_CHUNK_CHAR_THRESHOLD = 1500
const SQLITE_FILE_WORKER_MAX = 8
const PDF_PROJECTION_SOURCE_PARSER_VERSION = 'pdf-text-v1'

export type ReconcileConfig = {
  chunkSize: number
  chunkOverlap?: number
  includePatterns: string[]
  excludePatterns: string[]
  /**
   * When true, files under the plugin's YOLO base directory (resolved from
   * `settings.yolo.baseDir`) are excluded from indexing in addition to
   * `excludePatterns`. Path resolution is dynamic per call; toggling
   * `yolo.baseDir` updates the filter without any settings migration.
   */
  excludeYoloBaseDir?: boolean
  /** When false, PDFs are excluded from the desired set (and existing PDF rows are removed). */
  indexPdf: boolean
  /**
   * Max parallel embedding requests. Clamped to [1, 24]. Default 10. Lower
   * this when the embedding provider returns 429 (e.g. Azure S0 tier).
   */
  embeddingConcurrency?: number
  /** Optional YOLO-root-aware settings handle; enables the PDF text cache. */
  settings?: YoloSettingsLike | null
}

export type ReconcileOptions = {
  scope: ReconcileScope
  /** When true, wipe the model namespace before reconciling (rebuild semantics). */
  truncate?: boolean
  signal?: AbortSignal
  onProgress?: (progress: IndexProgress) => void
  onPdfTextExtracted?: (source: {
    path: string
    contentHash: string
    sourceParserVersion: string
    pages: { page: number; text: string }[]
    signal?: AbortSignal
  }) => void | Promise<void>
}

/**
 * Structured outcome of a reconcile pass. Hard failures still throw; this only
 * carries the soft (non-throwing) per-file failures so the UI layer can decide
 * how to surface them by trigger.
 *
 * - `permanentFailedPaths`: files whose embedding failed permanently (e.g. 400
 *   bad request). Their successful chunks are kept; they are NOT retried
 *   automatically → need user intervention.
 * - `chunkifyFailedPaths`: files that failed to chunkify (e.g. transient I/O).
 *   Excluded from the diff, old index preserved, mtime not advanced → self-heals
 *   on the next reconcile.
 */
export type ReconcileResult = {
  permanentFailedPaths: string[]
  chunkifyFailedPaths: string[]
}

export type SimilaritySearchResult = Omit<LegacyEmbeddingRecord, 'id'> & {
  id: string | number
  similarity: number
}

export type VectorSimilarityTrace = {
  coarseSearchMs?: number
  loadFullVectorsMs?: number
  rerankSimilarityMs?: number
}

export class VectorManager {
  private app: App
  private vectorStore: VectorStore | null = null
  private settings: {
    embeddingModels?: EmbeddingModel[]
    ragBackendSettings?: {
      rebuildRequired?: boolean
    }
  } | null = null

  private static isOptionsLike(value: unknown): value is {
    vectorStore?: VectorStore | null
    settings?: {
      embeddingModels?: EmbeddingModel[]
      ragBackendSettings?: {
        rebuildRequired?: boolean
      }
    } | null
  } {
    return (
      !!value &&
      typeof value === 'object' &&
      ('vectorStore' in value || 'settings' in value)
    )
  }

  constructor(
    app: App,
    legacyDbOrOptions?: unknown,
    options?: {
      vectorStore?: VectorStore | null
      settings?: {
        embeddingModels?: EmbeddingModel[]
        ragBackendSettings?: {
          rebuildRequired?: boolean
        }
      } | null
    },
  ) {
    this.app = app
    const resolvedOptions =
      options ??
      (VectorManager.isOptionsLike(legacyDbOrOptions)
        ? legacyDbOrOptions
        : null)
    this.vectorStore = resolvedOptions?.vectorStore ?? null
    this.settings = resolvedOptions?.settings ?? null
  }

  setSaveCallback(_callback: () => Promise<void>) {}

  setVacuumCallback(_callback: () => Promise<void>) {}

  setSettings(
    settings: {
      embeddingModels?: EmbeddingModel[]
      ragBackendSettings?: {
        rebuildRequired?: boolean
      }
    } | null,
  ) {
    this.settings = settings
  }


  async listNamespaces(): Promise<string[]> {
    return this.vectorStore?.listNamespaces?.() ?? []
  }

  /** 兼容上游 UI：清空全部向量。 */
  async clearAllVectors(embeddingModelOrId?: string | EmbeddingModelClient): Promise<void> {
    const namespaces = await this.listNamespaces()
    for (const ns of namespaces) {
      const key = ns
      const targetId =
        typeof embeddingModelOrId === 'string'
          ? embeddingModelOrId
          : embeddingModelOrId?.id
      if (targetId && key !== targetId) continue
      await this.vectorStore?.dropNamespaceById?.(ns)
    }
  }

  /** 兼容上游 UI：按模型清空。 */
  async clearVectorsByModelIds(modelIds: string[]): Promise<void> {
    const namespaces = await this.listNamespaces()
    for (const ns of namespaces) {
      const key = ns
      if (modelIds.includes(key)) {
        await this.vectorStore?.dropNamespaceById?.(ns)
      }
    }
  }

  /** 兼容上游 UI：模型统计。 */

  async getStatus(): Promise<{
    storagePath: string
    readiness: 'opening' | 'ready' | 'unsupported' | 'open_failed'
    rebuildRequired: boolean
  }> {
    const namespaces = await this.listNamespaces()
    const ns = namespaces[0]
    // Point at the first real namespace database. Without the namespace the
    // store reports the placeholder `rag/<namespace>` path, which does not
    // exist — opening it would create an empty database with no tables.
    const status = ns
      ? await this.vectorStore?.getStatusByNamespaceId?.(ns)
      : await this.vectorStore?.getStatus?.()
    return {
      storagePath: status?.storagePath ?? '',
      readiness: status?.readiness ?? 'unsupported',
      rebuildRequired: status?.rebuildRequired ?? false,
    }
  }

  async getEmbeddingStats(): Promise<
    Array<{ model: string; rowCount: number; totalDataBytes: number }>
  > {
    const namespaces = await this.listNamespaces()
    const stats: Array<{ model: string; rowCount: number; totalDataBytes: number }> = []
    for (const ns of namespaces) {
      const statsFor = await this.vectorStore?.getStats?.()
      const model = ns
      const rowCount = statsFor?.chunkCount ?? 0
      stats.push({
        model,
        rowCount,
        totalDataBytes: 0,
      })
    }
    return stats
  }

  async performSimilaritySearch(
    queryVector: number[],
    embeddingModel: EmbeddingModelClient,
    options: {
      minSimilarity: number
      limit: number
      scope?: {
        files: string[]
        folders: string[]
      }
      signal?: AbortSignal
    },
  ): Promise<{
    rows: SimilaritySearchResult[]
    trace?: VectorSimilarityTrace
  }> {
    if (this.vectorStore) {
      const namespace = this.getVectorNamespace(embeddingModel)
      const searchOptions = {
        topK: options.limit,
        minSimilarity: options.minSimilarity,
        scope: options.scope,
        signal: options.signal,
      }
      throwIfVectorSearchAborted(options.signal)
      const detailedResult = this.vectorStore.searchDetailed
        ? await this.vectorStore.searchDetailed(
            namespace,
            queryVector,
            searchOptions,
          )
        : null
      const hits =
        detailedResult?.hits ??
        (await this.vectorStore.search(namespace, queryVector, searchOptions))
          .hits
      throwIfVectorSearchAborted(options.signal)

      return {
        rows: adaptVectorHitsToLegacySimilarityRows(
          hits,
          embeddingModel,
          this.coerceLegacyEmbeddingId.bind(this),
          this.numberFromMetadata.bind(this),
        ),
        trace: this.mapVectorSearchTimings(detailedResult?.timingsMs),
      }
    }

    throw new Error('SQLite vector store is not available.')
  }

  async getQueryEmbedding(
    namespace: Parameters<NonNullable<VectorStore['getQueryEmbedding']>>[0],
    queryHash: string,
  ): Promise<number[] | null> {
    return this.vectorStore?.getQueryEmbedding?.(namespace, queryHash) ?? null
  }

  async putQueryEmbedding(
    namespace: Parameters<NonNullable<VectorStore['putQueryEmbedding']>>[0],
    queryHash: string,
    embedding: number[],
  ): Promise<void> {
    await this.vectorStore?.putQueryEmbedding?.(namespace, queryHash, embedding)
  }

  private mapVectorSearchTimings(
    timings?: VectorSearchTimings,
  ): VectorSimilarityTrace | undefined {
    if (!timings) {
      return undefined
    }
    return {
      coarseSearchMs: timings.coarseSearch,
      loadFullVectorsMs: timings.loadFullVectors,
      rerankSimilarityMs: timings.rerankSimilarity,
    }
  }

  /**
   * Reconcile the index for one model namespace against the current vault and
   * configuration. Single entry point for all index writes:
   *
   * - "rebuild": pass `truncate: true, scope: { kind: 'all' }`
   * - "sync after settings change": `truncate: false, scope: { kind: 'all' }`
   * - "sync after file events": `truncate: false, scope: { kind: 'paths', paths: [...] }`
   *
   * Idempotent: re-running the same call after a crash will only re-embed
   * chunks that didn't make it to the DB before.
   */
  async reconcile(
    embeddingModel: EmbeddingModelClient,
    config: ReconcileConfig,
    options: ReconcileOptions,
  ): Promise<ReconcileResult> {
    if (!this.vectorStore) {
      throw new Error('SQLite vector store is not available.')
    }

    return this.reconcileWithVectorStore(embeddingModel, config, options)
  }

  // ---------- internals ----------

  private listIndexableFiles(config: ReconcileConfig): TFile[] {
    return this.app.vault.getFiles().filter((file) =>
      isRagIndexablePath(file.path, {
        yolo: config.settings?.yolo,
        ragOptions: {
          indexPdf: config.indexPdf,
          excludeYoloBaseDir: config.excludeYoloBaseDir,
          excludePatterns: config.excludePatterns,
          includePatterns: config.includePatterns,
        },
      }),
    )
  }

  private async chunkifyFile(
    file: TFile,
    chunkSize: number,
    chunkOverlap: number,
    signal?: AbortSignal,
    settings?: YoloSettingsLike | null,
    onPdfTextExtracted?: ReconcileOptions['onPdfTextExtracted'],
  ): Promise<DesiredChunk[]> {
    if (file.extension?.toLowerCase() === 'pdf') {
      return this.chunkifyPdf(
        file,
        chunkSize,
        signal,
        settings,
        onPdfTextExtracted,
      )
    }

    const fileContent = await this.app.vault.cachedRead(file)
    const sanitized = fileContent.split('\u0000').join('')
    const docs = await splitMarkdownIntoChunks(
      sanitized,
      chunkSize,
      chunkOverlap,
    )

    const chunks: DesiredChunk[] = []
    for (const doc of docs) {
      const meta: VectorMetaData = {
        startLine: doc.startLine,
        endLine: doc.endLine,
      }
      const contentHash = await sha256HexPrefix16(doc.content)
      chunks.push({
        path: file.path,
        content: doc.content,
        contentHash,
        metadata: meta,
        mtime: file.stat.mtime,
      })
    }
    return chunks
  }

  private async chunkifyPdf(
    file: TFile,
    chunkSize: number,
    signal?: AbortSignal,
    settings?: YoloSettingsLike | null,
    onPdfTextExtracted?: ReconcileOptions['onPdfTextExtracted'],
  ): Promise<DesiredChunk[]> {
    if (file.stat.size > PDF_INDEX_MAX_BYTES) {
      console.warn(
        `[YOLO] Skipping PDF (>${PDF_INDEX_MAX_BYTES} bytes): ${file.path}`,
      )
      return []
    }

    let pages: { page: number; text: string }[]
    try {
      const extracted = await extractPdfText(this.app, file, {
        signal,
        maxBinaryBytes: PDF_INDEX_MAX_BYTES,
        maxPages: PDF_INDEX_MAX_PAGES,
        settings: settings ?? null,
      })
      pages = extracted.pages
      const projectionSource = {
        path: file.path,
        contentHash: hashProjectionSource({
          kind: 'pdf',
          pages: extracted.pages,
        }),
        sourceParserVersion: PDF_PROJECTION_SOURCE_PARSER_VERSION,
        pages: extracted.pages,
        ...(signal ? { signal } : {}),
      }
      if (onPdfTextExtracted) {
        try {
          await onPdfTextExtracted(projectionSource)
        } catch (error) {
          console.warn(
            `[YOLO] PDF projection callback failed: ${file.path}`,
            error instanceof Error ? error.message : error,
          )
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      console.warn(
        `[YOLO] PDF text extraction failed: ${file.path}`,
        error instanceof Error ? error.message : error,
      )
      throw error instanceof Error ? error : new Error(String(error))
    }

    const pageSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: Math.min(PDF_PAGE_CHUNK_CHAR_THRESHOLD, chunkSize),
      chunkOverlap: 0,
    })

    const chunks: DesiredChunk[] = []
    for (const { page: pageNum, text } of pages) {
      const trimmed = text.split('\u0000').join('').trim()
      if (!trimmed) continue
      const lineCount = Math.max(1, trimmed.split('\n').length)
      if (trimmed.length <= PDF_PAGE_CHUNK_CHAR_THRESHOLD) {
        const content = `[page ${pageNum}]\n${trimmed}`
        const contentHash = await sha256HexPrefix16(content)
        chunks.push({
          path: file.path,
          content,
          contentHash,
          metadata: { page: pageNum, startLine: 1, endLine: lineCount },
          mtime: file.stat.mtime,
        })
      } else {
        const docs = await pageSplitter.createDocuments([trimmed])
        for (const doc of docs) {
          const from = doc.metadata.loc.lines.from as number
          const to = doc.metadata.loc.lines.to as number
          const content = `[page ${pageNum}]\n${doc.pageContent}`
          const contentHash = await sha256HexPrefix16(content)
          chunks.push({
            path: file.path,
            content,
            contentHash,
            metadata: { page: pageNum, startLine: from, endLine: to },
            mtime: file.stat.mtime,
          })
        }
      }
    }
    return chunks
  }

  private async reconcileWithVectorStore(
    embeddingModel: EmbeddingModelClient,
    config: ReconcileConfig,
    options: ReconcileOptions,
  ): Promise<ReconcileResult> {
    const vectorStore = this.vectorStore
    if (!vectorStore) {
      throw new Error('VectorStore is not configured')
    }

    const { signal, scope, truncate, onProgress } = options
    const namespace = this.getVectorNamespace(embeddingModel)

    if (truncate) {
      await vectorStore.clearNamespace(namespace)
    }

    const allCandidates = this.listIndexableFiles(config)
    const candidateFiles =
      scope.kind === 'all'
        ? allCandidates
        : allCandidates.filter((file) => scope.paths.includes(file.path))
    const candidateSet = new Set(candidateFiles.map((file) => file.path))

    const getIndexedFiles = vectorStore.getIndexedFiles?.bind(vectorStore)
    if (!truncate && typeof getIndexedFiles !== 'function') {
      throw new Error('VectorStore indexed-file capability is unavailable')
    }
    const indexedFiles = truncate
      ? new Map<string, { mtime: number; contentHash?: string }>()
      : await getIndexedFiles!.call(vectorStore, namespace)
    const fileReadiness =
      !truncate && typeof vectorStore.getFileReadiness === 'function'
        ? ((await vectorStore.getFileReadiness(
            namespace,
            candidateFiles.map((file) => file.path),
          )) ?? new Map())
        : new Map()

    const filesToChunkify: TFile[] = []
    for (const file of candidateFiles) {
      if (file.stat.size === 0) continue
      const existing = indexedFiles.get(file.path)
      if (existing == null || existing.mtime !== file.stat.mtime) {
        filesToChunkify.push(file)
      }
    }

    if (!truncate) {
      const inScope = (path: string) =>
        scope.kind === 'all' ? true : scope.paths.includes(path)
      for (const path of indexedFiles.keys()) {
        if (!candidateSet.has(path) && inScope(path)) {
          await vectorStore.deleteFile(namespace, path)
        }
      }
    }

    const totalFilesCount = candidateFiles.length
    let completedFilesCount = truncate
      ? 0
      : candidateFiles.filter((file) => {
          const readiness = fileReadiness.get(file.path)
          return readiness?.vectorReady === true
        }).length

    onProgress?.({
      completedChunks: 0,
      totalChunks: 0,
      totalFiles: totalFilesCount,
      completedFiles: completedFilesCount,
    })

    if (filesToChunkify.length === 0) {
      return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
    }

    const chunkifyFailedPaths: string[] = []
    const permanentFailedPaths: string[] = []
    const writtenPermanentFailedPaths = new Set<string>()
    const activeFilePaths = new Set<string>()
    const enqueuedWritePaths = new Set<string>()
    const writtenPaths = new Set<string>()
    let nextFileIndex = 0
    let fatalError: unknown = null
    let writeQueue: Promise<void> = Promise.resolve()

    const fileWorkerLimit = Math.max(
      1,
      Math.min(SQLITE_FILE_WORKER_MAX, config.embeddingConcurrency ?? 10),
    )

    const enqueueWrite = (
      fileWrite: VectorFileWrite,
      permanentFailed: boolean,
    ): Promise<void> => {
      if (enqueuedWritePaths.has(fileWrite.path)) {
        throw new Error(
          `Duplicate file write enqueued in one reconcile run: ${fileWrite.path}`,
        )
      }
      enqueuedWritePaths.add(fileWrite.path)
      const writeTask = writeQueue.then(async () => {
        if (writtenPaths.has(fileWrite.path)) {
          throw new Error(
            `Duplicate file write execution in one reconcile run: ${fileWrite.path}`,
          )
        }
        await vectorStore.replaceFile(namespace, fileWrite)
        writtenPaths.add(fileWrite.path)
        if (permanentFailed) {
          writtenPermanentFailedPaths.add(fileWrite.path)
        }
      })
      writeQueue = writeTask.catch((error: unknown) => {
        fatalError = fatalError ?? error
        throw error
      })
      return writeTask
    }

    const processFile = async (file: TFile): Promise<void> => {
      if (activeFilePaths.has(file.path)) {
        throw new Error(
          `Concurrent duplicate file processing detected: ${file.path}`,
        )
      }
      activeFilePaths.add(file.path)
      onProgress?.({
        completedChunks: 0,
        totalChunks: 0,
        totalFiles: totalFilesCount,
        completedFiles: completedFilesCount,
        currentFile: file.path,
      })

      try {
        const chunks = await this.chunkifyFile(
          file,
          config.chunkSize,
          config.chunkOverlap ?? 0,
          signal,
          config.settings ?? null,
          options.onPdfTextExtracted,
        )
        const { fileWrite, permanentFailed } =
          await this.buildVectorStoreFileWrite(
            file,
            file.stat.mtime,
            chunks,
            embeddingModel,
            signal,
            config.embeddingConcurrency,
          )

        if (permanentFailed) {
          permanentFailedPaths.push(file.path)
        }
        await enqueueWrite(fileWrite, permanentFailed)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error
        }
        if (error instanceof RagIndexIncompleteError) {
          await vectorStore.deleteFile(namespace, file.path)
          throw error
        }
        chunkifyFailedPaths.push(file.path)
      } finally {
        activeFilePaths.delete(file.path)
        completedFilesCount += 1
        onProgress?.({
          completedChunks: 0,
          totalChunks: 0,
          totalFiles: totalFilesCount,
          completedFiles: completedFilesCount,
          currentFile: file.path,
        })
      }
    }

    const worker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('Indexing cancelled by user', 'AbortError')
        }
        if (fatalError != null) {
          return
        }
        const file = filesToChunkify[nextFileIndex++]
        if (!file) {
          return
        }
        try {
          await processFile(file)
        } catch (error) {
          fatalError = error
          throw error
        }
      }
    }

    await Promise.allSettled(
      Array.from(
        { length: Math.min(fileWorkerLimit, filesToChunkify.length) },
        () => worker(),
      ),
    )

    await writeQueue

    if (fatalError instanceof RagIndexIncompleteError) {
      if (writtenPermanentFailedPaths.size > 0) {
        const paths = [...writtenPermanentFailedPaths]
        if (typeof vectorStore.deleteFiles === 'function') {
          await vectorStore.deleteFiles(namespace, paths)
        } else {
          for (const path of paths) {
            await vectorStore.deleteFile(namespace, path)
          }
        }
      }
      throw new RagIndexIncompleteError([
        ...new Set([
          ...fatalError.rolledBackPaths,
          ...writtenPermanentFailedPaths,
        ]),
      ])
    }

    if (fatalError != null) {
      throw fatalError instanceof Error
        ? fatalError
        : new Error('Vector indexing failed with a non-Error value')
    }

    return { permanentFailedPaths, chunkifyFailedPaths }
  }

  private async buildVectorStoreFileWrite(
    file: TFile,
    mtime: number,
    chunks: DesiredChunk[],
    embeddingModel: EmbeddingModelClient,
    signal?: AbortSignal,
    maxConcurrency?: number,
  ): Promise<{ fileWrite: VectorFileWrite; permanentFailed: boolean }> {
    const { chunks: embeddedChunks, permanentFailed } =
      await this.embedVectorStoreChunks(chunks, embeddingModel, {
        signal,
        maxConcurrency,
      })

    this.assertUniqueChunkIds(file.path, embeddedChunks)
    return {
      fileWrite: {
        path: file.path,
        mtime,
        contentHash: await this.buildFileContentHashFromChunks(chunks),
        chunks: embeddedChunks,
      },
      permanentFailed,
    }
  }

  private async embedVectorStoreChunks(
    chunks: DesiredChunk[],
    embeddingModel: EmbeddingModelClient,
    options: {
      signal?: AbortSignal
      maxConcurrency?: number
    },
  ): Promise<{ chunks: VectorChunkWrite[]; permanentFailed: boolean }> {
    const { signal } = options
    const failedChunks: Array<{
      error: string
      kind: RagIndexFailureKind
    }> = []
    const writes: VectorChunkWrite[] = []
    const MAX_BATCH_SIZE = Math.max(
      1,
      Math.min(24, Math.floor(options.maxConcurrency ?? 10)),
    )
    const MIN_BATCH_SIZE = Math.min(10, MAX_BATCH_SIZE)
    let currentBatchSize = MAX_BATCH_SIZE
    let wholeBatchFailed = false

    const embedOne = async (
      chunk: DesiredChunk,
    ): Promise<VectorChunkWrite | null> => {
      if (signal?.aborted) return null
      try {
        const embedding = await backOff(
          async () => {
            if (signal?.aborted) {
              throw new DOMException('Indexing cancelled by user', 'AbortError')
            }
            if (chunk.content.length === 0) {
              throw new Error(`Chunk content is empty in file: ${chunk.path}`)
            }
            if (chunk.content.includes('\x00')) {
              throw new Error(
                `Chunk content contains null bytes in file: ${chunk.path}`,
              )
            }
            return await embeddingModel.getEmbedding(chunk.content)
          },
          {
            numOfAttempts: 6,
            startingDelay: 1500,
            timeMultiple: 2,
            maxDelay: 30000,
            retry: (error) => {
              if (signal?.aborted) return false
              return isTransientRagIndexError(error)
            },
          },
        )

        return {
          chunkId: `${chunk.path}#${chunk.metadata.page ?? ''}:${chunk.metadata.startLine}:${chunk.metadata.endLine}:${chunk.contentHash}`,
          path: chunk.path,
          text: chunk.content,
          contentHash: chunk.contentHash,
          embedding,
          location: {
            lineStart: chunk.metadata.startLine,
            lineEnd: chunk.metadata.endLine,
            page: chunk.metadata.page,
          },
          metadataJson: {
            startLine: chunk.metadata.startLine,
            endLine: chunk.metadata.endLine,
            page: chunk.metadata.page,
            contentHash: chunk.contentHash,
          },
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error
        }
        failedChunks.push({
          error: error instanceof Error ? error.message : 'Unknown error',
          kind: classifyRagIndexError(error),
        })
        return null
      }
    }

    for (
      let batchStart = 0;
      batchStart < chunks.length;
      batchStart += currentBatchSize
    ) {
      if (signal?.aborted) {
        throw new DOMException('Indexing cancelled by user', 'AbortError')
      }
      await yieldToMain()

      const batch = chunks.slice(batchStart, batchStart + currentBatchSize)
      let validRows: VectorChunkWrite[] = []
      let attempt = 0
      while (attempt < 2) {
        attempt += 1
        const failureStart = failedChunks.length
        const results = await Promise.all(batch.map((chunk) => embedOne(chunk)))
        validRows = results.filter(
          (row): row is VectorChunkWrite => row !== null,
        )
        if (validRows.length > 0) {
          if (
            validRows.length !== batch.length &&
            currentBatchSize > MIN_BATCH_SIZE
          ) {
            currentBatchSize = Math.max(
              MIN_BATCH_SIZE,
              Math.floor(currentBatchSize / 2),
            )
          } else if (
            validRows.length === batch.length &&
            currentBatchSize < MAX_BATCH_SIZE
          ) {
            currentBatchSize = Math.min(MAX_BATCH_SIZE, currentBatchSize + 4)
          }
          break
        }
        if (attempt < 2) {
          failedChunks.splice(failureStart)
          currentBatchSize = Math.max(
            MIN_BATCH_SIZE,
            Math.floor(currentBatchSize / 2),
          )
          await yieldToMain()
        }
      }

      if (validRows.length === 0 && batch.length > 0) {
        wholeBatchFailed = true
        break
      }

      writes.push(...validRows)
      batchStart += batch.length - currentBatchSize
    }

    const hasTransientFailure = failedChunks.some(
      (chunk) => chunk.kind === 'transient',
    )
    if (hasTransientFailure) {
      throw new RagIndexIncompleteError([chunks[0]?.path ?? 'unknown'])
    }

    if (wholeBatchFailed) {
      throw new Error(
        'Embedding halted: an entire batch failed to embed and indexing was stopped before completing all chunks.',
      )
    }

    if (failedChunks.length > 0) {
      return { chunks: writes, permanentFailed: true }
    }

    return { chunks: writes, permanentFailed: false }
  }

  private getVectorNamespace(
    embeddingModel: EmbeddingModelClient,
  ): VectorNamespace {
    const configuredModel = this.settings?.embeddingModels?.find(
      (model) => model.id === embeddingModel.id,
    )
    return createEmbeddingVectorNamespace({
      model: configuredModel?.model ?? embeddingModel.id,
      dimension: embeddingModel.dimension,
    })
  }

  private numberFromMetadata(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined
  }

  private coerceLegacyEmbeddingId(id: string, fallbackIndex: number): number {
    const numericId = Number(id)
    return Number.isFinite(numericId) ? numericId : fallbackIndex + 1
  }

  private async buildFileContentHashFromChunks(
    chunks: DesiredChunk[],
  ): Promise<string> {
    return sha256HexPrefix16(chunks.map((chunk) => chunk.contentHash).join('|'))
  }

  private assertUniqueChunkIds(path: string, chunks: VectorChunkWrite[]): void {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const chunk of chunks) {
      if (seen.has(chunk.chunkId)) {
        duplicates.add(chunk.chunkId)
        continue
      }
      seen.add(chunk.chunkId)
    }
    if (duplicates.size === 0) {
      return
    }
    const details = chunks
      .filter((chunk) => duplicates.has(chunk.chunkId))
      .slice(0, 6)
      .map((chunk) => ({
        chunkId: chunk.chunkId,
        lineStart: chunk.location.lineStart,
        lineEnd: chunk.location.lineEnd,
        page: chunk.location.page,
        contentHash: chunk.contentHash,
        textPreview: chunk.text.slice(0, 120),
      }))
    throw new Error(
      `Duplicate chunk ids generated for ${path}: ${JSON.stringify(details)}`,
    )
  }
}

function throwIfVectorSearchAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('Vector search cancelled')
  error.name = 'AbortError'
  throw error
}
