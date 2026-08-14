/* eslint-disable import/no-nodejs-modules -- 测试在 Node 环境运行：chunks.sqlite 通过 node:sqlite 落到真实临时目录，与 ShardedVectorStore.test.ts 一致 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const errorModalCtor = jest.fn()

jest.mock('../../../../../components/modals/ErrorModal', () => ({
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
// success returns the value; failure rethrows immediately.
jest.mock('exponential-backoff', () => ({
  backOff: (fn: () => Promise<unknown>) => fn(),
}))

jest.mock('../../../../../utils/pdf/extractPdfText', () => ({
  PDF_INDEX_MAX_BYTES: 50_000_000,
  PDF_INDEX_MAX_PAGES: 1000,
  extractPdfText: jest.fn(),
}))

import { createEmbeddingVectorNamespace } from '../../../rag/embeddingNamespace'
import { vectorNamespaceId } from '../../../rag/namespaceId'
import type { VectorFileWrite } from '../../../rag/VectorStore'
import { VectorManager } from '../../VectorManager'

import {
  getShardedManifestPath,
  getShardedModelRoot,
  getShardedShardRoot,
} from './shardedPaths'
import { openShardSqliteNode } from './shardedSqlite'
import { ShardedVectorStore } from './ShardedVectorStore'
import type { ShardedVaultAdapter } from './ShardedVectorStore'

/**
 * Map-backed vault adapter test double for the sharded backend (manifest/
 * vectors.f32/index.bin live here), plus `stat` for VectorManager's real
 * mtime reads. `stat` is served from the vault-file snapshot, mirroring
 * Obsidian's DataAdapter surface the production app provides.
 *
 * Every write/rename/remove is mirrored into a real temp filesystem tree
 * (`realRoot`): chunks.sqlite is opened by the node:sqlite opener directly on
 * that tree, so a shard-dir rename (vacuum's temp → final move, exactly like
 * production where sql.js writes through the vault adapter) carries the
 * sqlite file along with the adapter-tracked artifacts.
 */
class InMemoryVaultAdapter {
  private readonly nodes = new Map<
    string,
    { kind: 'file'; content: ArrayBuffer } | { kind: 'dir' }
  >()
  private readonly fileStats = new Map<
    string,
    { mtime: number; size: number }
  >()

  constructor(private readonly realRoot: string) {}

  /** Real-filesystem path for the opener (strips the leading slash). */
  realPath(value: string): string {
    return path.join(this.realRoot, InMemoryVaultAdapter.normalize(value))
  }

  private static normalize(value: string): string {
    const normalized = value.replace(/\\/g, '/')
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  }

  exists(value: string): Promise<boolean> {
    return Promise.resolve(
      this.nodes.has(InMemoryVaultAdapter.normalize(value)),
    )
  }

  read(value: string): Promise<string> {
    const node = this.requireFile(value)
    return Promise.resolve(new TextDecoder().decode(node.content))
  }

  readBinary(value: string): Promise<ArrayBuffer> {
    const node = this.requireFile(value)
    return Promise.resolve(node.content.slice(0))
  }

  write(value: string, data: string): Promise<void> {
    this.ensureParents(value)
    this.nodes.set(InMemoryVaultAdapter.normalize(value), {
      kind: 'file',
      content: new TextEncoder().encode(data).buffer,
    })
    this.mirrorFile(value, new TextEncoder().encode(data).buffer)
    return Promise.resolve()
  }

  writeBinary(value: string, data: ArrayBuffer): Promise<void> {
    this.ensureParents(value)
    this.nodes.set(InMemoryVaultAdapter.normalize(value), {
      kind: 'file',
      content: data,
    })
    this.mirrorFile(value, data)
    return Promise.resolve()
  }

  rename(oldValue: string, newValue: string): Promise<void> {
    const oldKey = InMemoryVaultAdapter.normalize(oldValue)
    const newKey = InMemoryVaultAdapter.normalize(newValue)
    const node = this.nodes.get(oldKey)
    if (node == null) {
      return Promise.reject(new Error(`No such file or directory: ${oldValue}`))
    }
    this.ensureParents(newValue)
    if (node.kind === 'dir') {
      const prefix = `${oldKey}/`
      for (const [key, child] of [...this.nodes.entries()]) {
        if (key.startsWith(prefix)) {
          this.nodes.delete(key)
          this.nodes.set(`${newKey}/${key.slice(prefix.length)}`, child)
        }
      }
    }
    this.nodes.delete(oldKey)
    this.nodes.set(newKey, node)
    // Move the real tree too: chunks.sqlite lives there (node:sqlite), and
    // the sql.js opener in production writes through the adapter — so the
    // shard dir rename must carry the sqlite file with it.
    fs.mkdirSync(path.dirname(this.realPath(newValue)), { recursive: true })
    fs.renameSync(this.realPath(oldValue), this.realPath(newValue))
    return Promise.resolve()
  }

  remove(value: string, options?: { recursive?: boolean }): Promise<void> {
    const key = InMemoryVaultAdapter.normalize(value)
    const node = this.nodes.get(key)
    if (node == null) return Promise.resolve()
    if (node.kind === 'dir' && !options?.recursive) {
      return Promise.reject(
        new Error(`Directory not empty or recursive required: ${value}`),
      )
    }
    this.nodes.delete(key)
    if (node.kind === 'dir') {
      const prefix = `${key}/`
      for (const childKey of [...this.nodes.keys()]) {
        if (childKey.startsWith(prefix)) this.nodes.delete(childKey)
      }
    }
    fs.rmSync(this.realPath(value), { recursive: true, force: true })
    return Promise.resolve()
  }

  list(value: string): Promise<{ files: string[]; folders: string[] }> {
    const key = InMemoryVaultAdapter.normalize(value)
    const node = this.nodes.get(key)
    if (node == null || node.kind !== 'dir') {
      return Promise.reject(new Error(`No such directory: ${value}`))
    }
    const prefix = `${key}/`
    const files: string[] = []
    const folders: string[] = []
    for (const [childKey, child] of this.nodes) {
      if (!childKey.startsWith(prefix)) continue
      const rest = childKey.slice(prefix.length)
      if (rest.includes('/')) continue
      if (child.kind === 'dir') folders.push(rest)
      else files.push(rest)
    }
    return Promise.resolve({ files: files.sort(), folders: folders.sort() })
  }

  /** Test helper: seed a directory (and parents). */
  seedDir(value: string): void {
    this.ensureParents(`${value}/placeholder`)
    this.nodes.set(InMemoryVaultAdapter.normalize(value), { kind: 'dir' })
  }

  /** VectorManager.readRealFileMtime reads the real filesystem mtime. */
  stat(value: string): Promise<{ mtime: number; size: number }> {
    const stat = this.fileStats.get(InMemoryVaultAdapter.normalize(value))
    if (stat == null) {
      return Promise.reject(new Error(`No such file: ${value}`))
    }
    return Promise.resolve({ ...stat })
  }

  setFileStat(value: string, stat: { mtime: number; size: number }): void {
    this.fileStats.set(InMemoryVaultAdapter.normalize(value), stat)
  }

  private mirrorFile(value: string, data: ArrayBuffer): void {
    const real = this.realPath(value)
    fs.mkdirSync(path.dirname(real), { recursive: true })
    fs.writeFileSync(real, Buffer.from(data))
  }

  private requireFile(value: string): { content: ArrayBuffer } {
    const node = this.nodes.get(InMemoryVaultAdapter.normalize(value))
    if (node == null || node.kind !== 'file') {
      throw new Error(`No such file: ${value}`)
    }
    return node
  }

  private ensureParents(value: string): void {
    const key = InMemoryVaultAdapter.normalize(value)
    const segments = key.split('/')
    for (let i = 1; i < segments.length; i += 1) {
      const parent = segments.slice(0, i).join('/')
      if (parent.length > 0 && !this.nodes.has(parent)) {
        this.nodes.set(parent, { kind: 'dir' })
      }
    }
  }
}

type VaultFile = { mtime: number; content: string }

/**
 * Vault surface for VectorManager: getFiles/cachedRead/stat all read one
 * mutable file map (modify it between reconciles to simulate file changes),
 * and `adapter` doubles as the sharded store's vault adapter.
 */
function createVaultApp(
  realRoot: string,
  initialFiles: Record<string, VaultFile>,
) {
  const files = new Map<string, VaultFile>(
    Object.entries(initialFiles).map(([filePath, file]) => [
      filePath,
      { ...file },
    ]),
  )
  const adapter = new InMemoryVaultAdapter(realRoot)
  for (const [filePath, file] of files) {
    adapter.setFileStat(filePath, {
      mtime: file.mtime,
      size: file.content.length,
    })
  }
  return {
    app: {
      vault: {
        getFiles: () =>
          [...files.entries()].map(([filePath, file]) => ({
            path: filePath,
            extension: filePath.split('.').pop() ?? '',
            stat: { mtime: file.mtime, size: file.content.length },
          })),
        cachedRead: async (file: { path: string }) =>
          files.get(file.path)?.content ?? '',
        adapter: adapter as unknown as ShardedVaultAdapter,
      },
    },
    setFile(filePath: string, file: VaultFile): void {
      files.set(filePath, { ...file })
      adapter.setFileStat(filePath, {
        mtime: file.mtime,
        size: file.content.length,
      })
    },
    deleteFile(filePath: string): void {
      files.delete(filePath)
      adapter.setFileStat(filePath, { mtime: 0, size: 0 })
    },
    adapter,
  }
}

/**
 * Deterministic content embedding: unit vector over a fixed token vocabulary
 * (multi-hot, L2-normalized). Distinct documents get distinct vectors, so a
 * search for a document's exact text scores 1.0 while unrelated documents
 * score below 0.5 — crisp assertions without a real embedding model.
 */
const EMBEDDING_DIMENSION = 8
const TOKENS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'omega',
  'changed',
]

function embedContent(content: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSION).fill(0)
  for (const token of content.split(/\s+/)) {
    const index = TOKENS.indexOf(token)
    if (index >= 0) vector[index] += 1
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  )
  return vector.map((value) => value / magnitude)
}

const embeddingModel = {
  id: 'test-model',
  dimension: EMBEDDING_DIMENSION,
  getEmbedding: jest.fn(async (content: string) => embedContent(content)),
} as never

const BASE_DIR = '/vault/.yolo'
const NAMESPACE_ID = vectorNamespaceId(
  createEmbeddingVectorNamespace({
    model: 'text-embedding-3-large',
    dimension: EMBEDDING_DIMENSION,
    providerId: 'openai',
  }),
)

const baseConfig = {
  chunkSize: 1000,
  chunkOverlap: 50,
  includePatterns: [],
  excludePatterns: [],
  indexPdf: false,
}

describe('VectorManager.reconcile over the sharded backend (端到端全链路)', () => {
  let tempRoot: string
  let store: ShardedVectorStore
  let manager: VectorManager
  let vault: ReturnType<typeof createVaultApp>
  let replaceFileSpy: jest.SpyInstance
  let deleteFileSpy: jest.SpyInstance

  const reconcileAll = () =>
    manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } })

  /** Search through the real VectorManager path; returns {path, similarity} rows. */
  const search = async (text: string) => {
    const { rows } = await manager.performSimilaritySearch(
      embedContent(text),
      embeddingModel,
      { minSimilarity: 0.5, limit: 5 },
    )
    // Cosine scores are float arithmetic; round for stable exact-match asserts.
    return rows.map((row) => ({
      path: row.path,
      similarity: Math.round(row.similarity * 1e9) / 1e9,
    }))
  }

  const replacedPaths = () =>
    replaceFileSpy.mock.calls.map(
      ([, fileWrite]) => (fileWrite as { path: string }).path,
    )
  const deletedPaths = () =>
    deleteFileSpy.mock.calls.map(([, filePath]) => filePath as string)

  beforeEach(async () => {
    jest.clearAllMocks()
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (content: string) => embedContent(content))

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-manager-e2e-'))
    vault = createVaultApp(tempRoot, {
      'notes/a.md': { mtime: 100, content: 'alpha beta gamma' },
      'notes/b.md': { mtime: 200, content: 'delta epsilon zeta' },
    })
    store = new ShardedVectorStore({
      baseDir: BASE_DIR,
      app: { vault: { adapter: vault.adapter } },
      // chunks.sqlite needs a real file (node:sqlite); the adapter mirrors
      // every write/rename/remove into the same real tree, so shard dir
      // renames carry the sqlite file — mirroring the mobile sql.js wiring.
      openShardSqlite: (dbPath) =>
        openShardSqliteNode(vault.adapter.realPath(dbPath)),
    })
    await store.open()
    manager = new VectorManager(vault.app as never, {} as never, {
      vectorStore: store,
      settings: {
        embeddingModels: [
          {
            id: 'test-model',
            providerId: 'openai',
            model: 'text-embedding-3-large',
            dimension: EMBEDDING_DIMENSION,
          },
        ],
      } as never,
    })
    replaceFileSpy = jest.spyOn(store, 'replaceFile')
    deleteFileSpy = jest.spyOn(store, 'deleteFile')
  })

  afterEach(async () => {
    await store.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  it('reconcile → 检索 → 修改(mtime+内容) → 墓碑 → 删除 → vacuum 全链路正确', async () => {
    // ---- 1. 首次 reconcile：两个文件入索引，检索可命中 ----
    replaceFileSpy.mockClear()
    deleteFileSpy.mockClear()
    await reconcileAll()
    expect(replacedPaths().sort()).toEqual(['notes/a.md', 'notes/b.md'])
    expect(deletedPaths()).toEqual([])

    let hits = await search('alpha beta gamma')
    expect(hits).toEqual([{ path: 'notes/a.md', similarity: 1 }])
    hits = await search('delta epsilon zeta')
    expect(hits).toEqual([{ path: 'notes/b.md', similarity: 1 }])

    // ---- 2. 修改 a.md（mtime + 内容）：reconcile 重写，旧 chunk 墓碑化 ----
    replaceFileSpy.mockClear()
    deleteFileSpy.mockClear()
    vault.setFile('notes/a.md', { mtime: 300, content: 'alpha changed omega' })
    await reconcileAll()
    expect(replacedPaths()).toEqual(['notes/a.md'])
    expect(deletedPaths()).toEqual([])

    // 旧内容不再命中（旧 chunk 被墓碑化）；新内容可检索
    expect(await search('alpha beta gamma')).toEqual([])
    hits = await search('alpha changed omega')
    expect(hits).toEqual([{ path: 'notes/a.md', similarity: 1 }])

    // ---- 3. 删除 b.md：reconcile 墓碑化，检索排除 ----
    replaceFileSpy.mockClear()
    deleteFileSpy.mockClear()
    vault.deleteFile('notes/b.md')
    await reconcileAll()
    expect(replacedPaths()).toEqual([])
    expect(deletedPaths()).toEqual(['notes/b.md'])

    expect(await search('delta epsilon zeta')).toEqual([])
    hits = await search('alpha changed omega')
    expect(hits).toEqual([{ path: 'notes/a.md', similarity: 1 }])

    // ---- 4. vacuum：重建压缩，墓碑清理，shard 目录替换 ----
    const vacuumResult = await manager.vacuum()
    expect(vacuumResult).toEqual({ removedFiles: 1, removedChunks: 2 })

    // 旧 shard 目录已删除，新 shard（id 续接）只有一个活 chunk
    expect(
      await vault.adapter.exists(
        getShardedShardRoot(BASE_DIR, NAMESPACE_ID, '000001'),
      ),
    ).toBe(false)
    expect(
      await vault.adapter.exists(
        getShardedShardRoot(BASE_DIR, NAMESPACE_ID, '000002'),
      ),
    ).toBe(true)
    const manifest = JSON.parse(
      await vault.adapter.read(getShardedManifestPath(BASE_DIR)),
    ) as {
      shards: Array<{ id: string; vectorCount: number }>
    }
    expect(manifest.shards).toHaveLength(1)
    expect(manifest.shards[0]).toMatchObject({ id: '000002', vectorCount: 1 })

    // vacuum 后检索仍然正确
    expect(await search('delta epsilon zeta')).toEqual([])
    hits = await search('alpha changed omega')
    expect(hits).toEqual([{ path: 'notes/a.md', similarity: 1 }])

    // ---- 5. 幂等：无变更 reconcile 不产生任何写入 ----
    replaceFileSpy.mockClear()
    deleteFileSpy.mockClear()
    await reconcileAll()
    expect(replacedPaths()).toEqual([])
    expect(deletedPaths()).toEqual([])
  })

  it('reports rebuild required when the manifest belongs to another embedding identity', async () => {
    const legacyNamespace = createEmbeddingVectorNamespace({
      model: 'text-embedding-3-large',
      dimension: EMBEDDING_DIMENSION,
    })
    const identityNamespace = createEmbeddingVectorNamespace({
      model: 'text-embedding-3-large',
      dimension: EMBEDDING_DIMENSION,
      providerId: 'openai',
    })
    const legacyNamespaceId = vectorNamespaceId(legacyNamespace)

    await store.replaceFile(legacyNamespace, {
      path: 'notes/a.md',
      mtime: 100,
      contentHash: 'legacy-file-hash',
      chunks: [
        {
          chunkId: 'legacy-chunk',
          path: 'notes/a.md',
          text: 'alpha beta gamma',
          contentHash: 'legacy-chunk-hash',
          embedding: embedContent('alpha beta gamma'),
          location: { lineStart: 0, lineEnd: 1, headingPath: [] },
          metadataJson: {},
        },
      ],
    })

    await expect(store.getStatus(identityNamespace)).resolves.toMatchObject({
      rebuildRequired: true,
      recoveryAction: 'rebuild_index',
    })
    await expect(
      vault.adapter.read(getShardedManifestPath(BASE_DIR)),
    ).resolves.toContain(`\"activeModel\":\"${legacyNamespaceId}\"`)
    expect(
      await vault.adapter.exists(
        getShardedModelRoot(BASE_DIR, legacyNamespaceId),
      ),
    ).toBe(true)
  })
})
