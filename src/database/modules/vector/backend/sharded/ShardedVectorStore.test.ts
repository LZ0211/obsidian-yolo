import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  type VectorChunkWrite,
  type VectorNamespace,
  VectorStoreError,
} from '../../../rag/VectorStore'

import {
  getShardedIndexRoot,
  getShardedManifestPath,
  getShardedModelRoot,
  getShardedShardRoot,
  getShardedStagedManifestPath,
} from './shardedPaths'
import { parseShardedManifest } from './shardedManifest'
import { openShardSqliteNode, openShardSqliteWasm } from './shardedSqlite'
import {
  COARSE_DIMENSION,
  MAX_VECTORS_PER_SHARD,
  ShardedVectorStore,
} from './ShardedVectorStore'

type InMemoryNode = { kind: 'file'; content: ArrayBuffer } | { kind: 'dir' }

/**
 * Map-backed vault adapter test double. Paths are normalized to forward
 * slashes with no trailing slash; directories are created implicitly by
 * writes. `list` on a missing directory throws, mirroring Obsidian's
 * DataAdapter.
 */
class InMemoryVaultAdapter {
  private readonly nodes = new Map<string, InMemoryNode>()

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
    return Promise.resolve()
  }

  writeBinary(value: string, data: ArrayBuffer): Promise<void> {
    this.ensureParents(value)
    this.nodes.set(InMemoryVaultAdapter.normalize(value), {
      kind: 'file',
      content: data,
    })
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
    return Promise.resolve({
      files: files.sort(),
      folders: folders.sort(),
    })
  }

  /** Test helper: seed a directory (and parents). */
  seedDir(value: string): void {
    this.ensureParents(`${value}/placeholder`)
    this.nodes.set(InMemoryVaultAdapter.normalize(value), { kind: 'dir' })
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

/**
 * Adapter double that injects a failure into the Nth writeBinary call for a
 * given path (1-based). Used to simulate an IO error mid-replaceFile.
 */
class WriteFailVaultAdapter extends InMemoryVaultAdapter {
  private failPath: string | null = null
  private failCallNumber = 0

  armWriteBinaryFailure(path: string, callNumber: number): void {
    this.failPath = path.replace(/\\/g, '/')
    this.failCallNumber = callNumber
  }

  override writeBinary(value: string, data: ArrayBuffer): Promise<void> {
    if (
      this.failPath != null &&
      this.failCallNumber > 0 &&
      value.replace(/\\/g, '/') === this.failPath
    ) {
      this.failCallNumber -= 1
      if (this.failCallNumber === 0) {
        return Promise.reject(new Error('injected write failure'))
      }
    }
    return super.writeBinary(value, data)
  }
}

/**
 * Adapter double that parks the next `vectors.f32` writeBinary until
 * released. Simulates the exact mid-write window the reader-writer lock
 * protects: the chunk row is already in chunks.sqlite while vectors.f32/
 * index.bin still describe the pre-write shard.
 */
class BlockVectorsWriteVaultAdapter extends InMemoryVaultAdapter {
  private armBlock = false
  private parked = false
  private parkWaiters: Array<() => void> = []
  private releaseResolve: (() => void) | null = null

  blockNextVectorsWrite(): void {
    this.armBlock = true
  }

  /** Resolves once the parked vectors.f32 write is in flight. */
  waitUntilBlocked(): Promise<void> {
    if (this.parked) return Promise.resolve()
    return new Promise((resolve) => {
      this.parkWaiters.push(resolve)
    })
  }

  releaseBlockedWrite(): void {
    this.releaseResolve?.()
  }

  override writeBinary(value: string, data: ArrayBuffer): Promise<void> {
    if (this.armBlock && value.replace(/\\/g, '/').endsWith('/vectors.f32')) {
      this.armBlock = false
      this.parked = true
      for (const resolve of this.parkWaiters.splice(0)) resolve()
      return new Promise<void>((resolve) => {
        this.releaseResolve = () => {
          this.releaseResolve = null
          resolve()
        }
      }).then(() => super.writeBinary(value, data))
    }
    return super.writeBinary(value, data)
  }
}

/**
 * Adapter double that parks the next `read` call (the search's manifest
 * read) until released, and signals when a second `read` arrives while the
 * first is still parked — proving two readers run concurrently.
 */
class ParkNextReadVaultAdapter extends InMemoryVaultAdapter {
  private armPark = false
  private parked = false
  private parkWaiters: Array<() => void> = []
  private releaseResolve: (() => void) | null = null
  private concurrentReadSeen = false
  private concurrentWaiters: Array<(value: boolean) => void> = []

  armParkNextRead(): void {
    this.armPark = true
  }

  waitUntilParked(): Promise<void> {
    if (this.parked) return Promise.resolve()
    return new Promise((resolve) => {
      this.parkWaiters.push(resolve)
    })
  }

  /** Resolves `true` once another read arrives while the parked read is held. */
  waitForConcurrentRead(): Promise<boolean> {
    if (this.concurrentReadSeen) return Promise.resolve(true)
    return new Promise((resolve) => {
      this.concurrentWaiters.push(resolve)
    })
  }

  releaseParkedRead(): void {
    this.releaseResolve?.()
  }

  override read(value: string): Promise<string> {
    if (this.armPark) {
      this.armPark = false
      this.parked = true
      for (const resolve of this.parkWaiters.splice(0)) resolve()
      return new Promise<void>((resolve) => {
        this.releaseResolve = () => {
          this.releaseResolve = null
          resolve()
        }
      }).then(() => super.read(value))
    }
    if (this.parked) {
      this.concurrentReadSeen = true
      for (const resolve of this.concurrentWaiters.splice(0)) resolve(true)
    }
    return super.read(value)
  }
}

/**
 * In-memory adapter double that keeps the real-FS chunks.sqlite files (the
 * write-path opener redirects sqlite into a temp dir) in sync with virtual
 * directory moves/removals — simulating production mobile, where chunks.sqlite
 * is itself a vault file managed by the adapter. Without this, a vacuum's
 * virtual rename/remove would leave the old real sqlite file behind at the
 * reused shard path, desyncing its rows from the rebuilt vectors.f32.
 */
class SqliteSyncVaultAdapter extends InMemoryVaultAdapter {
  private readonly tempRoot: string

  constructor(tempRoot: string) {
    super()
    this.tempRoot = tempRoot
  }

  private realPath(virtualPath: string): string {
    return path.join(this.tempRoot, virtualPath.replace(/^[\\/]+/, ''))
  }

  override rename(oldValue: string, newValue: string): Promise<void> {
    const oldDb = path.join(this.realPath(oldValue), 'chunks.sqlite')
    const newDb = path.join(this.realPath(newValue), 'chunks.sqlite')
    if (fs.existsSync(oldDb)) {
      fs.mkdirSync(path.dirname(newDb), { recursive: true })
      fs.rmSync(newDb, { force: true })
      fs.renameSync(oldDb, newDb)
    }
    return super.rename(oldValue, newValue)
  }

  override remove(
    value: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const dbPath = path.join(this.realPath(value), 'chunks.sqlite')
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath)
    return super.remove(value, options)
  }
}

/**
 * Adapter double that injects an IO error into the SECOND `.build-*` shard's
 * vectors.f32 write during a vacuum rebuild — i.e. the second batch of a
 * multi-batch compact fails after the first batch built (and, on the
 * pre-fix code, already replaced its old shard dir). Arms once; later
 * writes pass through so a vacuum re-run completes normally.
 */
class FailVacuumSecondBatchAdapter extends SqliteSyncVaultAdapter {
  private failOnBuildWrite = 0
  private buildVectorWrites = 0

  failSecondVacuumBatch(): void {
    this.failOnBuildWrite = 2
  }

  override writeBinary(value: string, data: ArrayBuffer): Promise<void> {
    if (
      this.failOnBuildWrite > 0 &&
      value.includes('/.build-') &&
      value.endsWith('/vectors.f32')
    ) {
      this.buildVectorWrites += 1
      if (this.buildVectorWrites === this.failOnBuildWrite) {
        this.failOnBuildWrite = 0
        return Promise.reject(new Error('injected vacuum build failure'))
      }
    }
    return super.writeBinary(value, data)
  }
}

const BASE_DIR = '/vault/.yolo'

const testNamespace: VectorNamespace = {
  provider: 'test',
  model: 'm1',
  dimension: 256,
  distanceMetric: 'cosine',
}

const makeStore = (
  adapter: InMemoryVaultAdapter = new InMemoryVaultAdapter(),
) =>
  new ShardedVectorStore({
    baseDir: BASE_DIR,
    app: { vault: { adapter } },
  })

/**
 * Write-path stores route chunks.sqlite through the injected opener to a
 * real temp dir (node:sqlite needs a real file), while manifest/vectors/
 * index stay in the in-memory adapter. Mirrors the mobile wiring where the
 * opener maps vault paths to sqlite storage.
 */
const makeStoreWithTempSqlite = (
  adapter: InMemoryVaultAdapter,
  tempRoot: string,
) =>
  new ShardedVectorStore({
    baseDir: BASE_DIR,
    app: { vault: { adapter } },
    openShardSqlite: (dbPath) =>
      openShardSqliteNode(realPathFor(tempRoot, dbPath)),
  })

const realPathFor = (tempRoot: string, virtualPath: string): string =>
  path.join(tempRoot, virtualPath.replace(/^[\\/]+/, ''))

const tempChunksDbPath = (
  tempRoot: string,
  namespaceId: string,
  shardId: string,
): string =>
  realPathFor(
    tempRoot,
    `${getShardedShardRoot(BASE_DIR, namespaceId, shardId)}/chunks.sqlite`,
  )

const chunk = (
  chunkId: string,
  text: string,
  embedding: number[],
  line: number,
  filePath = 'notes/a.md',
) => ({
  chunkId,
  path: filePath,
  text,
  contentHash: `hash-${chunkId}`,
  embedding,
  location: { lineStart: line, lineEnd: line },
  metadataJson: {},
})

/**
 * Write-path namespace: dimension 4 so the brief's `[1,0,0,0]` embeddings
 * match `dim × 4` byte assertions (coarse dims still pad to COARSE_DIMENSION).
 */
const writeNamespace: VectorNamespace = {
  provider: 'test',
  model: 'm1',
  dimension: 4,
  distanceMetric: 'cosine',
}
const WRITE_NS_ID = 'm1-d4'

describe('ShardedVectorStore skeleton', () => {
  it('open then listNamespaces returns empty when no models dir exists', async () => {
    const store = makeStore()
    await store.open()
    expect(await store.listNamespaces()).toEqual([])
  })

  it('listNamespaces lists seeded namespace folders, sorted', async () => {
    const adapter = new InMemoryVaultAdapter()
    adapter.seedDir(getShardedModelRoot(BASE_DIR, 'zz-d384'))
    adapter.seedDir(getShardedModelRoot(BASE_DIR, 'm1-d256'))
    const store = makeStore(adapter)
    await store.open()
    expect(await store.listNamespaces()).toEqual(['m1-d256', 'zz-d384'])
  })

  it('getStatus(ns) reports rebuild_required semantics without a manifest', async () => {
    const store = makeStore()
    await store.open()
    const status = await store.getStatus(testNamespace)
    expect(status.readiness).toBe('ready')
    expect(status.rebuildRequired).toBe(true)
    expect(status.recoveryAction).toBe('rebuild_index')
    expect(status.storagePath).toBe(getShardedManifestPath(BASE_DIR))
  })

  it('getStatus() reports ready once a manifest exists', async () => {
    const adapter = new InMemoryVaultAdapter()
    await adapter.write(
      getShardedManifestPath(BASE_DIR),
      JSON.stringify({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'm1',
        updatedAt: 1,
        shards: [],
      }),
    )
    const store = makeStore(adapter)
    await store.open()
    const status = await store.getStatus()
    expect(status.rebuildRequired).toBe(false)
    expect(status.recoveryAction).toBe('none')
    expect(status.storagePath).toBe(getShardedIndexRoot(BASE_DIR))
  })

  it('dropNamespace removes the namespace directory', async () => {
    const adapter = new InMemoryVaultAdapter()
    adapter.seedDir(getShardedModelRoot(BASE_DIR, 'm1-d256'))
    const store = makeStore(adapter)
    await store.open()
    await store.dropNamespace(testNamespace)
    expect(await adapter.exists(getShardedModelRoot(BASE_DIR, 'm1-d256'))).toBe(
      false,
    )
    expect(await store.listNamespaces()).toEqual([])
  })

  it('dropNamespaceById removes the namespace directory', async () => {
    const adapter = new InMemoryVaultAdapter()
    adapter.seedDir(getShardedModelRoot(BASE_DIR, 'm1-d256'))
    const store = makeStore(adapter)
    await store.open()
    await store.dropNamespaceById('m1-d256')
    expect(await adapter.exists(getShardedModelRoot(BASE_DIR, 'm1-d256'))).toBe(
      false,
    )
  })

  it('dropNamespace on a missing namespace is a no-op', async () => {
    const store = makeStore()
    await store.open()
    await expect(store.dropNamespace(testNamespace)).resolves.toBeUndefined()
  })

  it('dropNamespaceById rejects path-traversal ids', async () => {
    const store = makeStore()
    await store.open()
    await expect(store.dropNamespaceById('../escape')).rejects.toThrow(
      VectorStoreError,
    )
  })

  it('listNamespaces before open throws not_open', async () => {
    const store = makeStore()
    await expect(store.listNamespaces()).rejects.toMatchObject({
      code: 'not_open',
    })
  })

  it('listNamespaces after close throws not_open', async () => {
    const store = makeStore()
    await store.open()
    await store.close()
    await expect(store.listNamespaces()).rejects.toMatchObject({
      code: 'not_open',
    })
  })

  it('open is idempotent', async () => {
    const store = makeStore()
    await store.open()
    await store.open()
    expect(await store.listNamespaces()).toEqual([])
  })

  it('close without open is a no-op', async () => {
    const store = makeStore()
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('skeleton methods not yet implemented throw "not implemented yet"', async () => {
    const store = makeStore()
    await store.open()
    const unimplemented: Array<Promise<unknown>> = [
      store.clearNamespace(testNamespace),
      store.getStats(testNamespace),
      store.getStatusByNamespaceId?.('m1-d256'),
      store.getQueryEmbedding?.(testNamespace, 'hash'),
      store.putQueryEmbedding?.(testNamespace, 'hash', [1, 0, 0, 0]),
      store.save?.(testNamespace),
      store.getStoredFileVectors?.(testNamespace, ['a.md']),
      store.purgeNamespacesByPrefixForPrivacy?.({
        namespaceIdPrefix: 'm1',
        confirmation: 'confirm',
      }),
    ]
    for (const pending of unimplemented) {
      await expect(pending).rejects.toThrow('not implemented yet')
    }
  })
})

describe('ShardedVectorStore write path', () => {
  jest.setTimeout(30_000)

  it('replaceFile appends vectors.f32, upserts chunks.sqlite, and publishes the manifest', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 123456789,
        contentHash: 'file-hash-1',
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })

      // Manifest published atomically (staged file consumed by the rename).
      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.activeModel).toBe(WRITE_NS_ID)
      expect(manifest.shards).toHaveLength(1)
      expect(manifest.shards[0]).toMatchObject({
        id: '000001',
        relativePath: `models/${WRITE_NS_ID}/shards/000001`,
        state: 'ready',
        dimension: 4,
        vectorCount: 1,
      })
      expect(await adapter.exists(getShardedStagedManifestPath(BASE_DIR))).toBe(
        false,
      )

      // vectors.f32: exactly dim × 4 bytes (dim = 4).
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      const vectorsBytes = await adapter.readBinary(`${shardRoot}/vectors.f32`)
      expect(vectorsBytes.byteLength).toBe(writeNamespace.dimension * 4)

      // index.bin: COARSE_DIMENSION × 4 bytes; [1,0,0,0] → first coarse dim 1.
      const indexBytes = await adapter.readBinary(`${shardRoot}/index.bin`)
      expect(indexBytes.byteLength).toBe(COARSE_DIMENSION * 4)
      expect(new Float32Array(indexBytes)[0]).toBeCloseTo(1, 5)

      // shard.meta.json carries the same counts as the manifest.
      const shardMeta = JSON.parse(
        await adapter.read(`${shardRoot}/shard.meta.json`),
      )
      expect(shardMeta).toEqual({
        shardId: '000001',
        dimension: 4,
        vectorCount: 1,
      })

      // chunks.sqlite readback via node:sqlite (tombstone === 0).
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const row = runtime.queryOne<{
          chunk_id: string
          file_path: string
          file_mtime: number
          file_content_hash: string
          chunk_content_hash: string
          start_line: number
          end_line: number
          page: number | null
          text: string
          metadata_json: string
          tombstone: number
        }>('select * from chunks where chunk_id = ?', ['c1'])
        expect(row).toMatchObject({
          chunk_id: 'c1',
          file_path: 'notes/a.md',
          file_mtime: 123456789,
          file_content_hash: 'file-hash-1',
          chunk_content_hash: 'hash-c1',
          start_line: 1,
          end_line: 1,
          page: null,
          text: 'alpha',
          metadata_json: '{}',
          tombstone: 0,
        })
      } finally {
        runtime.close()
      }

      // getIndexedFiles sees the file with the recorded mtime.
      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.get('notes/a.md')).toMatchObject({
        mtime: 123456789,
        contentHash: 'file-hash-1',
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('replaceFiles writes multiple files into the current shard', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFiles(writeNamespace, [
        {
          path: 'notes/a.md',
          mtime: 1,
          contentHash: 'ha',
          chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
        },
        {
          path: 'notes/b.md',
          mtime: 2,
          contentHash: 'hb',
          chunks: [chunk('c2', 'beta', [0, 1, 0, 0], 1, 'notes/b.md')],
        },
      ])

      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards).toHaveLength(1)
      expect(manifest.shards[0]?.vectorCount).toBe(2)

      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.get('notes/a.md')?.mtime).toBe(1)
      expect(indexed.get('notes/b.md')?.mtime).toBe(2)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rolls to shards/000002 when the current shard reaches MAX_VECTORS_PER_SHARD', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      const chunks = Array.from({ length: MAX_VECTORS_PER_SHARD + 1 }, (_, i) =>
        chunk(`c${i}`, `text-${i}`, [1, 0, 0, 0], i),
      )
      await store.replaceFile(writeNamespace, {
        path: 'notes/big.md',
        mtime: 7,
        chunks,
      })

      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards.map((shard) => shard.id)).toEqual([
        '000001',
        '000002',
      ])
      expect(manifest.shards[0]?.vectorCount).toBe(MAX_VECTORS_PER_SHARD)
      expect(manifest.shards[1]?.vectorCount).toBe(1)

      const secondRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000002')
      expect(
        (await adapter.readBinary(`${secondRoot}/vectors.f32`)).byteLength,
      ).toBe(writeNamespace.dimension * 4)
      expect(
        (await adapter.readBinary(`${secondRoot}/index.bin`)).byteLength,
      ).toBe(COARSE_DIMENSION * 4)

      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000002'),
      )
      try {
        expect(
          runtime.queryOne<{ n: number }>('select count(*) as n from chunks')
            ?.n,
        ).toBe(1)
      } finally {
        runtime.close()
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('replaceFile of an existing path tombstones old rows and appends the new ones', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 100,
        contentHash: 'hash-v1',
        chunks: [
          chunk('c1', 'old', [1, 0, 0, 0], 1),
          chunk('c2', 'old2', [0, 1, 0, 0], 2),
        ],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 200,
        contentHash: 'hash-v2',
        chunks: [chunk('c3', 'new', [0, 0, 1, 0], 1)],
      })

      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards).toHaveLength(1)
      // Tombstoned rows keep counting toward vectorCount: the artifacts
      // retain their vectors until Task 5's vacuum drops them.
      expect(manifest.shards[0]?.vectorCount).toBe(3)

      // No physical removal: all 3 vectors (old ones as garbage) survive.
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      expect(
        (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
      ).toBe(3 * writeNamespace.dimension * 4)
      expect(
        (await adapter.readBinary(`${shardRoot}/index.bin`)).byteLength,
      ).toBe(3 * COARSE_DIMENSION * 4)

      // Old rows remain tombstoned; the new chunk appends at rowid 3.
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid',
        )
        expect(rows).toEqual([
          { chunk_id: 'c1', tombstone: 1 },
          { chunk_id: 'c2', tombstone: 1 },
          { chunk_id: 'c3', tombstone: 0 },
        ])
        expect(
          runtime.queryOne<{ rowid: number }>('select rowid from chunks')
            ?.rowid,
        ).toBe(1)
      } finally {
        runtime.close()
      }

      // Search sees only the new chunk; the file reports the new write.
      const result = await store.search(writeNamespace, [1, 0, 0, 0], {
        topK: 10,
      })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c3'])
      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.get('notes/a.md')).toMatchObject({
        mtime: 200,
        contentHash: 'hash-v2',
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('getFileReadiness reports vectorReady only for indexed paths', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })

      const readiness = await store.getFileReadiness(writeNamespace, [
        'notes/a.md',
        'notes/missing.md',
        'notes/a.md',
      ])
      expect([...readiness.entries()]).toEqual([
        ['notes/a.md', { path: 'notes/a.md', vectorReady: true }],
        ['notes/missing.md', { path: 'notes/missing.md', vectorReady: false }],
      ])
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects an embedding whose length does not match the shard dimension', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await expect(
        store.replaceFile(writeNamespace, {
          path: 'notes/a.md',
          mtime: 1,
          chunks: [
            {
              ...chunk('c1', 'alpha', [1, 0, 0, 0], 1),
              embedding: [1, 0, 0, 0, 0, 0],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'dimension_mismatch' })
      expect(await adapter.exists(getShardedManifestPath(BASE_DIR))).toBe(false)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('a dimension-mismatched replaceFile on an existing namespace leaves the store fully usable', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFiles(writeNamespace, [
        {
          path: 'notes/a.md',
          mtime: 1,
          contentHash: 'ha',
          chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
        },
        {
          path: 'notes/b.md',
          mtime: 2,
          contentHash: 'hb',
          chunks: [chunk('c2', 'beta', [1, 0, 0, 0], 1, 'notes/b.md')],
        },
      ])

      // Validation happens before any mutation: the mismatched write must
      // not drop a.md's old rows or decrement any vector count.
      await expect(
        store.replaceFile(writeNamespace, {
          path: 'notes/a.md',
          mtime: 3,
          contentHash: 'ha-bad',
          chunks: [
            {
              ...chunk('c3', 'bad', [1, 0, 0, 0], 1),
              embedding: [1, 0, 0, 0, 0, 0, 0, 0],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'dimension_mismatch' })

      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.get('notes/a.md')).toMatchObject({
        mtime: 1,
        contentHash: 'ha',
      })
      expect(indexed.get('notes/b.md')).toMatchObject({
        mtime: 2,
        contentHash: 'hb',
      })
      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards[0]?.vectorCount).toBe(2)
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string }>(
          'select chunk_id from chunks order by rowid',
        )
        expect(rows.map((row) => row.chunk_id)).toEqual(['c1', 'c2'])
      } finally {
        runtime.close()
      }

      // Subsequent valid writes keep working.
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 5,
        contentHash: 'ha2',
        chunks: [chunk('c3', 'new', [1, 0, 0, 0], 1)],
      })
      const after = await store.getIndexedFiles(writeNamespace)
      expect(after.get('notes/a.md')).toMatchObject({
        mtime: 5,
        contentHash: 'ha2',
      })
      expect(after.get('notes/b.md')).toMatchObject({ mtime: 2 })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('an adapter write failure mid-replaceFile rolls back so the file is not reported indexed', async () => {
    const adapter = new WriteFailVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFiles(writeNamespace, [
        {
          path: 'notes/a.md',
          mtime: 1,
          contentHash: 'ha',
          chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
        },
        {
          path: 'notes/b.md',
          mtime: 2,
          contentHash: 'hb',
          chunks: [chunk('c2', 'beta', [1, 0, 0, 0], 1, 'notes/b.md')],
        },
      ])

      // Fail the new chunk's vectors.f32 append — the only vectors.f32 write
      // of this replaceFile: the upsert (c3) already landed while vectors.f32/
      // index.bin still describe c1+c2. The rollback compacts a.md's rows
      // (tombstoned c1 + partial c3) out of the shard.
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      adapter.armWriteBinaryFailure(`${shardRoot}/vectors.f32`, 1)
      await expect(
        store.replaceFile(writeNamespace, {
          path: 'notes/a.md',
          mtime: 10,
          contentHash: 'ha3',
          chunks: [chunk('c3', 'new', [1, 0, 0, 0], 1)],
        }),
      ).rejects.toThrow('injected write failure')

      // Rollback: a.md is fully removed (never half-indexed), b.md intact.
      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.has('notes/a.md')).toBe(false)
      expect(indexed.get('notes/b.md')).toMatchObject({ mtime: 2 })
      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards).toHaveLength(1)
      expect(manifest.shards[0]?.vectorCount).toBe(1)
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string }>(
          'select chunk_id from chunks order by rowid',
        )
        expect(rows.map((row) => row.chunk_id)).toEqual(['c2'])
        expect(
          (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
        ).toBe(writeNamespace.dimension * 4)
      } finally {
        runtime.close()
      }

      // The store remains usable for subsequent writes.
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 11,
        contentHash: 'ha4',
        chunks: [chunk('c4', 'again', [1, 0, 0, 0], 1)],
      })
      const after = await store.getIndexedFiles(writeNamespace)
      expect(after.get('notes/a.md')).toMatchObject({ mtime: 11 })
      expect(after.get('notes/b.md')).toMatchObject({ mtime: 2 })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('an adapter write failure during the insert phase is rolled back into a consistent shard', async () => {
    const adapter = new WriteFailVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFiles(writeNamespace, [
        {
          path: 'notes/a.md',
          mtime: 1,
          chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
        },
        {
          path: 'notes/b.md',
          mtime: 2,
          chunks: [chunk('c2', 'beta', [1, 0, 0, 0], 1, 'notes/b.md')],
        },
      ])

      // Fail the new chunk's coarse-index rewrite: the vectors.f32 append
      // already succeeded, so the shard's two files disagree on count
      // mid-write. The rollback compaction rewrites both from the survivors.
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      adapter.armWriteBinaryFailure(`${shardRoot}/index.bin`, 1)
      await expect(
        store.replaceFile(writeNamespace, {
          path: 'notes/a.md',
          mtime: 10,
          chunks: [chunk('c3', 'new', [1, 0, 0, 0], 1)],
        }),
      ).rejects.toThrow('injected write failure')

      // Rollback compacts a.md's rows out: the file is unindexed, never
      // half-indexed, and the manifest counts match the artifacts.
      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.has('notes/a.md')).toBe(false)
      expect(indexed.get('notes/b.md')).toMatchObject({ mtime: 2 })
      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards[0]?.vectorCount).toBe(1)
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string }>(
          'select chunk_id from chunks order by rowid',
        )
        expect(rows.map((row) => row.chunk_id)).toEqual(['c2'])
        expect(
          (await adapter.readBinary(`${shardRoot}/index.bin`)).byteLength,
        ).toBe(COARSE_DIMENSION * 4)
        expect(
          (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
        ).toBe(writeNamespace.dimension * 4)
      } finally {
        runtime.close()
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('getIndexedFiles/getFileReadiness return empty results before any write', async () => {
    const store = makeStore()
    await store.open()
    expect(await store.getIndexedFiles(writeNamespace)).toEqual(new Map())
    expect(
      await store.getFileReadiness(writeNamespace, ['notes/a.md']),
    ).toEqual(
      new Map([['notes/a.md', { path: 'notes/a.md', vectorReady: false }]]),
    )
  })

  it('replaceFile rejects a different namespace once a manifest exists', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-write-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })
      const otherNamespace: VectorNamespace = {
        provider: 'test',
        model: 'other',
        dimension: 4,
        distanceMetric: 'cosine',
      }
      await expect(
        store.replaceFile(otherNamespace, {
          path: 'notes/b.md',
          mtime: 1,
          chunks: [chunk('c9', 'beta', [1, 0, 0, 0], 1, 'notes/b.md')],
        }),
      ).rejects.toMatchObject({ code: 'namespace_mismatch' })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('ShardedVectorStore search', () => {
  jest.setTimeout(60_000)

  const query = [1, 0, 0, 0]

  /**
   * Strictly decreasing full-vector similarity in write order: chunk i is
   * unit-norm with cosine `1/(i+1)` against [1,0,0,0], so chunk 0 (write
   * order 0) is the most similar and the global sort is exactly the write
   * order. With dim 4 the coarse vector equals the full one, so coarse
   * ranking matches full ranking.
   */
  const monotoneChunks = (count: number, filePath = 'notes/big.md') =>
    Array.from({ length: count }, (_, i) => {
      const x = 1 / (i + 1)
      return chunk(
        `c${i}`,
        `text-${i}`,
        [x, Math.sqrt(1 - x * x), 0, 0],
        i,
        filePath,
      )
    })

  it('spans shards, reranks with full vectors, filters by minSimilarity, and scopes to empty hits', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-search-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/big.md',
        mtime: 7,
        chunks: monotoneChunks(1100),
      })

      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards.map((shard) => shard.id)).toEqual([
        '000001',
        '000002',
      ])
      expect(manifest.shards[0]?.vectorCount).toBe(1000)
      expect(manifest.shards[1]?.vectorCount).toBe(100)

      // Cross-shard retrieval: hits come from a global sort, c0 first.
      const top = await store.search(writeNamespace, query, { topK: 10 })
      expect(top.hits).toHaveLength(10)
      expect(top.hits.map((hit) => hit.chunkId)).toEqual(
        Array.from({ length: 10 }, (_, i) => `c${i}`),
      )
      expect(top.hits[0]?.score).toBeGreaterThan(top.hits[1]?.score ?? 0)
      expect(top.hits[0]).toMatchObject({
        id: 'c0',
        chunkId: 'c0',
        path: 'notes/big.md',
        excerpt: 'text-0',
        source: 'vector',
        metadataJson: {},
      })
      expect(top.hits[0]?.location).toEqual({ lineStart: 0, lineEnd: 0 })
      expect(top.recallCount).toBe(10)
      expect(top.totalCount).toBe(1100)
      expect(top.recallLimit).toBe(500)

      // searchDetailed mirrors search and reports timing breakdowns.
      const detailed = await store.searchDetailed(writeNamespace, query, {
        topK: 10,
      })
      expect(detailed.hits.map((hit) => hit.chunkId)).toEqual(
        top.hits.map((hit) => hit.chunkId),
      )
      expect(typeof detailed.durationMs).toBe('number')
      for (const timing of [
        detailed.timingsMs?.coarseSearch,
        detailed.timingsMs?.loadFullVectors,
        detailed.timingsMs?.rerankSimilarity,
      ]) {
        expect(typeof timing).toBe('number')
      }

      // minSimilarity: scores are 1/(i+1); only c0 and c1 clear 0.4.
      const filtered = await store.search(writeNamespace, query, {
        topK: 1100,
        minSimilarity: 0.4,
      })
      expect(filtered.hits.map((hit) => hit.chunkId)).toEqual(['c0', 'c1'])
      expect(filtered.hits.every((hit) => hit.score >= 0.4)).toBe(true)
      expect(filtered.recallCount).toBe(2)
      expect(filtered.filteredCount).toBe(1098)

      // Scope prefilter: empty folder → empty hits, never rebuild_required.
      const scopedEmpty = await store.search(writeNamespace, query, {
        topK: 10,
        scope: { folders: ['empty-folder'] },
      })
      expect(scopedEmpty.hits).toEqual([])
      const scopedMiss = await store.search(writeNamespace, query, {
        topK: 10,
        scope: { files: ['notes/other.md'] },
      })
      expect(scopedMiss.hits).toEqual([])

      // Scope prefilter: matching folder / file still ranks globally.
      const scopedFolder = await store.search(writeNamespace, query, {
        topK: 5,
        scope: { folders: ['notes'] },
      })
      expect(scopedFolder.hits.map((hit) => hit.chunkId)).toEqual([
        'c0',
        'c1',
        'c2',
        'c3',
        'c4',
      ])
      const scopedFiles = await store.search(writeNamespace, query, {
        topK: 3,
        scope: { files: ['notes/big.md'] },
      })
      expect(scopedFiles.hits.map((hit) => hit.chunkId)).toEqual([
        'c0',
        'c1',
        'c2',
      ])

      // topK <= 0 is an empty result, not an error.
      expect(await store.search(writeNamespace, query, { topK: 0 })).toEqual({
        hits: [],
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('reranks by full-vector similarity so a coarse winner can lose to signal beyond the coarse window', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-rerank-'))
    try {
      const rerankNamespace: VectorNamespace = {
        provider: 'test',
        model: 'm1',
        dimension: 300,
        distanceMetric: 'cosine',
      }
      const make = (
        chunkId: string,
        embedding: number[],
      ): VectorChunkWrite => ({
        chunkId,
        path: 'notes/rerank.md',
        text: chunkId,
        contentHash: `hash-${chunkId}`,
        embedding,
        location: { lineStart: 1, lineEnd: 1 },
        metadataJson: {},
      })
      // cA: strong only inside the 256-dim coarse window; cB: strong only
      // beyond it; cC: moderate everywhere. Coarse ranks cA/cC first, but
      // the full rerank must put cB on top for a query weighted outside the
      // coarse window.
      const strongInWindow = [...Array(256).fill(1), ...Array(44).fill(0)]
      const strongBeyondWindow = [...Array(256).fill(0), ...Array(44).fill(10)]
      const moderateEverywhere = [...Array(256).fill(1), ...Array(44).fill(1)]

      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(rerankNamespace, {
        path: 'notes/rerank.md',
        mtime: 1,
        chunks: [
          make('cA', strongInWindow),
          make('cB', strongBeyondWindow),
          make('cC', moderateEverywhere),
        ],
      })

      const rerankQuery = [...Array(256).fill(1), ...Array(44).fill(100)]
      const result = await store.search(rerankNamespace, rerankQuery, {
        topK: 3,
      })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['cB', 'cC', 'cA'])
      expect(result.hits[0]?.score).toBeGreaterThan(0.99)
      expect(result.hits[1]?.score).toBeGreaterThan(0.3)
      expect(result.hits[1]?.score).toBeLessThan(0.5)
      expect(result.hits[2]?.score).toBeLessThan(0.05)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('merges results from many shards in parallel into one global ordering', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-parallel-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/big.md',
        mtime: 7,
        chunks: monotoneChunks(2505),
      })

      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards.map((shard) => shard.id)).toEqual([
        '000001',
        '000002',
        '000003',
      ])

      const result = await store.search(writeNamespace, query, {
        topK: 2505,
      })
      expect(result.hits).toHaveLength(2505)
      expect(result.hits[0]?.chunkId).toBe('c0')
      expect(result.hits[1000]?.chunkId).toBe('c1000')
      expect(result.hits[2504]?.chunkId).toBe('c2504')
      expect(result.hits.every((hit, i) => hit.chunkId === `c${i}`)).toBe(true)
      expect(result.totalCount).toBe(2505)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('throws rebuild_required when no manifest, all shards empty, or a different active model', async () => {
    const emptyStore = makeStore()
    await emptyStore.open()
    await expect(
      emptyStore.search(writeNamespace, query, { topK: 5 }),
    ).rejects.toMatchObject({
      code: 'rebuild_required',
      recoveryAction: 'rebuild_index',
    })

    // Manifest exists but carries no ready shards with data.
    const adapter = new InMemoryVaultAdapter()
    await adapter.write(
      getShardedManifestPath(BASE_DIR),
      JSON.stringify({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: WRITE_NS_ID,
        updatedAt: 1,
        shards: [],
      }),
    )
    const emptyShardsStore = makeStore(adapter)
    await emptyShardsStore.open()
    await expect(
      emptyShardsStore.search(writeNamespace, query, { topK: 5 }),
    ).rejects.toMatchObject({ code: 'rebuild_required' })

    // Manifest is active for a different namespace.
    const otherAdapter = new InMemoryVaultAdapter()
    await otherAdapter.write(
      getShardedManifestPath(BASE_DIR),
      JSON.stringify({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'other-d4',
        updatedAt: 1,
        shards: [],
      }),
    )
    const otherModelStore = makeStore(otherAdapter)
    await otherModelStore.open()
    await expect(
      otherModelStore.search(writeNamespace, query, { topK: 5 }),
    ).rejects.toMatchObject({ code: 'rebuild_required' })
  })

  it('search before open throws not_open', async () => {
    const store = makeStore()
    await expect(
      store.search(writeNamespace, query, { topK: 5 }),
    ).rejects.toMatchObject({ code: 'not_open' })
  })
})

describe('ShardedVectorStore tombstone deletes', () => {
  jest.setTimeout(60_000)

  const query = [1, 0, 0, 0]

  it('deleteFile tombstones the path: search/getIndexedFiles/getFileReadiness exclude it, artifacts untouched', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-delete-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        contentHash: 'ha',
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/b.md',
        mtime: 2,
        contentHash: 'hb',
        chunks: [
          chunk('c2', 'beta', [0.5, Math.sqrt(0.75), 0, 0], 1, 'notes/b.md'),
        ],
      })
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      const vectorsBefore = await adapter.readBinary(`${shardRoot}/vectors.f32`)
      const indexBefore = await adapter.readBinary(`${shardRoot}/index.bin`)

      await store.deleteFile(writeNamespace, 'notes/a.md')

      // All read paths exclude the tombstoned path.
      const result = await store.search(writeNamespace, query, { topK: 10 })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c2'])
      expect(result.totalCount).toBe(1)
      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.has('notes/a.md')).toBe(false)
      expect(indexed.get('notes/b.md')).toMatchObject({ mtime: 2 })
      const readiness = await store.getFileReadiness(writeNamespace, [
        'notes/a.md',
        'notes/b.md',
      ])
      expect(readiness.get('notes/a.md')?.vectorReady).toBe(false)
      expect(readiness.get('notes/b.md')?.vectorReady).toBe(true)

      // Physical artifacts untouched: byte lengths unchanged.
      expect(
        (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
      ).toBe(vectorsBefore.byteLength)
      expect(
        (await adapter.readBinary(`${shardRoot}/index.bin`)).byteLength,
      ).toBe(indexBefore.byteLength)

      // The chunk row remains, marked tombstone.
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid',
        )
        expect(rows).toEqual([
          { chunk_id: 'c1', tombstone: 1 },
          { chunk_id: 'c2', tombstone: 0 },
        ])
      } finally {
        runtime.close()
      }

      // deleteFiles removes several paths at once; the manifest counts (which
      // include tombstoned rows) stay unchanged.
      const manifestBefore = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      await store.deleteFiles(writeNamespace, ['notes/a.md', 'notes/b.md'])
      expect(
        (await store.search(writeNamespace, query, { topK: 10 })).hits,
      ).toEqual([])
      expect((await store.getIndexedFiles(writeNamespace)).size).toBe(0)
      expect(
        (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
      ).toBe(vectorsBefore.byteLength)
      const manifestAfter = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifestAfter.shards[0]?.vectorCount).toBe(
        manifestBefore.shards[0]?.vectorCount,
      )
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('replaceFile revives a tombstoned path: new chunks searchable, old rows stay as tombstoned garbage', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-revive-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        contentHash: 'ha',
        chunks: [chunk('c1', 'old', [1, 0, 0, 0], 1)],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/b.md',
        mtime: 2,
        contentHash: 'hb',
        chunks: [
          chunk('c2', 'beta', [0.5, Math.sqrt(0.75), 0, 0], 1, 'notes/b.md'),
        ],
      })
      await store.deleteFile(writeNamespace, 'notes/a.md')

      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 3,
        contentHash: 'ha2',
        chunks: [chunk('c3', 'revived', [1 / 3, Math.sqrt(8 / 9), 0, 0], 1)],
      })

      // No physical removal: the old row stays tombstoned and the new chunk
      // appends after it (rowid 3), preserving rowid↔vector alignment.
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      expect(
        (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
      ).toBe(3 * writeNamespace.dimension * 4)
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid',
        )
        expect(rows).toEqual([
          { chunk_id: 'c1', tombstone: 1 },
          { chunk_id: 'c2', tombstone: 0 },
          { chunk_id: 'c3', tombstone: 0 },
        ])
      } finally {
        runtime.close()
      }

      // a.md is searchable again. c3's score (1/3, not c1's 1.0) proves it is
      // read from its real vector at offset 2, not from a shifted live-only
      // list that would map it onto c1's tombstoned vector.
      const result = await store.search(writeNamespace, query, { topK: 10 })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c2', 'c3'])
      expect(result.hits[1]?.score).toBeCloseTo(1 / 3, 5)

      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.get('notes/a.md')).toMatchObject({
        mtime: 3,
        contentHash: 'ha2',
      })
      const readiness = await store.getFileReadiness(writeNamespace, [
        'notes/a.md',
      ])
      expect(readiness.get('notes/a.md')?.vectorReady).toBe(true)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('search across mixed tombstoned/live chunks keeps insertion-order alignment', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-mixed-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      // c1 (score 1.0) and c2 (score 0.5) get tombstoned; c3 (1/3) survives;
      // c4 (0.7) appends after the tombstones. Live order is c3, c4 — a
      // compacted live-only index would read c4 from offset 0 (c1's vector)
      // and score it 1.0 instead of 0.7.
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [chunk('c1', 'gone-strong', [1, 0, 0, 0], 1)],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 2,
        chunks: [chunk('c2', 'gone-mid', [0.5, Math.sqrt(0.75), 0, 0], 1)],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/b.md',
        mtime: 3,
        chunks: [
          chunk('c3', 'kept', [1 / 3, Math.sqrt(8 / 9), 0, 0], 1, 'notes/b.md'),
        ],
      })
      await store.deleteFile(writeNamespace, 'notes/a.md')
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 4,
        chunks: [chunk('c4', 'new', [0.7, Math.sqrt(0.51), 0, 0], 1)],
      })

      const result = await store.search(writeNamespace, query, { topK: 10 })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c4', 'c3'])
      expect(result.hits[0]?.score).toBeCloseTo(0.7, 5)
      expect(result.hits[1]?.score).toBeCloseTo(1 / 3, 5)
      expect(result.totalCount).toBe(2)

      // Scope prefilter over a file with tombstoned + live chunks considers
      // only the live chunk.
      const scoped = await store.search(writeNamespace, query, {
        topK: 10,
        scope: { files: ['notes/a.md'] },
      })
      expect(scoped.hits.map((hit) => hit.chunkId)).toEqual(['c4'])
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('deleteFile on a non-existent path (or a namespace with nothing indexed) is a no-op', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-noop-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()

      // No manifest at all: resolves without error and creates nothing.
      await expect(
        store.deleteFile(writeNamespace, 'notes/nope.md'),
      ).resolves.toBeUndefined()
      await expect(
        store.deleteFiles(writeNamespace, []),
      ).resolves.toBeUndefined()
      expect(await adapter.exists(getShardedManifestPath(BASE_DIR))).toBe(false)

      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })

      // Non-existent path inside a populated namespace: no-op.
      await expect(
        store.deleteFile(writeNamespace, 'notes/nope.md'),
      ).resolves.toBeUndefined()
      const result = await store.search(writeNamespace, query, { topK: 10 })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c1'])
      expect(
        (await store.getIndexedFiles(writeNamespace)).has('notes/a.md'),
      ).toBe(true)
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        expect(
          runtime.queryOne<{ n: number }>(
            'select count(*) as n from chunks where tombstone = 1',
          )?.n,
        ).toBe(0)
      } finally {
        runtime.close()
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rewrite that keeps an unchanged chunk revives it in place: no duplicate vector, alignment kept', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sharded-revive-id-'),
    )
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        contentHash: 'hash-v1',
        chunks: [
          chunk('c1', 'alpha', [1, 0, 0, 0], 1),
          chunk('c2', 'beta', [0.5, Math.sqrt(0.75), 0, 0], 2),
        ],
      })

      // Rewrite keeps c1 UNCHANGED (same chunk_id — real chunk ids embed the
      // content hash) and adds a new chunk c3. The revive must update c1's
      // tombstoned row in place; appending a second vector for c1 would break
      // rowid↔offset alignment and hard-corrupt the shard.
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 2,
        contentHash: 'hash-v2',
        chunks: [
          chunk('c1', 'alpha', [1, 0, 0, 0], 1),
          chunk('c3', 'gamma', [1 / 3, Math.sqrt(8 / 9), 0, 0], 3),
        ],
      })

      // Search works (no database_corrupt) with correct ordering and scores:
      // c1 keeps its original vector (offset 0, score 1.0), c3 reads offset 2.
      const result = await store.search(writeNamespace, query, { topK: 10 })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c1', 'c3'])
      expect(result.hits[0]?.score).toBeCloseTo(1, 5)
      expect(result.hits[1]?.score).toBeCloseTo(1 / 3, 5)
      expect(result.totalCount).toBe(2)

      // Rows == vectors: vectorCount equals the row count and the artifacts
      // match byte-for-byte (3 rows, 3 vectors — not 4).
      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards[0]?.vectorCount).toBe(3)
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      expect(
        (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
      ).toBe(3 * writeNamespace.dimension * 4)
      expect(
        (await adapter.readBinary(`${shardRoot}/index.bin`)).byteLength,
      ).toBe(3 * COARSE_DIMENSION * 4)

      // c1 revived at its original rowid 1; c2 stays tombstoned; c3 appended.
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid',
        )
        expect(rows).toEqual([
          { chunk_id: 'c1', tombstone: 0 },
          { chunk_id: 'c2', tombstone: 1 },
          { chunk_id: 'c3', tombstone: 0 },
        ])
      } finally {
        runtime.close()
      }

      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.get('notes/a.md')).toMatchObject({
        mtime: 2,
        contentHash: 'hash-v2',
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('a revived chunk stays in its original shard even when new chunks append to a later shard', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-revive-x-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      // 1001 chunks: c0..c999 fill shard 1, c1000 rolls to shard 2.
      // Embeddings are strictly decreasing in similarity to [1,0,0,0]:
      // chunk i scores 1/(i+1), so write order == global sort order.
      const chunks = Array.from({ length: 1001 }, (_, i) => {
        const x = 1 / (i + 1)
        return chunk(
          `c${i}`,
          `text-${i}`,
          [x, Math.sqrt(1 - x * x), 0, 0],
          i,
          'notes/big.md',
        )
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/big.md',
        mtime: 1,
        chunks,
      })

      // Rewrite keeps c0 unchanged (revived in shard 1) and adds c1001, which
      // must append to shard 2 (shard 1 is full) — not collide with c0.
      await store.replaceFile(writeNamespace, {
        path: 'notes/big.md',
        mtime: 2,
        contentHash: 'hash-v2',
        chunks: [
          chunk('c0', 'text-0', [1, 0, 0, 0], 0, 'notes/big.md'),
          chunk(
            'c1001',
            'text-1001',
            [1 / 1002, Math.sqrt(1 - 1 / 1002 ** 2), 0, 0],
            1001,
            'notes/big.md',
          ),
        ],
      })

      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards.map((shard) => shard.id)).toEqual([
        '000001',
        '000002',
      ])
      expect(manifest.shards[0]?.vectorCount).toBe(1000)
      expect(manifest.shards[1]?.vectorCount).toBe(2)

      // c0 is live in shard 1 at rowid 1; the rest of shard 1 is tombstoned.
      const shardOneRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      const runtimeOne = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtimeOne.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid limit 2',
        )
        expect(rows).toEqual([
          { chunk_id: 'c0', tombstone: 0 },
          { chunk_id: 'c1', tombstone: 1 },
        ])
        expect(
          (await adapter.readBinary(`${shardOneRoot}/vectors.f32`)).byteLength,
        ).toBe(1000 * writeNamespace.dimension * 4)
      } finally {
        runtimeOne.close()
      }

      // shard 2: old c1000 tombstoned, new c1001 live.
      const shardTwoRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000002')
      const runtimeTwo = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000002'),
      )
      try {
        const rows = runtimeTwo.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid',
        )
        expect(rows).toEqual([
          { chunk_id: 'c1000', tombstone: 1 },
          { chunk_id: 'c1001', tombstone: 0 },
        ])
        expect(
          (await adapter.readBinary(`${shardTwoRoot}/vectors.f32`)).byteLength,
        ).toBe(2 * writeNamespace.dimension * 4)
      } finally {
        runtimeTwo.close()
      }

      // Search: exactly one hit per chunk_id, global order c0 then c1001.
      const result = await store.search(writeNamespace, query, { topK: 10 })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c0', 'c1001'])
      expect(result.hits[0]?.score).toBeCloseTo(1, 5)
      expect(result.hits[1]?.score).toBeCloseTo(1 / 1002, 5)
      expect(result.totalCount).toBe(2)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('ShardedVectorStore vacuum', () => {
  jest.setTimeout(60_000)

  const query = [1, 0, 0, 0]

  it('rebuilds shards without tombstones, drops old shard dirs, and keeps search live-only', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-vacuum-'))
    try {
      const adapter = new SqliteSyncVaultAdapter(tempRoot)
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      // a.md (c1) + b.md (c2) → tombstone a.md → append c.md (c3).
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        contentHash: 'ha',
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/b.md',
        mtime: 2,
        contentHash: 'hb',
        chunks: [
          chunk('c2', 'beta', [0.5, Math.sqrt(0.75), 0, 0], 1, 'notes/b.md'),
        ],
      })
      await store.deleteFile(writeNamespace, 'notes/a.md')
      await store.replaceFile(writeNamespace, {
        path: 'notes/c.md',
        mtime: 3,
        contentHash: 'hc',
        chunks: [chunk('c3', 'gamma', [1, 0, 0, 0], 1, 'notes/c.md')],
      })

      const before = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(before.shards[0]?.vectorCount).toBe(3)

      const result = await store.vacuum(writeNamespace)
      expect(result).toEqual({ removedFiles: 1, removedChunks: 1 })

      // Manifest: only live rows count now; the rebuilt shard id continues
      // past the old sequence's max (000001 → 000002) so the old dir was
      // never touched before the publish.
      const after = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(after.shards.map((shard) => shard.id)).toEqual(['000002'])
      expect(
        after.shards.reduce((sum, shard) => sum + shard.vectorCount, 0),
      ).toBe(2)
      expect(after.shards[0]?.dimension).toBe(writeNamespace.dimension)

      // Old shard dirs removed: artifacts hold exactly the live vectors.
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000002')
      expect(
        (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
      ).toBe(2 * writeNamespace.dimension * 4)
      expect(
        (await adapter.readBinary(`${shardRoot}/index.bin`)).byteLength,
      ).toBe(2 * COARSE_DIMENSION * 4)
      const shardsListing = await adapter.list(
        `${getShardedModelRoot(BASE_DIR, WRITE_NS_ID)}/shards`,
      )
      expect(shardsListing.folders).toEqual(['000002'])

      // chunks.sqlite physically compacted: no tombstone rows remain.
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000002'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid',
        )
        expect(rows).toEqual([
          { chunk_id: 'c2', tombstone: 0 },
          { chunk_id: 'c3', tombstone: 0 },
        ])
        expect(
          runtime.queryOne<{ n: number }>(
            'select count(*) as n from chunks where tombstone = 1',
          )?.n,
        ).toBe(0)
      } finally {
        runtime.close()
      }

      // Search returns only live content with correct scores.
      const searchResult = await store.search(writeNamespace, query, {
        topK: 10,
      })
      expect(searchResult.hits.map((hit) => hit.chunkId)).toEqual(['c3', 'c2'])
      expect(searchResult.totalCount).toBe(2)
      expect(searchResult.hits[0]?.score).toBeCloseTo(1, 5)
      expect(searchResult.hits[1]?.score).toBeCloseTo(0.5, 5)
      const indexed = await store.getIndexedFiles(writeNamespace)
      expect(indexed.has('notes/a.md')).toBe(false)
      expect(indexed.has('notes/b.md')).toBe(true)
      expect(indexed.has('notes/c.md')).toBe(true)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('vacuum on a namespace without a manifest (or with another active model) is a no-op', async () => {
    const adapter = new InMemoryVaultAdapter()
    const store = makeStore(adapter)
    await store.open()
    expect(await store.vacuum(writeNamespace)).toEqual({
      removedFiles: 0,
      removedChunks: 0,
    })
    // All-namespaces vacuum on an empty store is also a no-op.
    expect(await store.vacuum()).toEqual({ removedFiles: 0, removedChunks: 0 })
    expect(await adapter.exists(getShardedManifestPath(BASE_DIR))).toBe(false)

    // A manifest active for a different model makes the vacuum a no-op too.
    await adapter.write(
      getShardedManifestPath(BASE_DIR),
      JSON.stringify({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'other-d4',
        updatedAt: 1,
        shards: [],
      }),
    )
    const otherStore = makeStore(adapter)
    await otherStore.open()
    expect(await otherStore.vacuum(writeNamespace)).toEqual({
      removedFiles: 0,
      removedChunks: 0,
    })
    expect(
      parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      ).activeModel,
    ).toBe('other-d4')
  })

  it('preserves search correctness across the rebuild (rowid↔offset intact)', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-vacuum-'))
    try {
      const adapter = new SqliteSyncVaultAdapter(tempRoot)
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      // Mixed tombstones: c1 (score 1.0) and c2 (0.5) tombstoned, c3 (1/3)
      // live, c4 (0.7) appended after the tombstones.
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [chunk('c1', 'gone-strong', [1, 0, 0, 0], 1)],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 2,
        chunks: [chunk('c2', 'gone-mid', [0.5, Math.sqrt(0.75), 0, 0], 1)],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/b.md',
        mtime: 3,
        chunks: [
          chunk('c3', 'kept', [1 / 3, Math.sqrt(8 / 9), 0, 0], 1, 'notes/b.md'),
        ],
      })
      await store.deleteFile(writeNamespace, 'notes/a.md')
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 4,
        chunks: [chunk('c4', 'new', [0.7, Math.sqrt(0.51), 0, 0], 1)],
      })

      const before = await store.search(writeNamespace, query, { topK: 10 })
      expect(before.hits.map((hit) => hit.chunkId)).toEqual(['c4', 'c3'])

      // a.md still owns a live chunk (c4), so no file is fully removed.
      expect(await store.vacuum(writeNamespace)).toEqual({
        removedFiles: 0,
        removedChunks: 2,
      })

      // Identical ordering and scores after the rebuild: each vector stayed
      // glued to its row across the compaction.
      const afterSearch = await store.search(writeNamespace, query, {
        topK: 10,
      })
      expect(afterSearch.hits.map((hit) => hit.chunkId)).toEqual(['c4', 'c3'])
      expect(afterSearch.hits[0]?.score).toBeCloseTo(0.7, 5)
      expect(afterSearch.hits[1]?.score).toBeCloseTo(1 / 3, 5)
      expect(afterSearch.totalCount).toBe(2)

      // Physically compacted: only the live rows survive.
      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(
        manifest.shards.reduce((sum, shard) => sum + shard.vectorCount, 0),
      ).toBe(2)
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000002'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid',
        )
        expect(rows).toEqual([
          { chunk_id: 'c3', tombstone: 0 },
          { chunk_id: 'c4', tombstone: 0 },
        ])
      } finally {
        runtime.close()
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('returns accurate removedFiles/removedChunks counts', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-vacuum-'))
    try {
      const adapter = new SqliteSyncVaultAdapter(tempRoot)
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [
          chunk('c1', 'a1', [1, 0, 0, 0], 1),
          chunk('c2', 'a2', [0.5, Math.sqrt(0.75), 0, 0], 2),
        ],
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/b.md',
        mtime: 2,
        chunks: [
          chunk('c3', 'b1', [1 / 3, Math.sqrt(8 / 9), 0, 0], 1, 'notes/b.md'),
        ],
      })
      await store.deleteFile(writeNamespace, 'notes/a.md')

      // a.md fully tombstoned (2 chunks), b.md still live.
      expect(await store.vacuum(writeNamespace)).toEqual({
        removedFiles: 1,
        removedChunks: 2,
      })
      const search = await store.search(writeNamespace, query, { topK: 10 })
      expect(search.hits.map((hit) => hit.chunkId)).toEqual(['c3'])

      // A second vacuum finds nothing to remove.
      expect(await store.vacuum(writeNamespace)).toEqual({
        removedFiles: 0,
        removedChunks: 0,
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('a mid-build failure leaves old manifest, old shard dirs, and search intact; a re-run compacts', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sharded-vacuum-fail-'),
    )
    try {
      const adapter = new FailVacuumSecondBatchAdapter(tempRoot)
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      // 1100 live chunks fill shards 000001 (1000) + 000002 (100); a small
      // file's chunk appends to 000002 and is then tombstoned, so the
      // rebuild needs two batches and has real garbage to compact.
      const chunks = Array.from({ length: 1100 }, (_, i) => {
        const x = 1 / (i + 1)
        return chunk(`c${i}`, `text-${i}`, [x, Math.sqrt(1 - x * x), 0, 0], i)
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/big.md',
        mtime: 1,
        chunks,
      })
      await store.replaceFile(writeNamespace, {
        path: 'notes/small.md',
        mtime: 2,
        chunks: [
          chunk(
            'c1100',
            'small',
            [1 / 1101, Math.sqrt(1 - 1 / 1101 ** 2), 0, 0],
            1,
            'notes/small.md',
          ),
        ],
      })
      await store.deleteFile(writeNamespace, 'notes/small.md')

      const manifestBefore = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifestBefore.shards.map((shard) => shard.id)).toEqual([
        '000001',
        '000002',
      ])
      expect(
        manifestBefore.shards.reduce(
          (sum, shard) => sum + shard.vectorCount,
          0,
        ),
      ).toBe(1101)

      // The second batch's vectors.f32 write fails: the first batch already
      // built, and on the pre-fix code already replaced its old shard dir.
      adapter.failSecondVacuumBatch()
      await expect(store.vacuum(writeNamespace)).rejects.toThrow(
        'injected vacuum build failure',
      )

      // Old manifest untouched and still searchable: same shards, same hits.
      const manifestAfter = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifestAfter.shards.map((shard) => shard.id)).toEqual([
        '000001',
        '000002',
      ])
      const searchAfter = await store.search(writeNamespace, query, {
        topK: 10,
      })
      expect(searchAfter.totalCount).toBe(1100)
      expect(searchAfter.hits.map((hit) => hit.chunkId)).toEqual([
        'c0',
        'c1',
        'c2',
        'c3',
        'c4',
        'c5',
        'c6',
        'c7',
        'c8',
        'c9',
      ])

      // Old shard dirs intact; no temp dirs left behind.
      expect(
        await adapter.exists(
          getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001'),
        ),
      ).toBe(true)
      expect(
        await adapter.exists(
          getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000002'),
        ),
      ).toBe(true)
      const shardsAfter = await adapter.list(
        `${getShardedModelRoot(BASE_DIR, WRITE_NS_ID)}/shards`,
      )
      expect(shardsAfter.folders).toEqual(['000001', '000002'])

      // A re-run succeeds and compacts: tombstone dropped, shards rebuilt.
      expect(await store.vacuum(writeNamespace)).toEqual({
        removedFiles: 1,
        removedChunks: 1,
      })
      const manifestCompacted = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(
        manifestCompacted.shards.reduce(
          (sum, shard) => sum + shard.vectorCount,
          0,
        ),
      ).toBe(1100)
      const finalSearch = await store.search(writeNamespace, query, {
        topK: 10,
      })
      expect(finalSearch.totalCount).toBe(1100)
      expect(finalSearch.hits[0]?.chunkId).toBe('c0')
      const shardsFinal = await adapter.list(
        `${getShardedModelRoot(BASE_DIR, WRITE_NS_ID)}/shards`,
      )
      expect(shardsFinal.folders).toEqual(['000003', '000004'])
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('ShardedVectorStore read-write locking', () => {
  jest.setTimeout(60_000)

  /**
   * Races a promise against a fallback after `ms`, canceling the timer on
   * either outcome so a lost race never leaves a live handle behind.
   */
  const withTimeout = <T>(
    promise: Promise<T>,
    ms: number,
    fallback: T,
  ): Promise<T> => {
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer != null) clearTimeout(timer)
    })
  }

  it('a search concurrent with a mid-write replaceFile waits and never observes the half-written shard', async () => {
    const adapter = new BlockVectorsWriteVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-lock-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })

      // Park the second file's vectors.f32 append: its chunks.sqlite row
      // (c2) is already inserted while vectors.f32/index.bin still describe
      // c1 only — the exact window that would surface as a byteLength
      // database_corrupt mismatch or stale hits without the write lease.
      adapter.blockNextVectorsWrite()
      const writePromise = store.replaceFile(writeNamespace, {
        path: 'notes/b.md',
        mtime: 2,
        contentHash: 'hb',
        chunks: [chunk('c2', 'beta', [0, 1, 0, 0], 1, 'notes/b.md')],
      })
      await adapter.waitUntilBlocked()

      // The search must stay queued on the read lease while the write is
      // parked — it cannot race past and observe the half-written shard.
      const searchPromise = store.search(writeNamespace, [1, 0, 0, 0], {
        topK: 10,
      })
      await expect(
        withTimeout(
          searchPromise.then(() => 'done'),
          200,
          'pending',
        ),
      ).resolves.toBe('pending')

      adapter.releaseBlockedWrite()
      await writePromise
      const result = await searchPromise
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c1', 'c2'])
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('concurrent searches run in parallel, not serialized by the read lease', async () => {
    const adapter = new ParkNextReadVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-lock-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/big.md',
        mtime: 1,
        chunks: Array.from({ length: 40 }, (_, i) =>
          chunk(`c${i}`, `text-${i}`, [1, 0, 0, 0], i),
        ),
      })

      // Park the first search at its manifest read (holding a read lease),
      // then start a second search: it must be admitted immediately and
      // reach its own manifest read while the first is still parked.
      adapter.armParkNextRead()
      const searchA = store.search(writeNamespace, [1, 0, 0, 0], { topK: 5 })
      await adapter.waitUntilParked()

      const searchB = store.search(writeNamespace, [1, 0, 0, 0], { topK: 5 })
      const concurrent = await withTimeout(
        adapter.waitForConcurrentRead(),
        2000,
        false,
      )
      expect(concurrent).toBe(true)

      adapter.releaseParkedRead()
      const [resultA, resultB] = await Promise.all([searchA, searchB])
      expect(resultA.hits.map((hit) => hit.chunkId)).toEqual(
        resultB.hits.map((hit) => hit.chunkId),
      )
      expect(resultA.hits).toHaveLength(5)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('a failed search releases its read lease so a subsequent write is not blocked', async () => {
    const adapter = new InMemoryVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-lock-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })

      // Corrupt index.bin so the search fails mid-lease (database_corrupt).
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      await adapter.writeBinary(`${shardRoot}/index.bin`, new ArrayBuffer(4))
      await expect(
        store.search(writeNamespace, [1, 0, 0, 0], { topK: 5 }),
      ).rejects.toMatchObject({ code: 'database_corrupt' })

      // The stale read lease must not deadlock the next writer.
      await store.replaceFile(writeNamespace, {
        path: 'notes/b.md',
        mtime: 2,
        contentHash: 'hb',
        chunks: [chunk('c2', 'beta', [0, 1, 0, 0], 1, 'notes/b.md')],
      })
      const manifest = parseShardedManifest(
        JSON.parse(await adapter.read(getShardedManifestPath(BASE_DIR))),
      )
      expect(manifest.shards[0]?.vectorCount).toBe(2)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('a failed replaceFile releases its write lease so a subsequent search is not blocked', async () => {
    const adapter = new WriteFailVaultAdapter()
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-lock-'))
    try {
      const store = makeStoreWithTempSqlite(adapter, tempRoot)
      await store.open()
      await store.replaceFile(writeNamespace, {
        path: 'notes/a.md',
        mtime: 1,
        chunks: [chunk('c1', 'alpha', [1, 0, 0, 0], 1)],
      })

      // Fail the vectors.f32 append of a second file mid-write.
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      adapter.armWriteBinaryFailure(`${shardRoot}/vectors.f32`, 1)
      await expect(
        store.replaceFile(writeNamespace, {
          path: 'notes/b.md',
          mtime: 2,
          contentHash: 'hb',
          chunks: [chunk('c2', 'beta', [0, 1, 0, 0], 1, 'notes/b.md')],
        }),
      ).rejects.toThrow('injected write failure')

      // The stale write lease must not deadlock the next search.
      const result = await store.search(writeNamespace, [1, 0, 0, 0], {
        topK: 5,
      })
      expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c1'])
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('shard sqlite openers', () => {
  it('openShardSqliteNode opens a real sqlite database on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-sqlite-'))
    try {
      const dbPath = path.join(dir, 'chunks.sqlite')
      const runtime = openShardSqliteNode(dbPath)
      runtime.exec('create table chunks (chunk_id text primary key, text text)')
      runtime.exec('insert into chunks (chunk_id, text) values (?, ?)', [
        'c1',
        'alpha',
      ])
      expect(
        runtime.queryOne<{ text: string }>(
          'select text from chunks where chunk_id = ?',
          ['c1'],
        )?.text,
      ).toBe('alpha')
      expect(runtime.getStatus().isOpen).toBe(true)
      runtime.close()
      expect(runtime.getStatus().isOpen).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('openShardSqliteWasm throws until wired in Task 6', () => {
    expect(() => openShardSqliteWasm('/vault/.yolo/shard.sqlite')).toThrow(
      'openShardSqliteWasm is wired in Task 6',
    )
  })
})
