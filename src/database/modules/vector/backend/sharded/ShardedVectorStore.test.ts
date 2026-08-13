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
      store.deleteFile(testNamespace, 'a.md'),
      store.deleteFiles?.(testNamespace, ['a.md']),
      store.clearNamespace(testNamespace),
      store.vacuum(testNamespace),
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

  it('replaceFile of an existing path drops old chunk rows and compacts the shard', async () => {
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
      expect(manifest.shards[0]?.vectorCount).toBe(1)

      // Vectors/index compacted back to a single chunk.
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      expect(
        (await adapter.readBinary(`${shardRoot}/vectors.f32`)).byteLength,
      ).toBe(writeNamespace.dimension * 4)
      expect(
        (await adapter.readBinary(`${shardRoot}/index.bin`)).byteLength,
      ).toBe(COARSE_DIMENSION * 4)

      // Only c3 survives; rowids restart at 1, aligned with the compacted file.
      const runtime = openShardSqliteNode(
        tempChunksDbPath(tempRoot, WRITE_NS_ID, '000001'),
      )
      try {
        const rows = runtime.query<{ chunk_id: string; tombstone: number }>(
          'select chunk_id, tombstone from chunks order by rowid',
        )
        expect(rows.map((row) => row.chunk_id)).toEqual(['c3'])
        expect(
          runtime.queryOne<{ rowid: number }>('select rowid from chunks')
            ?.rowid,
        ).toBe(1)
      } finally {
        runtime.close()
      }

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

      // Fail the insert-phase vectors.f32 append: the 1st vectors.f32 write
      // of this replaceFile is the compaction rewrite, the 2nd is the new
      // chunk's append — after the upsert but before the count increment.
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      adapter.armWriteBinaryFailure(`${shardRoot}/vectors.f32`, 2)
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

  it('an adapter write failure during the compaction phase is rolled back into a consistent shard', async () => {
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

      // Fail the compaction's first write (index.bin rewrite).
      const shardRoot = getShardedShardRoot(BASE_DIR, WRITE_NS_ID, '000001')
      adapter.armWriteBinaryFailure(`${shardRoot}/index.bin`, 1)
      await expect(
        store.replaceFile(writeNamespace, {
          path: 'notes/a.md',
          mtime: 10,
          chunks: [chunk('c3', 'new', [1, 0, 0, 0], 1)],
        }),
      ).rejects.toThrow('injected write failure')

      // Rollback re-runs the compaction: the file is unindexed, never
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
