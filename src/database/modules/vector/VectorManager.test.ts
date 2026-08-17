const errorModalCtor = jest.fn()

jest.mock('../../../components/modals/ErrorModal', () => ({
  ErrorModal: class {
    constructor(...args: unknown[]) {
      errorModalCtor(...args)
    }
    open() {
      return this
    }
  },
}))

// Run the embed fn once with no real backoff delays. Faithful for these tests:
// success returns the value; failure rethrows immediately. Tests that need
// retry semantics override the implementation per-test.
jest.mock('exponential-backoff', () => ({
  backOff: jest.fn((fn: () => Promise<unknown>) => fn()),
}))

jest.mock('../../../utils/pdf/extractPdfText', () => ({
  PDF_INDEX_MAX_BYTES: 50_000_000,
  PDF_INDEX_MAX_PAGES: 1000,
  extractPdfText: jest.fn(),
}))

jest.mock('../../../utils/pdf/mineruCacheStore', () => ({
  convertPdfViaMinerU: jest.fn(),
}))

// Mock the markdown splitter so tests can assert call args, while still
// delegating to the real implementation by default (other tests in this
// file rely on actual chunking behavior).
jest.mock('../../../core/rag/markdownChunkSplitter', () => {
  const actual = jest.requireActual('../../../core/rag/markdownChunkSplitter')
  return {
    splitMarkdownIntoChunks: jest.fn(
      (text: string, chunkSize: number, chunkOverlap: number) =>
        actual.splitMarkdownIntoChunks(text, chunkSize, chunkOverlap),
    ),
  }
})

import { backOff } from 'exponential-backoff'
import { splitMarkdownIntoChunks } from '../../../core/rag/markdownChunkSplitter'
import { hashProjectionSource } from '../../../core/search/index/projectionSegmenter'
import type { VectorStore } from '../../../database/modules/rag/VectorStore'
import { extractPdfText } from '../../../utils/pdf/extractPdfText'
import { convertPdfViaMinerU } from '../../../utils/pdf/mineruCacheStore'

import { VectorManager } from './VectorManager'

const embeddingModel = {
  id: 'test-model',
  dimension: 3,
  getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
} as never

type VectorStoreWithIndexedFiles = Omit<
  VectorStore,
  'getIndexedFiles' | 'getFileReadiness'
> &
  Required<Pick<VectorStore, 'getIndexedFiles' | 'getFileReadiness'>>

const fakeVectorStore = (): jest.Mocked<VectorStoreWithIndexedFiles> => ({
  open: jest.fn(),
  close: jest.fn(),
  listNamespaces: jest.fn(),
  getIndexedFiles: jest.fn(),
  replaceFile: jest.fn(),
  replaceFiles: jest.fn(),
  deleteFile: jest.fn(),
  deleteFiles: jest.fn(),
  clearNamespace: jest.fn(),
  vacuum: jest.fn(),
  getStatus: jest.fn(),
  search: jest.fn(),
  searchDetailed: jest.fn(),
  getStats: jest.fn(),
  getFileReadiness: jest.fn(),
  dropNamespace: jest.fn(),
  dropNamespaceById: jest.fn(),
})

const baseConfig = {
  chunkSize: 1000,
  chunkOverlap: 50,
  includePatterns: [],
  excludePatterns: [],
  indexPdf: false,
}

function createVectorStoreManager(
  vectorStore: jest.Mocked<VectorStore>,
  files: Array<{
    path: string
    extension?: string
    mtime: number
    content?: string
    size?: number
  }>,
  settingsOverrides?: Record<string, unknown>,
) {
  const fileContent = new Map(
    files.map((file) => [file.path, file.content ?? '']),
  )
  const app = {
    vault: {
      getFiles: jest.fn().mockReturnValue(
        files.map((file) => ({
          path: file.path,
          extension: file.extension ?? 'md',
          stat: {
            mtime: file.mtime,
            size: file.size ?? file.content?.length ?? 0,
          },
        })),
      ),
      cachedRead: jest.fn(
        async (file: { path: string }) => fileContent.get(file.path) ?? '',
      ),
    },
  }

  const manager = new VectorManager(app as never, {} as never, {
    vectorStore,
    settings: {
      embeddingModels: [
        {
          id: 'test-model',
          providerId: 'openai',
          model: 'text-embedding-3-large',
          dimension: 3,
        },
      ],
      ...settingsOverrides,
    } as never,
  })
  return { manager, app }
}

describe('VectorManager.reconcile', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
  })

  it('with VectorStore, changed files call replaceFile with chunks and embeddings', async () => {
    const vectorStore = fakeVectorStore()
    vectorStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(vectorStore, [
      { path: 'notes/a.md', mtime: 100, content: 'alpha\nbeta' },
    ])

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })

    expect(vectorStore.getIndexedFiles).toHaveBeenCalledTimes(1)
    expect(vectorStore.replaceFile).toHaveBeenCalledTimes(1)
    const [, fileWrite] = vectorStore.replaceFile.mock.calls[0]
    expect(fileWrite.path).toBe('notes/a.md')
    expect(fileWrite.mtime).toBe(100)
    expect(fileWrite.contentHash).toEqual(expect.any(String))
    expect(fileWrite.chunks).toHaveLength(1)
    expect(fileWrite.chunks[0].chunkId).toContain(
      fileWrite.chunks[0].contentHash,
    )
    expect(fileWrite.chunks[0]).toMatchObject({
      path: 'notes/a.md',
      text: 'alpha\nbeta',
      embedding: [0.1, 0.2, 0.3],
      location: {
        lineStart: 1,
        lineEnd: 2,
      },
    })
  })

  it('with VectorStore, invokes markdown splitter with configured chunkSize/chunkOverlap', async () => {
    const splitterSpy = splitMarkdownIntoChunks as jest.Mock
    splitterSpy.mockClear()
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 100, content: 'hello world' },
    ])

    await manager.reconcile(
      embeddingModel,
      { ...baseConfig, chunkOverlap: 77 },
      { scope: { kind: 'all' } },
    )

    expect(splitterSpy).toHaveBeenCalled()
    const lastCall = splitterSpy.mock.calls.at(-1)!
    expect(lastCall[1]).toBe(1000) // chunkSize
    expect(lastCall[2]).toBe(77) // chunkOverlap
  })

  it('with VectorStore, multiple changed files are embedded concurrently and written serially', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 100, content: 'alpha' },
      { path: 'notes/b.md', mtime: 200, content: 'beta' },
    ])

    let resolveEmbeddings: (() => void) | null = null
    const embeddingsReleased = new Promise<void>((resolve) => {
      resolveEmbeddings = resolve
    })
    const startedContents: string[] = []
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (content: string) => {
        startedContents.push(content)
        await embeddingsReleased
        return [0.1, 0.2, 0.3]
      })

    const reconcilePromise = manager.reconcile(
      embeddingModel,
      { ...baseConfig, embeddingConcurrency: 10 },
      { scope: { kind: 'all' } },
    )

    for (
      let attempt = 0;
      attempt < 20 && startedContents.length < 2;
      attempt++
    ) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(startedContents.sort()).toEqual(['alpha', 'beta'])
    expect(ragStore.replaceFile).not.toHaveBeenCalled()

    expect(resolveEmbeddings).not.toBeNull()
    resolveEmbeddings!()
    await reconcilePromise

    expect(ragStore.replaceFile).toHaveBeenCalledTimes(2)
    expect(
      ragStore.replaceFile.mock.calls
        .map(([, fileWrite]) => fileWrite.path)
        .sort(),
    ).toEqual(['notes/a.md', 'notes/b.md'])
  })

  it('with VectorStore, waits for active workers and queued writes after a fatal worker failure', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 100, content: 'alpha' },
      { path: 'notes/b.md', mtime: 200, content: 'beta' },
    ])

    let releaseBeta: (() => void) | null = null
    const betaReleased = new Promise<void>((resolve) => {
      releaseBeta = resolve
    })
    let resolveBetaStarted: (() => void) | null = null
    const betaStarted = new Promise<void>((resolve) => {
      resolveBetaStarted = resolve
    })
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (content: string) => {
        if (content === 'alpha') {
          throw Object.assign(new Error('service unavailable'), { status: 503 })
        }
        resolveBetaStarted?.()
        await betaReleased
        return [0.1, 0.2, 0.3]
      })

    let settled = false
    let reconcileError: unknown
    const reconcilePromise = manager
      .reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } })
      .catch((error: unknown) => {
        reconcileError = error
      })
      .finally(() => {
        settled = true
      })

    await betaStarted
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (ragStore.deleteFile.mock.calls.length > 0) break
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(ragStore.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'embedding',
        model: 'text-embedding-3-large',
      }),
      'notes/a.md',
    )
    await Promise.resolve()
    await Promise.resolve()
    const settledBeforeBetaRelease = settled

    releaseBeta!()
    await reconcilePromise

    expect(settledBeforeBetaRelease).toBe(false)
    expect(reconcileError).toMatchObject({ name: 'RagIndexIncompleteError' })
    expect(ragStore.replaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'embedding',
        model: 'text-embedding-3-large',
      }),
      expect.objectContaining({ path: 'notes/b.md' }),
    )
  })

  it('with VectorStore, starts sync progress from files with vector ready', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(
      new Map([
        ['ready.md', { mtime: 100, contentHash: 'ready-hash', updatedAt: 1 }],
        [
          'vector-only.md',
          { mtime: 100, contentHash: 'vector-only-hash', updatedAt: 1 },
        ],
      ]),
    )
    ragStore.getFileReadiness.mockResolvedValue(
      new Map([
        ['ready.md', { path: 'ready.md', vectorReady: true }],
        ['vector-only.md', { path: 'vector-only.md', vectorReady: true }],
        ['new.md', { path: 'new.md', vectorReady: false }],
      ]),
    )
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'ready.md', mtime: 100, content: 'ready' },
      { path: 'vector-only.md', mtime: 100, content: 'vector only' },
      { path: 'new.md', mtime: 200, content: 'new' },
    ])
    const onProgress = jest.fn()

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
      onProgress,
    })

    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        totalFiles: 3,
        completedFiles: 2,
      }),
    )
    expect(ragStore.replaceFile).toHaveBeenCalledTimes(1)
    expect(ragStore.replaceFile.mock.calls[0][1].path).toBe('new.md')
  })

  it('with VectorStore, reports sync progress baseline even when vector index is unchanged', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(
      new Map([
        ['ready.md', { mtime: 100, contentHash: 'ready-hash', updatedAt: 1 }],
        [
          'vector-only.md',
          { mtime: 100, contentHash: 'vector-only-hash', updatedAt: 1 },
        ],
      ]),
    )
    ragStore.getFileReadiness.mockResolvedValue(
      new Map([
        ['ready.md', { path: 'ready.md', vectorReady: true }],
        ['vector-only.md', { path: 'vector-only.md', vectorReady: true }],
      ]),
    )
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'ready.md', mtime: 100, content: 'ready' },
      { path: 'vector-only.md', mtime: 100, content: 'vector only' },
    ])
    const onProgress = jest.fn()

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
      onProgress,
    })

    // 无待处理文件时直接完成，不报中间进度（避免无变更的更新显示伪进度）
    expect(onProgress).not.toHaveBeenCalled()
    expect(ragStore.replaceFile).not.toHaveBeenCalled()
  })

  it('with VectorStore, reports real chunk progress: totalChunks > 0 and completedChunks increments to match', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const content = Array.from(
      { length: 40 },
      (_, i) => `Section ${i}: ${'y'.repeat(140)}`,
    ).join('\n\n')
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/big.md', mtime: 100, content },
      {
        path: 'notes/bigger.md',
        mtime: 200,
        content: `${content}\n\n${content}`,
      },
    ])
    const onProgress = jest.fn()

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
      onProgress,
    })

    expect(onProgress).toHaveBeenCalled()
    const completedChunkValues = onProgress.mock.calls.map(
      ([progress]) => progress.completedChunks,
    )
    const totalChunkValues = onProgress.mock.calls.map(
      ([progress]) => progress.totalChunks,
    )
    // The final emission is an exact 1:1 ratio of real chunk counts.
    expect(totalChunkValues.at(-1)).toBeGreaterThan(0)
    expect(completedChunkValues.at(-1)).toBe(totalChunkValues.at(-1))
    // Chunk counts only grow as files enter/finish the pipeline.
    expect(completedChunkValues).toEqual(
      [...completedChunkValues].sort((a, b) => a - b),
    )
    expect(Math.max(...completedChunkValues)).toBeGreaterThan(0)
  })

  it('with VectorStore, emits waitingForRateLimit while embeddings back off on a transient failure and clears it after recovery', async () => {
    const backOffMock = backOff as jest.Mock
    const originalImplementation = backOffMock.getMockImplementation()
    let retried = false
    backOffMock.mockImplementation(
      async (
        fn: () => Promise<unknown>,
        options: { retry?: (error: unknown) => boolean },
      ) => {
        try {
          return await fn()
        } catch (error) {
          if (!retried && options.retry?.(error)) {
            retried = true
            return await fn()
          }
          throw error
        }
      },
    )
    try {
      const ragStore = fakeVectorStore()
      ragStore.getIndexedFiles.mockResolvedValue(new Map())
      const { manager } = createVectorStoreManager(ragStore, [
        { path: 'notes/a.md', mtime: 100, content: 'alpha' },
      ])
      ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
        jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error('rate limited'), { status: 429 }),
          )
          .mockResolvedValue([0.1, 0.2, 0.3])
      const onProgress = jest.fn()

      await manager.reconcile(embeddingModel, baseConfig, {
        scope: { kind: 'all' },
        onProgress,
      })

      const progressCalls = onProgress.mock.calls.map(([progress]) => progress)
      expect(
        progressCalls.some((progress) => progress.waitingForRateLimit === true),
      ).toBe(true)
      // The wait flag clears once the retried embedding succeeds.
      expect(progressCalls.at(-1)!.waitingForRateLimit).toBeFalsy()
      expect(ragStore.replaceFile).toHaveBeenCalledTimes(1)
    } finally {
      backOffMock.mockImplementation(originalImplementation)
    }
  })

  it('with VectorStore, removed files call deleteFile', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(
      new Map([['gone.md', { mtime: 100, contentHash: 'gone-hash' }]]),
    )
    const { manager } = createVectorStoreManager(ragStore, [])

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })

    expect(ragStore.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'embedding',
        model: 'text-embedding-3-large',
      }),
      'gone.md',
    )
  })

  it('with VectorStore, skips 0-byte files so they do not flicker as new forever', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager, app } = createVectorStoreManager(ragStore, [
      { path: 'empty.md', mtime: 100, size: 0 },
    ])

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })

    expect(app.vault.cachedRead).not.toHaveBeenCalled()
    expect(ragStore.replaceFile).not.toHaveBeenCalled()
    expect(ragStore.deleteFile).not.toHaveBeenCalled()
  })

  it('with VectorStore, chunkify failure returns chunkifyFailedPaths and preserves old index', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(
      new Map([['notes/a.md', { mtime: 50, contentHash: 'old-hash' }]]),
    )
    const { manager, app } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 100, size: 10 },
    ])
    app.vault.cachedRead.mockRejectedValue(new Error('disk hiccup'))

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).resolves.toEqual({
      permanentFailedPaths: [],
      chunkifyFailedPaths: ['notes/a.md'],
    })

    expect(ragStore.deleteFile).not.toHaveBeenCalled()
    expect(ragStore.replaceFile).not.toHaveBeenCalled()
  })

  it('with VectorStore, PDF extraction failure returns chunkifyFailedPaths and does not replace the file with empty chunks', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(
      new Map([['notes/a.pdf', { mtime: 50, contentHash: 'old-hash' }]]),
    )
    ;(extractPdfText as jest.Mock).mockRejectedValueOnce(
      new Error('pdf parser crashed'),
    )
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.pdf', extension: 'pdf', mtime: 100, size: 1024 },
    ])

    try {
      await expect(
        manager.reconcile(
          embeddingModel,
          { ...baseConfig, indexPdf: true },
          { scope: { kind: 'all' } },
        ),
      ).resolves.toEqual({
        permanentFailedPaths: [],
        chunkifyFailedPaths: ['notes/a.pdf'],
      })

      expect(extractPdfText).toHaveBeenCalledTimes(1)
      expect(ragStore.deleteFile).not.toHaveBeenCalled()
      expect(ragStore.replaceFile).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('with VectorStore, successful PDF extraction publishes projection source once', async () => {
    ;(extractPdfText as jest.Mock).mockResolvedValueOnce({
      pages: [
        { page: 1, text: 'Page one' },
        { page: 2, text: 'Page two' },
      ],
    })
    const onPdfTextExtracted = jest.fn().mockResolvedValue(undefined)
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.pdf', extension: 'pdf', mtime: 100, size: 1024 },
    ])

    await manager.reconcile(
      embeddingModel,
      { ...baseConfig, indexPdf: true },
      {
        scope: { kind: 'all' },
        onPdfTextExtracted,
      },
    )

    expect(extractPdfText).toHaveBeenCalledTimes(1)
    const expectedContentHash = hashProjectionSource({
      kind: 'pdf',
      pages: [
        { page: 1, text: 'Page one' },
        { page: 2, text: 'Page two' },
      ],
    })
    expect(onPdfTextExtracted).toHaveBeenCalledWith({
      path: 'notes/a.pdf',
      contentHash: expectedContentHash,
      sourceParserVersion: expect.any(String),
      pages: [
        { page: 1, text: 'Page one' },
        { page: 2, text: 'Page two' },
      ],
    })
  })

  it('with VectorStore, MinerU markdown is chunked and reported as the pdf source when MinerU is enabled', async () => {
    const markdown = '# MinerU Title\n\nParagraph from MinerU conversion.'
    ;(convertPdfViaMinerU as jest.Mock).mockResolvedValue({
      markdown,
      images: [],
    })
    const onPdfTextExtracted = jest.fn().mockResolvedValue(undefined)
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(
      ragStore,
      [{ path: 'notes/a.pdf', extension: 'pdf', mtime: 100, size: 1024 }],
      {
        mineru: { enabled: true, baseUrl: 'http://localhost:7860', apiKey: '' },
      },
    )

    await manager.reconcile(
      embeddingModel,
      { ...baseConfig, indexPdf: true },
      {
        scope: { kind: 'all' },
        onPdfTextExtracted,
      },
    )

    expect(convertPdfViaMinerU).toHaveBeenCalledTimes(1)
    expect(convertPdfViaMinerU).toHaveBeenCalledWith(
      expect.objectContaining({
        app: expect.anything(),
        file: expect.objectContaining({ path: 'notes/a.pdf' }),
        options: {
          enabled: true,
          baseUrl: 'http://localhost:7860',
          apiKey: '',
        },
        settings: expect.objectContaining({
          mineru: {
            enabled: true,
            baseUrl: 'http://localhost:7860',
            apiKey: '',
          },
        }),
      }),
    )
    expect(extractPdfText).not.toHaveBeenCalled()
    expect(onPdfTextExtracted).toHaveBeenCalledWith({
      path: 'notes/a.pdf',
      contentHash: hashProjectionSource({ kind: 'markdown', text: markdown }),
      sourceParserVersion: expect.any(String),
      pages: [{ page: 1, text: markdown }],
    })
    // Chunks come from the MinerU markdown.
    expect(ragStore.replaceFile).toHaveBeenCalledTimes(1)
    const [, fileWrite] = ragStore.replaceFile.mock.calls[0]
    expect(
      (fileWrite.chunks as Array<{ text: string }>)
        .map((chunk) => chunk.text)
        .join('\n'),
    ).toContain('MinerU Title')
  })

  it('with VectorStore, falls back to extractPdfText when MinerU conversion fails', async () => {
    ;(convertPdfViaMinerU as jest.Mock).mockRejectedValue(
      new Error('mineru service unavailable'),
    )
    ;(extractPdfText as jest.Mock).mockResolvedValueOnce({
      pages: [{ page: 1, text: 'Page one' }],
    })
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(
      ragStore,
      [{ path: 'notes/a.pdf', extension: 'pdf', mtime: 100, size: 1024 }],
      {
        mineru: { enabled: true, baseUrl: 'http://localhost:7860', apiKey: '' },
      },
    )

    await manager.reconcile(
      embeddingModel,
      { ...baseConfig, indexPdf: true },
      { scope: { kind: 'all' } },
    )

    expect(convertPdfViaMinerU).toHaveBeenCalledTimes(1)
    expect(extractPdfText).toHaveBeenCalledTimes(1)
  })

  it('with VectorStore, transient embedding failure rolls back the file and throws RagIndexIncompleteError', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 100, content: 'alpha' },
    ])
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('service unavailable'), { status: 503 }),
        )

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).rejects.toMatchObject({ name: 'RagIndexIncompleteError' })

    expect(ragStore.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'embedding',
        model: 'text-embedding-3-large',
      }),
      'notes/a.md',
    )
    expect(ragStore.replaceFile).not.toHaveBeenCalled()
  })

  it('with VectorStore, permanent-only embedding failure returns permanentFailedPaths without rollback', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const content = `${'A'.repeat(900)}\n\n${'B'.repeat(900)}`
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 100, content },
    ])
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (chunkContent: string) => {
        if (chunkContent.includes('A')) {
          throw Object.assign(new Error('bad request'), { status: 400 })
        }
        return [0.1, 0.2, 0.3]
      })

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).resolves.toEqual({
      permanentFailedPaths: ['notes/a.md'],
      chunkifyFailedPaths: [],
    })

    expect(ragStore.deleteFile).not.toHaveBeenCalled()
    expect(ragStore.replaceFile).toHaveBeenCalledTimes(1)
  })

  it('with VectorStore, whole-file permanent failure writes an empty file write that advances mtime, so the next reconcile skips the file', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 100, content: 'alpha' },
    ])
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('bad request'), { status: 400 }),
        )

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).resolves.toEqual({
      permanentFailedPaths: ['notes/a.md'],
      chunkifyFailedPaths: [],
    })

    // Even with zero embedded chunks the write is enqueued: `replaceFile`
    // advances the stored mtime so the incremental diff skips the file on
    // later reconciles instead of re-embedding the doomed chunks.
    expect(ragStore.replaceFile).toHaveBeenCalledTimes(1)
    const [, fileWrite] = ragStore.replaceFile.mock.calls[0]
    expect(fileWrite.path).toBe('notes/a.md')
    expect(fileWrite.mtime).toBe(100)
    expect(fileWrite.chunks).toEqual([])

    // Simulate the DB having applied the write: the file now reports the new
    // mtime, so the second reconcile must NOT re-embed it (and must not write
    // again).
    ragStore.getIndexedFiles.mockResolvedValue(
      new Map([['notes/a.md', { mtime: 100, contentHash: 'hash' }]]),
    )
    ragStore.getFileReadiness.mockResolvedValue(
      new Map([['notes/a.md', { path: 'notes/a.md', vectorReady: false }]]),
    )
    const embedSpy = (embeddingModel as unknown as { getEmbedding: jest.Mock })
      .getEmbedding
    embedSpy.mockClear()
    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })
    expect(embedSpy).not.toHaveBeenCalled()
    expect(ragStore.replaceFile).toHaveBeenCalledTimes(1)
  })

  it('with VectorStore, abandons remaining files after consecutive permanent embedding failures', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `notes/f${String(index).padStart(2, '0')}.md`,
      mtime: 100 + index,
      content: `file ${index}`,
    }))
    const { manager } = createVectorStoreManager(ragStore, files)
    const embedSpy = (embeddingModel as unknown as { getEmbedding: jest.Mock })
      .getEmbedding
    embedSpy.mockRejectedValue(
      Object.assign(new Error('bad request'), { status: 400 }),
    )

    await expect(
      manager.reconcile(
        embeddingModel,
        { ...baseConfig, embeddingConcurrency: 1 },
        { scope: { kind: 'all' } },
      ),
    ).rejects.toMatchObject({ name: 'RagIndexAbandonedError' })

    // The first 5 files were attempted (2 batch attempts each) and written as
    // permanent failures; the remaining 7 files were never touched.
    expect(embedSpy.mock.calls.map(([content]) => content)).toEqual([
      'file 0',
      'file 0',
      'file 1',
      'file 1',
      'file 2',
      'file 2',
      'file 3',
      'file 3',
      'file 4',
      'file 4',
    ])
    expect(ragStore.replaceFile).toHaveBeenCalledTimes(5)
    expect(
      ragStore.replaceFile.mock.calls
        .map(([, fileWrite]) => fileWrite.path)
        .sort(),
    ).toEqual([
      'notes/f00.md',
      'notes/f01.md',
      'notes/f02.md',
      'notes/f03.md',
      'notes/f04.md',
    ])
  })

  it('with VectorStore, does not abandon when a file succeeds between permanent failures', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const files = Array.from({ length: 9 }, (_, index) => ({
      path: `notes/f${String(index).padStart(2, '0')}.md`,
      mtime: 100 + index,
      content: index === 4 ? 'success 4' : `fail ${index}`,
    }))
    const { manager } = createVectorStoreManager(ragStore, files)
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (chunkContent: string) => {
        if (chunkContent.includes('success')) {
          return [0.1, 0.2, 0.3]
        }
        throw Object.assign(new Error('bad request'), { status: 400 })
      })

    await expect(
      manager.reconcile(
        embeddingModel,
        { ...baseConfig, embeddingConcurrency: 1 },
        { scope: { kind: 'all' } },
      ),
    ).resolves.toEqual({
      permanentFailedPaths: [
        'notes/f00.md',
        'notes/f01.md',
        'notes/f02.md',
        'notes/f03.md',
        'notes/f05.md',
        'notes/f06.md',
        'notes/f07.md',
        'notes/f08.md',
      ],
      chunkifyFailedPaths: [],
    })

    // Every file was attempted: the success in the middle reset the
    // consecutive-failure counter so the run completed normally.
    expect(ragStore.replaceFile).toHaveBeenCalledTimes(9)
  })

  it('with VectorStore, truncate calls clearNamespace', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 100, content: 'hello' },
    ])

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
      truncate: true,
    })

    expect(ragStore.clearNamespace).toHaveBeenCalledTimes(1)
  })

  it('with VectorStore, similarity search maps hits to the legacy row shape', async () => {
    const ragStore = fakeVectorStore()
    ragStore.search.mockResolvedValue({
      hits: [
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
            startLine: 4,
            endLine: 6,
            page: 2,
          },
        },
      ],
      recallCount: 1,
      recallLimit: 10,
    })

    const manager = new VectorManager({} as never, {} as never, {
      vectorStore: ragStore,
      settings: {
        embeddingModels: [
          {
            id: 'test-model',
            providerId: 'openai',
            model: 'text-embedding-3-large',
            dimension: 3,
          },
        ],
      } as never,
    })

    const result = await manager.performSimilaritySearch(
      [0.1, 0.2, 0.3],
      embeddingModel,
      {
        minSimilarity: 0.5,
        limit: 3,
        scope: { files: ['notes/a.md'], folders: [] },
      },
    )

    expect(ragStore.search).toHaveBeenCalledTimes(1)
    expect(result.rows).toEqual([
      expect.objectContaining({
        id: 1,
        path: 'notes/a.md',
        content: 'matched text',
        similarity: 0.91,
        model: 'test-model',
        dimension: 3,
        metadata: {
          startLine: 4,
          endLine: 6,
          page: 2,
        },
      }),
    ])
    expect(result.trace).toBeUndefined()
  })

  it('performSimilaritySearch uses detailed vector timings when VectorStore.searchDetailed is available', async () => {
    const ragStore = fakeVectorStore()
    ;(ragStore.searchDetailed as jest.Mock).mockResolvedValue({
      hits: [
        {
          id: 'chunk-1',
          chunkId: 'chunk-1',
          path: 'notes/a.md',
          excerpt: 'matched text',
          score: 0.91,
          source: 'vector',
          location: { lineStart: 4, lineEnd: 6, page: 2 },
          metadataJson: { startLine: 4, endLine: 6, page: 2 },
        },
      ],
      timingsMs: {
        coarseSearch: 12,
        loadFullVectors: 8,
        rerankSimilarity: 3,
      },
    })
    const manager = new VectorManager({} as never, {} as never, {
      vectorStore: ragStore,
      settings: {
        embeddingModels: [
          {
            id: 'test-model',
            providerId: 'openai',
            model: 'text-embedding-3-large',
            dimension: 3,
          },
        ],
      } as never,
    })

    const result = await manager.performSimilaritySearch(
      [0.1, 0.2, 0.3],
      embeddingModel,
      {
        minSimilarity: 0.5,
        limit: 3,
      },
    )

    expect(ragStore.searchDetailed as jest.Mock).toHaveBeenCalledTimes(1)
    expect(ragStore.search).not.toHaveBeenCalled()
    expect(result.trace).toEqual({
      coarseSearchMs: 12,
      loadFullVectorsMs: 8,
      rerankSimilarityMs: 3,
    })
  })
})

describe('VectorManager.clearAllVectors / clearVectorsByModelIds', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('clears vectors for a model via the derived namespace, not the model id', async () => {
    const vectorStore = fakeVectorStore()
    const { manager } = createVectorStoreManager(vectorStore, [])

    await manager.clearAllVectors(embeddingModel as never)

    // Namespace keys are `<model>-d<dimension>`; comparing the model id
    // against them never matched, so the previous implementation dropped
    // nothing. The fix derives the namespace from settings and drops it.
    expect(vectorStore.dropNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'embedding',
        model: 'text-embedding-3-large',
        dimension: 3,
      }),
    )
    expect(vectorStore.dropNamespaceById).not.toHaveBeenCalled()
  })

  it('clears all namespaces when no model is given', async () => {
    const vectorStore = fakeVectorStore()
    vectorStore.listNamespaces.mockResolvedValue(['a-d3', 'b-d768'])
    const { manager } = createVectorStoreManager(vectorStore, [])

    await manager.clearAllVectors()

    expect(vectorStore.dropNamespaceById).toHaveBeenCalledWith('a-d3')
    expect(vectorStore.dropNamespaceById).toHaveBeenCalledWith('b-d768')
  })

  it('clears vectors by model ids resolved through settings', async () => {
    const vectorStore = fakeVectorStore()
    const { manager } = createVectorStoreManager(vectorStore, [])

    await manager.clearVectorsByModelIds(['test-model'])

    expect(vectorStore.dropNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'text-embedding-3-large',
        dimension: 3,
      }),
    )
  })
})

describe('VectorManager incremental mtime and empty-file handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
  })

  it('re-indexes a file modified during the previous index run (window-internal change)', async () => {
    const ragStore = fakeVectorStore()
    // The file was indexed at mtime 100, but the index WRITE finished much
    // later (updatedAt = 200s): comparing against updated_at would judge the
    // file (now mtime 150) as "unchanged" and skip it forever.
    ragStore.getIndexedFiles.mockResolvedValue(
      new Map([
        ['notes/a.md', { mtime: 100, contentHash: 'old-hash', updatedAt: 200 }],
      ]),
    )
    ragStore.getFileReadiness.mockResolvedValue(
      new Map([['notes/a.md', { path: 'notes/a.md', vectorReady: true }]]),
    )
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/a.md', mtime: 150, content: 'changed during run' },
    ])

    await manager.reconcile(embeddingModel as never, baseConfig, {
      scope: { kind: 'all' },
    })

    expect(ragStore.replaceFile).toHaveBeenCalledTimes(1)
  })

  it('deletes stale index rows for a file that was emptied', async () => {
    const ragStore = fakeVectorStore()
    ragStore.getIndexedFiles.mockResolvedValue(
      new Map([['notes/empty.md', { mtime: 100, contentHash: 'old-hash' }]]),
    )
    ragStore.getFileReadiness.mockResolvedValue(new Map())
    const { manager } = createVectorStoreManager(ragStore, [
      { path: 'notes/empty.md', mtime: 100, content: '', size: 0 },
    ])

    await manager.reconcile(embeddingModel as never, baseConfig, {
      scope: { kind: 'all' },
    })

    // An emptied file cannot be chunkified, but its old rows must be removed
    // so retrieval stops returning content that no longer exists.
    expect(ragStore.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'embedding',
        model: 'text-embedding-3-large',
      }),
      'notes/empty.md',
    )
  })
})
