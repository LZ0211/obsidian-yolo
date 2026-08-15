import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

import { getSqliteDbPath } from './backendPaths'
import { vectorNamespaceId } from './namespaceId'
import { SQLITE_COARSE_DIMENSION } from './SqliteSchema'
import { SqliteVectorStore } from './SqliteVectorStore'
import {
  type VectorFileWrite,
  type VectorNamespace,
  VectorStoreError,
} from './VectorStore'

const requireNode = createRequire(__filename)

const namespace: VectorNamespace = {
  provider: 'openai',
  model: 'text-embedding-3-large',
  dimension: 4,
  distanceMetric: 'cosine',
}

function createTempStoreRoot() {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'sqlite-rag-store-test-'),
  )
  const baseDir = path.join(rootDir, 'data')
  fs.mkdirSync(baseDir, { recursive: true })
  return { rootDir, baseDir }
}

function createStore(baseDir: string) {
  return new SqliteVectorStore({ baseDir })
}

function openRawDb(dbPath: string) {
  const { DatabaseSync } = requireNode('node:sqlite') as {
    DatabaseSync: new (filename: string) => {
      exec(sql: string): void
      prepare(sql: string): {
        all(): unknown[]
        get(...params: unknown[]): unknown
        run(...params: unknown[]): unknown
      }
      close(): void
    }
  }
  return new DatabaseSync(dbPath)
}

function chunk(
  chunkId: string,
  text: string,
  embedding: number[],
  lineStart: number,
): VectorFileWrite['chunks'][number] {
  return {
    chunkId,
    path: 'notes/a.md',
    text,
    contentHash: `${chunkId}-hash`,
    embedding,
    location: {
      lineStart,
      lineEnd: lineStart + 1,
      headingPath: ['Heading'],
    },
    metadataJson: {
      title: `Title ${chunkId}`,
    },
  }
}

function fileWrite(chunks: VectorFileWrite['chunks']): VectorFileWrite {
  return {
    path: 'notes/a.md',
    mtime: 123,
    contentHash: 'file-hash',
    chunks,
  }
}

describe('SqliteVectorStore persistence', () => {
  test('open is idempotent and methods before open reject not_open', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)

    await expect(store.listNamespaces()).rejects.toMatchObject({
      code: 'not_open',
      backend: 'sqlite',
    })
    await expect(store.getStatus(namespace)).rejects.toMatchObject({
      code: 'not_open',
    })
    await expect(store.getIndexedFiles(namespace)).rejects.toMatchObject({
      code: 'not_open',
    })
    await expect(
      store.replaceFile(namespace, fileWrite([])),
    ).rejects.toMatchObject({
      code: 'not_open',
    })
    await expect(
      store.deleteFile(namespace, 'notes/a.md'),
    ).rejects.toMatchObject({
      code: 'not_open',
    })
    await expect(store.clearNamespace(namespace)).rejects.toMatchObject({
      code: 'not_open',
    })
    await expect(store.vacuum()).rejects.toMatchObject({
      code: 'not_open',
    })
    await expect(
      store.search(namespace, [1, 0, 0, 0], { topK: 1 }),
    ).rejects.toMatchObject({
      code: 'not_open',
    })

    await store.open()
    await store.open()
    expect((await store.getStatus()).readiness).toBe('ready')
    expect(await store.getStatus(namespace)).toMatchObject({
      readiness: 'ready',
      rebuildRequired: true,
    })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('aggregate getStatus reports no storage path and never implies a placeholder namespace file', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    // Without an embedding model there is no namespace: the status must not
    // fabricate a plausible path — the maintenance explorer used to take that
    // placeholder and CREATE a garbage SQLite file at it.
    const status = await store.getStatus()
    expect(status.storagePath).toBe('')
    expect(status.readiness).toBe('ready')
    expect(status.rebuildRequired).toBe(false)
    expect(fs.existsSync(path.join(baseDir, 'rag', '<namespace>'))).toBe(false)

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('rolls back a partially failing schema migration', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const dbPath = getSqliteDbPath(baseDir, vectorNamespaceId(namespace))
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = openRawDb(dbPath)
    try {
      db.exec('create table rag_files (id text primary key)')
    } finally {
      db.close()
    }

    const store = createStore(baseDir)
    await store.open()
    await expect(store.replaceFile(namespace, fileWrite([]))).rejects.toThrow()

    const checkDb = openRawDb(dbPath)
    try {
      const namespaceTable = checkDb
        .prepare(
          "select name from sqlite_master where type = 'table' and name = 'rag_namespaces'",
        )
        .get()
      const version = checkDb.prepare('PRAGMA user_version').get() as {
        user_version?: number
      }
      expect(namespaceTable).toBeUndefined()
      expect(version.user_version).toBe(0)
    } finally {
      checkDb.close()
    }

    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('reopens when open is requested while close is still waiting for readers', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()
    await store.replaceFile(namespace, fileWrite([]))

    const internals = store as unknown as {
      namespaceStates: Map<string, { activeReaders: number }>
      drainNamespaceGate: (state: { activeReaders: number }) => void
    }
    const state = internals.namespaceStates.get(vectorNamespaceId(namespace))
    expect(state).toBeDefined()
    state!.activeReaders = 1

    const closePromise = store.close()
    await Promise.resolve()
    const reopenPromise = store.open()

    state!.activeReaders = 0
    internals.drainNamespaceGate(state!)

    await closePromise
    await reopenPromise
    await expect(store.getStatus()).resolves.toMatchObject({
      readiness: 'ready',
    })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('rejects new operations as soon as close is requested', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    const closePromise = store.close()
    await expect(store.getStatus()).rejects.toMatchObject({
      code: 'closing',
      backend: 'sqlite',
    })

    await closePromise
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('search on a missing namespace database throws rebuild_required without creating a file', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    const dbPath = getSqliteDbPath(baseDir, vectorNamespaceId(namespace))
    expect(fs.existsSync(dbPath)).toBe(false)

    await expect(store.getStatus(namespace)).resolves.toMatchObject({
      readiness: 'ready',
      rebuildRequired: true,
      recoveryAction: 'rebuild_index',
    })

    await expect(
      store.search(namespace, [1, 0, 0, 0], { topK: 3 }),
    ).rejects.toMatchObject({
      code: 'rebuild_required',
      backend: 'sqlite',
      recoveryAction: 'rebuild_index',
    })

    expect(fs.existsSync(dbPath)).toBe(false)

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('reuses the existing index across embedding endpoint changes (same model)', async () => {
    // 命名空间只按模型+维度键控：同一模型换 endpoint 必须沿用既有索引，
    // 而不是另建空 namespace 触发全量重建。
    const { rootDir, baseDir } = createTempStoreRoot()
    const indexDbPath = getSqliteDbPath(baseDir, vectorNamespaceId(namespace))

    const legacyStore = createStore(baseDir)
    await legacyStore.open()
    await legacyStore.replaceFile(
      namespace,
      fileWrite([chunk('legacy-chunk', 'legacy vector text', [1, 0, 0, 0], 1)]),
    )
    await legacyStore.close()

    const store = createStore(baseDir)
    await store.open()
    try {
      await expect(store.getStatus(namespace)).resolves.toMatchObject({
        rebuildRequired: false,
        recoveryAction: 'none',
      })
      expect(fs.existsSync(indexDbPath)).toBe(true)
    } finally {
      await store.close()
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('search scoped to a folder with no indexed chunks returns an empty result, not rebuild_required', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([chunk('chunk-1', 'alpha paragraph', [1, 0, 0, 0], 1)]),
    )

    // The namespace has data, but the query scope excludes every indexed
    // file — that is a legitimate empty result, not a missing index.
    const result = await store.searchDetailed(namespace, [1, 0, 0, 0], {
      topK: 3,
      scope: { files: [], folders: ['unindexed-folder'] },
    })
    expect(result.hits).toEqual([])

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('isolates identical path and chunk ids across Vault and conversation corpora', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    const historyNamespace: VectorNamespace = {
      ...namespace,
      corpus: 'conversation-history-v1',
    }
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([chunk('shared-chunk', 'vault-only text', [1, 0, 0, 0], 1)]),
    )
    await store.replaceFile(
      historyNamespace,
      fileWrite([chunk('shared-chunk', 'history-only text', [1, 0, 0, 0], 1)]),
    )

    await expect(
      store
        .search(namespace, [1, 0, 0, 0], { topK: 1 })
        .then((result) => result.hits.map((hit) => hit.excerpt)),
    ).resolves.toEqual(['vault-only text'])
    await expect(
      store
        .search(historyNamespace, [1, 0, 0, 0], { topK: 1 })
        .then((result) => result.hits.map((hit) => hit.excerpt)),
    ).resolves.toEqual(['history-only text'])

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('search rejects non-vector retrieval modes instead of silently falling back', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([chunk('chunk-1', 'alpha paragraph', [1, 0, 0, 0], 1)]),
    )

    await expect(
      store.search(namespace, [1, 0, 0, 0], {
        topK: 1,
        retrievalMode: 'lexical',
      } as { topK: number; retrievalMode: string }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      backend: 'sqlite',
      recoveryAction: 'none',
    })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('replaceFile/search/delete/clear/close/reopen use a real sqlite file', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([
        chunk('chunk-1', 'alpha paragraph', [1, 0, 0, 0], 1),
        chunk('chunk-2', 'beta paragraph', [0, 1, 0, 0], 3),
      ]),
    )

    expect(await store.listNamespaces()).toEqual([vectorNamespaceId(namespace)])
    expect(await store.getIndexedFiles(namespace)).toEqual(
      new Map([
        [
          'notes/a.md',
          {
            mtime: 123,
            contentHash: 'file-hash',
            updatedAt: expect.any(Number),
          },
        ],
      ]),
    )

    let stats = await store.getStats(namespace)
    expect(stats.fileCount).toBe(1)
    expect(stats.chunkCount).toBe(2)
    expect(stats.usesWholeDatabaseSnapshot).toBe(false)

    let hits = (await store.search(namespace, [1, 0, 0, 0], { topK: 2 })).hits
    expect(hits).toHaveLength(2)
    expect(hits[0]?.chunkId).toBe('chunk-1')
    expect(hits[0]?.score).toBe(1)

    const detailed = await store.searchDetailed(namespace, [1, 0, 0, 0], {
      topK: 2,
    })
    expect(detailed.hits).toHaveLength(2)
    expect(detailed.timingsMs).toEqual(
      expect.objectContaining({
        coarseSearch: expect.any(Number),
        loadFullVectors: expect.any(Number),
        rerankSimilarity: expect.any(Number),
      }),
    )

    hits = (
      await store.search(namespace, [1, 0, 0, 0], {
        topK: 2,
        minSimilarity: 0.5,
      })
    ).hits
    expect(hits.map((hit) => hit.chunkId)).toEqual(['chunk-1'])

    await store.replaceFile(
      namespace,
      fileWrite([chunk('chunk-3', 'gamma paragraph', [0, 0, 1, 0], 5)]),
    )
    stats = await store.getStats(namespace)
    expect(stats.fileCount).toBe(1)
    expect(stats.chunkCount).toBe(1)
    expect(
      (await store.search(namespace, [0, 0, 1, 0], { topK: 5 })).hits[0]
        ?.chunkId,
    ).toBe('chunk-3')

    await expect(
      store.replaceFile(
        namespace,
        fileWrite([
          chunk('chunk-dup', 'first dup', [1, 0, 0, 0], 1),
          chunk('chunk-dup', 'second dup', [0, 1, 0, 0], 3),
        ]),
      ),
    ).rejects.toBeInstanceOf(VectorStoreError)

    expect(
      (await store.search(namespace, [0, 0, 1, 0], { topK: 5 })).hits[0]
        ?.chunkId,
    ).toBe('chunk-3')

    await store.replaceFile(namespace, fileWrite([]))
    stats = await store.getStats(namespace)
    expect(stats.fileCount).toBe(1)
    expect(stats.chunkCount).toBe(0)

    const dbPath = getSqliteDbPath(baseDir, vectorNamespaceId(namespace))
    expect(fs.existsSync(dbPath)).toBe(true)

    await store.deleteFile(namespace, 'notes/a.md')
    await store.deleteFile(namespace, 'notes/a.md')
    stats = await store.getStats(namespace)
    expect(stats.fileCount).toBe(0)
    expect(stats.chunkCount).toBe(0)

    await store.replaceFile(
      namespace,
      fileWrite([chunk('chunk-4', 'delta paragraph', [0, 0, 0, 1], 7)]),
    )
    await store.clearNamespace(namespace)
    stats = await store.getStats(namespace)
    expect(stats.fileCount).toBe(0)
    expect(stats.chunkCount).toBe(0)
    expect(stats.namespaceCount).toBe(1)
    expect(fs.existsSync(dbPath)).toBe(true)

    await store.replaceFile(
      namespace,
      fileWrite([chunk('chunk-5', 'epsilon paragraph', [1, 0, 0, 0], 9)]),
    )
    await store.close()

    const reopened = createStore(baseDir)
    await reopened.open()
    expect(
      (await reopened.search(namespace, [1, 0, 0, 0], { topK: 5 })).hits[0]
        ?.chunkId,
    ).toBe('chunk-5')
    await reopened.close()

    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('reports per-file vector readiness', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(namespace, {
      path: 'ready/a.md',
      mtime: 1,
      chunks: [
        {
          chunkId: 'ready-a',
          path: 'ready/a.md',
          text: 'ready lexical token',
          contentHash: 'ready-a-hash',
          embedding: [1, 0, 0, 0],
          location: {},
          metadataJson: {},
        },
      ],
    })

    const initial = await store.getFileReadiness(namespace, [
      'ready/a.md',
      'missing.md',
    ])
    expect(initial.get('ready/a.md')).toEqual({
      path: 'ready/a.md',
      vectorReady: true,
    })
    expect(initial.get('missing.md')).toEqual({
      path: 'missing.md',
      vectorReady: false,
    })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('normalizes vectors so cosine semantics are stable', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([
        chunk('long-same-direction', 'long same direction', [10, 0, 0, 0], 1),
        chunk('unit-same-direction', 'unit same direction', [1, 0, 0, 0], 3),
        chunk('orthogonal', 'orthogonal', [0, 10, 0, 0], 5),
      ]),
    )

    const hits = (await store.search(namespace, [5, 0, 0, 0], { topK: 3 })).hits

    expect(
      hits
        .slice(0, 2)
        .map((hit) => hit.chunkId)
        .sort(),
    ).toEqual(['long-same-direction', 'unit-same-direction'])
    expect(hits[2]?.chunkId).toBe('orthogonal')
    expect(hits[0]?.score).toBeCloseTo(1)
    expect(hits[1]?.score).toBeCloseTo(1)
    expect(hits[2]?.score).toBeCloseTo(0)

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('folder scope treats _, %, and backslash literally in LIKE patterns', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFiles(namespace, [
      {
        path: 'notes_100/a.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'under',
            path: 'notes_100/a.md',
            text: 'under',
            contentHash: 'under-hash',
            embedding: [1, 0, 0, 0],
            location: {},
            metadataJson: { title: 'under' },
          },
        ],
      },
      {
        path: 'notesX100/b.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'wildcard-underscore',
            path: 'notesX100/b.md',
            text: 'wildcard underscore',
            contentHash: 'wildcard-underscore-hash',
            embedding: [0, 1, 0, 0],
            location: {},
            metadataJson: { title: 'wildcard underscore' },
          },
        ],
      },
      {
        path: 'budget%2026/c.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'percent',
            path: 'budget%2026/c.md',
            text: 'percent',
            contentHash: 'percent-hash',
            embedding: [0, 0, 1, 0],
            location: {},
            metadataJson: { title: 'percent' },
          },
        ],
      },
      {
        path: 'budgetX2026/d.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'wildcard-percent',
            path: 'budgetX2026/d.md',
            text: 'wildcard percent',
            contentHash: 'wildcard-percent-hash',
            embedding: [0, 0, 0, 1],
            location: {},
            metadataJson: { title: 'wildcard percent' },
          },
        ],
      },
      {
        path: 'literal\\slash/e.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'backslash',
            path: 'literal\\slash/e.md',
            text: 'backslash',
            contentHash: 'backslash-hash',
            embedding: [1, 1, 0, 0],
            location: {},
            metadataJson: { title: 'backslash' },
          },
        ],
      },
      {
        path: 'literalslash/f.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'wildcard-backslash',
            path: 'literalslash/f.md',
            text: 'wildcard backslash',
            contentHash: 'wildcard-backslash-hash',
            embedding: [0, 1, 1, 0],
            location: {},
            metadataJson: { title: 'wildcard backslash' },
          },
        ],
      },
    ])

    await expect(
      store
        .search(namespace, [1, 0, 0, 0], {
          topK: 5,
          scope: { folders: ['notes_100'] },
        })
        .then((result) => result.hits.map((hit) => hit.chunkId)),
    ).resolves.toEqual(['under'])

    await expect(
      store
        .search(namespace, [0, 0, 1, 0], {
          topK: 5,
          scope: { folders: ['budget%2026'] },
        })
        .then((result) => result.hits.map((hit) => hit.chunkId)),
    ).resolves.toEqual(['percent'])

    await expect(
      store
        .search(namespace, [1, 1, 0, 0], {
          topK: 5,
          scope: { folders: ['literal\\slash'] },
        })
        .then((result) => result.hits.map((hit) => hit.chunkId)),
    ).resolves.toEqual(['backslash'])

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('search treats empty files and folders scope arrays as full namespace search', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFiles(namespace, [
      {
        path: 'src/a.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'src-a',
            path: 'src/a.md',
            text: 'alpha token',
            contentHash: 'src-a-hash',
            embedding: [1, 0, 0, 0],
            location: {},
            metadataJson: { title: 'A' },
          },
        ],
      },
      {
        path: 'docs/b.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'docs-b',
            path: 'docs/b.md',
            text: 'beta token',
            contentHash: 'docs-b-hash',
            embedding: [0, 1, 0, 0],
            location: {},
            metadataJson: { title: 'B' },
          },
        ],
      },
    ])

    await expect(
      store
        .search(namespace, [1, 1, 0, 0], {
          topK: 10,
          scope: { files: [], folders: [] },
        })
        .then((result) => result.hits.map((hit) => hit.chunkId).sort()),
    ).resolves.toEqual(['docs-b', 'src-a'])

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('replaceFiles prewarms coarse cache in background when cache fits memory budget', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFiles(namespace, [
      {
        path: 'src/a.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'src-a',
            path: 'src/a.md',
            text: 'alpha token',
            contentHash: 'src-a-hash',
            embedding: [1, 0, 0, 0],
            location: {},
            metadataJson: { title: 'A' },
          },
        ],
      },
      {
        path: 'docs/b.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'docs-b',
            path: 'docs/b.md',
            text: 'beta token',
            contentHash: 'docs-b-hash',
            embedding: [0, 1, 0, 0],
            location: {},
            metadataJson: { title: 'B' },
          },
        ],
      },
    ])

    await new Promise((resolve) => setTimeout(resolve, 250))

    const state = (
      store as unknown as {
        namespaceStates: Map<
          string,
          { coarseCache?: { rows: unknown[]; memoryBytes: number } }
        >
      }
    ).namespaceStates.get(vectorNamespaceId(namespace))

    expect(state?.coarseCache?.rows).toHaveLength(2)
    expect(state?.coarseCache?.memoryBytes).toBeGreaterThan(0)

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('open prewarms coarse cache for existing namespace databases in background', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()
    await store.replaceFiles(namespace, [
      {
        path: 'src/a.md',
        mtime: 1,
        chunks: [
          {
            chunkId: 'src-a',
            path: 'src/a.md',
            text: 'alpha token',
            contentHash: 'src-a-hash',
            embedding: [1, 0, 0, 0],
            location: {},
            metadataJson: { title: 'A' },
          },
        ],
      },
    ])
    await store.close()

    const reopened = createStore(baseDir)
    await reopened.open()
    await new Promise((resolve) => setTimeout(resolve, 250))

    const state = (
      reopened as unknown as {
        namespaceStates: Map<
          string,
          { coarseCache?: { rows: unknown[]; memoryBytes: number } }
        >
      }
    ).namespaceStates.get(vectorNamespaceId(namespace))

    expect(state?.coarseCache?.rows).toHaveLength(1)
    expect(state?.coarseCache?.memoryBytes).toBeGreaterThan(0)

    await reopened.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('search rejects corrupt non-object metadata_json with database_corrupt', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([chunk('chunk-corrupt-metadata', 'metadata', [1, 0, 0, 0], 1)]),
    )

    const dbPath = getSqliteDbPath(baseDir, vectorNamespaceId(namespace))
    const db = openRawDb(dbPath)
    try {
      db.prepare(
        'update rag_chunks set metadata_json = ? where chunk_id = ?',
      ).run('"broken"', 'chunk-corrupt-metadata')
    } finally {
      db.close()
    }

    await expect(
      store.search(namespace, [1, 0, 0, 0], { topK: 1 }),
    ).rejects.toMatchObject({
      code: 'database_corrupt',
      backend: 'sqlite',
      recoveryAction: 'rebuild_index',
    })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('search rejects malformed full embedding blobs with database_corrupt instead of NaN', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([chunk('chunk-bad-full-blob', 'blob', [1, 0, 0, 0], 1)]),
    )

    const dbPath = getSqliteDbPath(baseDir, vectorNamespaceId(namespace))
    const db = openRawDb(dbPath)
    try {
      db.prepare('update rag_embeddings set embedding = ? where rowid = 1').run(
        Buffer.from([0, 0, 0]),
      )
    } finally {
      db.close()
    }

    await expect(
      store.search(namespace, [1, 0, 0, 0], { topK: 1 }),
    ).rejects.toMatchObject({
      code: 'database_corrupt',
      backend: 'sqlite',
      recoveryAction: 'rebuild_index',
    })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('search rejects malformed coarse embedding blobs with database_corrupt', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([chunk('chunk-bad-coarse-blob', 'blob', [1, 0, 0, 0], 1)]),
    )

    const dbPath = getSqliteDbPath(baseDir, vectorNamespaceId(namespace))
    const db = openRawDb(dbPath)
    try {
      db.prepare(
        'update rag_coarse_embeddings set embedding = ? where rowid = 1',
      ).run(
        Buffer.alloc(
          (Math.min(SQLITE_COARSE_DIMENSION, namespace.dimension) - 1) * 4,
        ),
      )
    } finally {
      db.close()
    }

    await expect(
      store.search(namespace, [1, 0, 0, 0], { topK: 1 }),
    ).rejects.toMatchObject({
      code: 'database_corrupt',
      backend: 'sqlite',
      recoveryAction: 'rebuild_index',
    })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('search rejects future schema versions before mutating user_version', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const namespaceKey = vectorNamespaceId(namespace)
    const dbPath = getSqliteDbPath(baseDir, namespaceKey)
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    const db = openRawDb(dbPath)
    try {
      db.exec('PRAGMA user_version = 999')
    } finally {
      db.close()
    }

    const store = createStore(baseDir)
    await store.open()

    await expect(store.getStats(namespace)).resolves.toMatchObject({
      ready: false,
      errorCode: 'incompatible_schema',
    })

    const checkDb = openRawDb(dbPath)
    try {
      const version = checkDb.prepare('PRAGMA user_version').get() as {
        user_version?: number
      }
      expect(version.user_version).toBe(999)
    } finally {
      checkDb.close()
    }

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('stores rag_chunks rowid equal to coarse and full embedding rowids', async () => {
    const { rootDir, baseDir } = createTempStoreRoot()
    const store = createStore(baseDir)
    await store.open()

    await store.replaceFile(
      namespace,
      fileWrite([
        chunk('stable-rowid-a', 'stable rowid a', [1, 0, 0, 0], 1),
        chunk('stable-rowid-b', 'stable rowid b', [0, 1, 0, 0], 3),
      ]),
    )
    await store.close()

    const dbPath = getSqliteDbPath(baseDir, vectorNamespaceId(namespace))
    const { DatabaseSync } = requireNode('node:sqlite') as {
      DatabaseSync: new (filename: string) => {
        prepare(sql: string): { all(): unknown[] }
        close(): void
      }
    }
    const db = new DatabaseSync(dbPath)
    try {
      const rows = db
        .prepare(
          `
            select
              rc.chunk_id,
              rc.rowid as chunk_rowid,
              rce.rowid as coarse_rowid,
              re.rowid as embedding_rowid
            from rag_chunks rc
            inner join rag_coarse_embeddings rce on rce.rowid = rc.rowid
            inner join rag_embeddings re on re.rowid = rc.rowid
            order by rc.chunk_id
          `,
        )
        .all() as Array<{
        chunk_id: string
        chunk_rowid: number
        coarse_rowid: number
        embedding_rowid: number
      }>

      expect(rows).toHaveLength(2)
      expect(rows[0]?.chunk_id).toBe('stable-rowid-a')
      expect(rows[1]?.chunk_id).toBe('stable-rowid-b')
      expect(rows[0]?.chunk_rowid).toBe(rows[0]?.coarse_rowid)
      expect(rows[0]?.chunk_rowid).toBe(rows[0]?.embedding_rowid)
      expect(rows[1]?.chunk_rowid).toBe(rows[1]?.coarse_rowid)
      expect(rows[1]?.chunk_rowid).toBe(rows[1]?.embedding_rowid)
    } finally {
      db.close()
    }

    fs.rmSync(rootDir, { recursive: true, force: true })
  })
})
