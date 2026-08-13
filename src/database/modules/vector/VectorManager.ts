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
  type VectorVacuumResult,
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

  /**
   * 碎片整理入口：转发到底层向量存储。移动端分片后端按命名空间重建压缩并
   * 清理墓碑行；桌面后端跑 SQLite VACUUM（无墓碑计数，返回 0/0）。
   */
  async vacuum(): Promise<VectorVacuumResult> {
    if (!this.vectorStore) {
      throw new Error('SQLite vector store is not available.')
    }
    return this.vectorStore.vacuum()
  }

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

  /** 兼容上游 UI：清空全部向量（不传参数）或指定模型的向量。 */
  async clearAllVectors(
    embeddingModelOrId?: string | EmbeddingModelClient,
  ): Promise<void> {
    if (!this.vectorStore) return
    if (embeddingModelOrId == null) {
      for (const ns of await this.listNamespaces()) {
        await this.vectorStore.dropNamespaceById?.(ns)
      }
      return
    }
    const client =
      typeof embeddingModelOrId === 'string'
        ? this.settings?.embeddingModels?.find(
            (model) => model.id === embeddingModelOrId,
          )
        : embeddingModelOrId
    if (!client) {
      console.warn(
        `[YOLO] Cannot clear embeddings: unknown embedding model ${
          typeof embeddingModelOrId === 'string'
            ? embeddingModelOrId
            : embeddingModelOrId?.id
        }`,
      )
      return
    }
    // The namespace key is a derived id (`<model-last-segment>-d<dimension>`),
    // never the model id — match through getVectorNamespace instead of
    // comparing the model id against the key string (which never matches, so
    // the old code silently dropped nothing).
    await this.vectorStore.dropNamespace?.(this.getVectorNamespace(client))
  }

  /** 兼容上游 UI：按模型清空。 */
  async clearVectorsByModelIds(modelIds: string[]): Promise<void> {
    if (!this.vectorStore) return
    for (const id of modelIds) {
      const model = this.settings?.embeddingModels?.find(
        (embeddingModel) => embeddingModel.id === id,
      )
      if (!model) {
        console.warn(
          `[YOLO] Cannot clear embeddings for unknown model id: ${id}`,
        )
        continue
      }
      await this.vectorStore.dropNamespace?.(
        createEmbeddingVectorNamespace({
          model: model.model,
          dimension: model.dimension,
        }),
      )
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
    const stats: Array<{
      model: string
      rowCount: number
      totalDataBytes: number
    }> = []
    for (const nsId of namespaces) {
      // getStats() without a namespace returns the aggregate placeholder with
      // zeroed counters — derive the namespace object from the id so the per-
      // namespace row/chunk counts and db file size are real.
      const ns = namespaceFromNamespaceId(nsId)
      const statsFor = ns ? await this.vectorStore?.getStats?.(ns) : undefined
      stats.push({
        model: nsId,
        rowCount: statsFor?.chunkCount ?? 0,
        totalDataBytes: statsFor?.fileSizeBytes ?? 0,
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

    const realMtime = await this.readRealFileMtime(file)
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
        mtime: realMtime,
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
          mtime: Math.round(file.stat.mtime),
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
            mtime: Math.round(file.stat.mtime),
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
    // Emptied files can't be chunkified, but their old rows must still be
    // removed — otherwise retrieval keeps returning content that no longer
    // exists in the vault.
    const emptyFilePaths = new Set(
      candidateFiles.filter((file) => file.stat.size === 0).map((f) => f.path),
    )

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
      if (existing == null) {
        filesToChunkify.push(file)
        continue
      }
      // 文件在索引时记录的 mtime 之后被修改过 → 待处理。比较基准是写入时
      // 记录的文件 mtime（rag_files.mtime），不是索引写入时刻（updated_at）：
      // 用 updated_at 会把索引运行窗口内（可能几分钟）被修改的文件误判为
      // "未修改"而永久跳过，直到该文件再次被编辑。
      // readRealFileMtime 走 adapter.stat，值稳定，不会因 TFile.stat 缓存
      // 噪声误判为"文件变了"而重复索引。
      const realMtime = await this.readRealFileMtime(file)
      if (existing.mtime !== realMtime) {
        filesToChunkify.push(file)
      }
    }

    if (!truncate) {
      const inScope = (path: string) =>
        scope.kind === 'all' ? true : scope.paths.includes(path)
      for (const path of indexedFiles.keys()) {
        if (
          (!candidateSet.has(path) || emptyFilePaths.has(path)) &&
          inScope(path)
        ) {
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

    // 没有待处理文件时直接完成：不报中间进度（否则无变更的"更新索引"也会
    // 显示一次 99% 的伪进度，看起来像重新处理了一遍）。
    if (filesToChunkify.length === 0 && !truncate) {
      return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
    }

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
            await this.readRealFileMtime(file),
            chunks,
            embeddingModel,
            signal,
            config.embeddingConcurrency,
          )

        if (permanentFailed) {
          permanentFailedPaths.push(file.path)
        }
        if (fileWrite.chunks.length === 0) {
          // Nothing was embedded (whole-file permanent failure): keep the old
          // indexed rows instead of replacing the file with an empty write
          // (which would erase previously indexed content).
          return
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

  /**
   * 实时文件系统 mtime（app.vault.adapter.stat），替代 Obsidian TFile.stat
   * 的缓存值。TFile.stat.mtime 是内部缓存，对部分文件（如邮箱插件反复
   * 解析的邮件）两次读取的浮点小数可能不同，导致增量判定误判为"文件变了"
   * 而重复索引。adapter.stat 直接读文件系统，值稳定。
   */
  private async readRealFileMtime(file: TFile): Promise<number> {
    try {
      const stat = await this.app.vault.adapter.stat(file.path)
      if (stat && typeof stat.mtime === 'number') {
        return Math.round(stat.mtime)
      }
    } catch {
      // fallthrough to cached value
    }
    return Math.round(file.stat.mtime)
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
      if (failedChunks.length > 0) {
        // The whole batch failed permanently (a transient failure would have
        // thrown RagIndexIncompleteError above). Record the file as a
        // permanent failure so the caller keeps whatever earlier batches
        // succeeded and does NOT re-embed the doomed chunks on every future
        // reconcile — the previous behavior classified the file as a
        // transient chunkify failure and re-ran all its embeddings each run.
        return { chunks: writes, permanentFailed: true }
      }
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
    embeddingModel: Pick<EmbeddingModelClient, 'id' | 'dimension'>,
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

/**
 * Reverse of `vectorNamespaceId`: reconstructs a VectorNamespace from a
 * namespace id (`<model>-d<dimension>`). Normalization is idempotent, so the
 * reconstructed model segment re-derives the same key. Returns null for ids
 * that don't carry the `-d<n>` suffix (e.g. non-vector namespaces).
 */
function namespaceFromNamespaceId(id: string): VectorNamespace | null {
  const match = id.match(/^(.*)-d(\d+)$/)
  if (!match) return null
  const dimension = Number(match[2])
  if (!Number.isFinite(dimension) || dimension <= 0) return null
  return createEmbeddingVectorNamespace({ model: match[1], dimension })
}
