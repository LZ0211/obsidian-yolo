import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  type VectorNamespace,
  VectorStoreError,
} from '../../../rag/VectorStore'

import {
  getShardedIndexRoot,
  getShardedManifestPath,
  getShardedModelRoot,
} from './shardedPaths'
import { openShardSqliteNode, openShardSqliteWasm } from './shardedSqlite'
import { ShardedVectorStore } from './ShardedVectorStore'

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
      store.replaceFile(testNamespace, {
        path: 'a.md',
        mtime: 1,
        chunks: [],
      }),
      store.replaceFiles?.(testNamespace, []),
      store.deleteFile(testNamespace, 'a.md'),
      store.deleteFiles?.(testNamespace, ['a.md']),
      store.clearNamespace(testNamespace),
      store.vacuum(testNamespace),
      store.search(testNamespace, [1, 0, 0, 0], { topK: 1 }),
      store.searchDetailed?.(testNamespace, [1, 0, 0, 0], { topK: 1 }),
      store.getStats(testNamespace),
      store.getIndexedFiles?.(testNamespace),
      store.getFileReadiness?.(testNamespace, ['a.md']),
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
