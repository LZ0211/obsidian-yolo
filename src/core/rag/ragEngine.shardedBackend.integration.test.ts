/* eslint-disable import/no-nodejs-modules -- 测试在 Node 环境运行：chunks.sqlite 通过 node:sqlite 落到真实临时目录，与 shardedVectorManager.integration.test.ts 一致 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const errorModalCtor = jest.fn()

jest.mock('../../components/modals/ErrorModal', () => ({
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

jest.mock('../../utils/pdf/extractPdfText', () => ({
  PDF_INDEX_MAX_BYTES: 50_000_000,
  PDF_INDEX_MAX_PAGES: 1000,
  extractPdfText: jest.fn(),
}))

// RAGEngine builds its embedding client in the constructor; the test replaces
// it with a deterministic fake before constructing the engine.
jest.mock('./embedding', () => ({
  getEmbeddingModelClient: jest.fn(),
}))

import { openShardSqliteNode } from '../../database/modules/vector/backend/sharded/shardedSqlite'
import {
  type ShardedVaultAdapter,
  ShardedVectorStore,
} from '../../database/modules/vector/backend/sharded/ShardedVectorStore'
import { VectorManager } from '../../database/modules/vector/VectorManager'

import { getEmbeddingModelClient } from './embedding'
import { RAGEngine } from './ragEngine'

/**
 * Map-backed vault adapter test double for the sharded backend (manifest/
 * vectors.f32/index.bin live here), plus `stat` for VectorManager's real
 * mtime reads. Every write/rename/remove is mirrored into a real temp
 * filesystem tree (`realRoot`): chunks.sqlite is opened by the node:sqlite
 * opener directly on that tree, so a shard-dir rename (vacuum's temp → final
 * move, exactly like production where sql.js writes through the vault
 * adapter) carries the sqlite file along with the adapter-tracked artifacts.
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
      for (const [childKey] of [...this.nodes.keys()]) {
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
 * Vault surface for VectorManager/RAGEngine: getFiles/cachedRead/stat all
 * read one mutable file map, and `adapter` doubles as the sharded store's
 * vault adapter.
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
    adapter,
  }
}

/**
 * Deterministic content embedding: unit vector over a fixed token vocabulary
 * (multi-hot, L2-normalized), so a query whose text matches a chunk scores
 * 1.0 while unrelated chunks score below the 0.3 minSimilarity.
 */
const EMBEDDING_DIMENSION = 4
const TOKENS = ['alpha', 'beta', 'gamma', 'delta']

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

const BASE_DIR = '/vault/.yolo'

const EMBEDDING_MODELS = [
  {
    id: 'test-embedding-model',
    providerId: 'test',
    model: 'text-embedding-3-large',
    dimension: EMBEDDING_DIMENSION,
  },
]

// Same namespace derivation as the desktop path: VectorManager and RAGEngine
// both resolve `configuredModel.model` from settings.embeddingModels.
const baseSettings = {
  embeddingModelId: 'test-embedding-model',
  embeddingModels: EMBEDDING_MODELS,
  ragOptions: {
    chunkSize: 500,
    chunkOverlap: 50,
    excludePatterns: [],
    includePatterns: [],
    minSimilarity: 0.3,
    limit: 20,
    rerankEnabled: false,
  },
} as never

describe('RAGEngine over the sharded backend', () => {
  let embeddingClient: {
    id: string
    dimension: number
    getEmbedding: jest.Mock
  }

  beforeEach(() => {
    embeddingClient = {
      id: 'test-embedding-model',
      dimension: EMBEDDING_DIMENSION,
      getEmbedding: jest.fn(async (content: string) => embedContent(content)),
    }
    jest
      .mocked(getEmbeddingModelClient)
      .mockReturnValue(embeddingClient as never)
  })

  it('search after reconcile returns indexed chunks without throwing on the query-cache path', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ragengine-sharded-'),
    )
    const vault = createVaultApp(tempRoot, {
      'notes/a.md': { mtime: 100, content: 'alpha beta' },
      'notes/b.md': { mtime: 200, content: 'gamma delta' },
    })
    const store = new ShardedVectorStore({
      baseDir: BASE_DIR,
      app: { vault: { adapter: vault.adapter } },
      openShardSqlite: (dbPath) =>
        openShardSqliteNode(vault.adapter.realPath(dbPath)),
    })
    await store.open()
    try {
      const manager = new VectorManager(vault.app as never, {} as never, {
        vectorStore: store,
        settings: { embeddingModels: EMBEDDING_MODELS } as never,
      })
      const engine = new RAGEngine(
        vault.app as never,
        baseSettings,
        manager as never,
        (_key: string, fallback?: string) => fallback ?? '',
        { insertTrace: jest.fn(async () => undefined) },
      )

      await engine.updateVaultIndex({ scope: { kind: 'all' } })
      embeddingClient.getEmbedding.mockClear()

      // First query exercises the persistent cache READ (must be a miss, not
      // a throw) and the cache WRITE (must be a silent no-op, not a throw).
      const first = await engine.processQuery({
        query: 'alpha beta',
        rerankPolicy: 'none',
      })
      // Second, different query: another embed + cache write round-trip.
      const second = await engine.processQuery({
        query: 'gamma delta',
        rerankPolicy: 'none',
      })

      expect(first.map((row) => row.path)).toEqual(['notes/a.md'])
      expect(first[0].similarity).toBeCloseTo(1, 9)
      expect(second.map((row) => row.path)).toEqual(['notes/b.md'])
      expect(second[0].similarity).toBeCloseTo(1, 9)

      // Both queries embedded from scratch: the persistent read returned a
      // miss (null) and the write was dropped — never thrown.
      expect(embeddingClient.getEmbedding).toHaveBeenCalledTimes(2)
    } finally {
      await store.close()
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
