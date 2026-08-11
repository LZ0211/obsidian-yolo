jest.mock('obsidian')

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemAdapter } from 'obsidian'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'

import { openMemoryIndexStore } from './memoryIndex'
import { buildMemoryPartition } from './memoryIndex'
import type { MemoryIndexMaintenanceStore } from './memoryIndex'
import {
  MemoryIndexRuntime,
  closeMemoryIndexRuntime,
  getMemoryIndexRuntime,
  getMemoryIndexRuntimeHandle,
  getMemoryIndexStore,
  resolveMemoryRename,
} from './memoryIndexRuntime'
import type { MemorySourceSnapshot } from './memoryManager'

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }

  override getBasePath(): string {
    return this.basePath
  }
}

describe('memory index runtime adapter', () => {
  it('keeps an app runtime registered until asynchronous close settles', async () => {
    const app = { vault: {} } as never
    const getSettings = () => ({ advancedMemoryIndexEnabled: false })
    const runtime = getMemoryIndexRuntime(app, getSettings)
    let resolveClose!: () => void
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    jest.spyOn(runtime, 'close').mockReturnValue(closePromise)

    const closing = closeMemoryIndexRuntime(app)

    expect(getMemoryIndexRuntime(app, getSettings)).toBe(runtime)

    resolveClose()
    await closing
    expect(getMemoryIndexRuntime(app, getSettings)).not.toBe(runtime)
    await closeMemoryIndexRuntime(app)
  })

  it('does not return a store after close begins while the store is opening', async () => {
    let resolveStore!: (store: MemoryIndexMaintenanceStore) => void
    const storePromise = new Promise<MemoryIndexMaintenanceStore>((resolve) => {
      resolveStore = resolve
    })
    const store = {
      capability: 'sqlite' as const,
      close: jest.fn(async () => undefined),
    } as unknown as MemoryIndexMaintenanceStore
    const runtime = new MemoryIndexRuntime({ vault: {} } as never, () => ({
      advancedMemoryIndexEnabled: true,
    }))
    const privateRuntime = runtime as unknown as {
      storePromise: Promise<MemoryIndexMaintenanceStore>
    }
    privateRuntime.storePromise = storePromise

    const pendingStore = runtime.getStore()
    const closing = runtime.close()
    resolveStore(store)

    await expect(pendingStore).resolves.toMatchObject({
      capability: 'unavailable',
    })
    await closing
    expect(store.close).toHaveBeenCalledTimes(1)
  })

  it('force-closes a store when queue draining times out', async () => {
    const forceClose = jest.fn()
    const store = {
      capability: 'sqlite' as const,
      forceClose,
      close: jest.fn(async () => undefined),
    } as unknown as MemoryIndexMaintenanceStore
    const runtime = new MemoryIndexRuntime({ vault: {} } as never, () => ({
      advancedMemoryIndexEnabled: true,
    }))
    const privateRuntime = runtime as unknown as {
      storePromise: Promise<MemoryIndexMaintenanceStore>
      queue: { shutdown: () => Promise<boolean> } | null
    }
    privateRuntime.storePromise = Promise.resolve(store)
    privateRuntime.queue = {
      shutdown: async () => true,
    }

    await runtime.close()

    expect(forceClose).toHaveBeenCalledTimes(1)
    expect(store.close).not.toHaveBeenCalled()
  })

  it('deletes a removed assistant partition from the derived store', async () => {
    const deletePartition = jest.fn(async () => undefined)
    const store = {
      capability: 'sqlite' as const,
      deletePartition,
    } as unknown as MemoryIndexMaintenanceStore
    const runtime = new MemoryIndexRuntime({ vault: {} } as never, () => ({
      advancedMemoryIndexEnabled: true,
    }))
    const privateRuntime = runtime as unknown as {
      storePromise: Promise<MemoryIndexMaintenanceStore>
    }
    privateRuntime.storePromise = Promise.resolve(store)

    runtime.onAssistantRemoved('assistant-removed')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(deletePartition).toHaveBeenCalledWith(
      buildMemoryPartition({
        scope: 'assistant',
        assistantId: 'assistant-removed',
      }),
    )
    await runtime.close()
  })

  it('never reconciles a rename into an unmanaged new path', () => {
    const indexedPartition = buildMemoryPartition({
      scope: 'assistant',
      assistantId: 'agent-1',
    })
    const resolution = resolveMemoryRename({
      settings: {
        yolo: { baseDir: 'YOLO' },
        assistants: [{ id: 'agent-1', name: 'Agent' }],
      },
      newPath: 'notes/not-memory.md',
      oldPath: 'YOLO/memory/Agent.md',
      indexedPartition,
    })

    expect(resolution.reconcilePartition).toBeNull()
    expect(resolution.cleanupPartition).toEqual(indexedPartition)
  })

  it('shares one app-scoped store and disables it through current settings', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-index-registry-'),
    )
    const app = {
      vault: { adapter: new TestFileSystemAdapter(root) },
    } as never
    let enabled = true
    const getSettings = () => ({
      advancedMemoryIndexEnabled: enabled,
      yolo: { baseDir: 'YOLO' },
      assistants: [],
    })
    try {
      const handle = getMemoryIndexRuntimeHandle(app, getSettings)
      const first = await handle.getStore()
      const second = await getMemoryIndexStore(app, getSettings)
      expect(first).toBe(second)
      expect(first.capability).toBe('sqlite')

      enabled = false
      expect((await handle.getStore()).capability).toBe('unavailable')
    } finally {
      await closeMemoryIndexRuntime(app)
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      })
    }
  })

  it('reconciles source rows and rejects stale fingerprints', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-runtime-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    let snapshot: MemorySourceSnapshot = {
      partition,
      sourcePath: 'YOLO/memory/global.md',
      sourceFileFingerprint: 'file-1',
      parserVersion: 'parser-1',
      valid: true,
      entries: [
        {
          localId: 'Memory_1',
          content: 'Remember tea',
          keywords: ['tea'],
          category: 'other',
          partition,
          sourcePath: 'YOLO/memory/global.md',
          entryFingerprint: 'entry-1',
        },
      ],
    }
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => snapshot,
      clock: () => 100,
    })
    try {
      expect(store.capability).toBe('sqlite')
      await store.reconcilePartition({
        partition,
        sourcePath: snapshot.sourcePath,
        sourceFileFingerprint: snapshot.sourceFileFingerprint,
        parserVersion: snapshot.parserVersion,
        entries: snapshot.entries,
        sectorHints: {
          'global::Memory_1': 'procedural',
        },
      })
      expect(
        await store.query({
          partition,
          sourceFileFingerprint: 'wrong',
          target: {
            query: 'tea',
            keywords: ['tea'],
            entities: [],
            categories: ['other'],
            scopes: ['global'],
            sector: null,
            confidence: 1,
            isReferential: false,
            source: 'lexical',
          },
          maxEntries: 99,
          maxChars: 99999,
        }),
      ).toHaveLength(0)
      expect(
        await store.query({
          partition,
          sourceFileFingerprint: 'file-1',
          target: {
            query: 'tea',
            keywords: ['tea'],
            entities: [],
            categories: ['other'],
            scopes: ['global'],
            sector: null,
            confidence: 1,
            isReferential: false,
            source: 'lexical',
          },
          maxEntries: 99,
          maxChars: 99999,
        }),
      ).toHaveLength(1)
      snapshot = {
        ...snapshot,
        sourceFileFingerprint: 'file-2',
        entries: [
          {
            ...snapshot.entries[0],
            content: 'Remember coffee',
            entryFingerprint: 'entry-2',
          },
        ],
      }
      await store.reconcilePartition({
        partition,
        sourcePath: snapshot.sourcePath,
        sourceFileFingerprint: snapshot.sourceFileFingerprint,
        parserVersion: snapshot.parserVersion,
        entries: snapshot.entries,
        sectorHints: {
          'global::Memory_1': null,
        },
      })
      const updatedEntries = await store.query({
        partition,
        sourceFileFingerprint: 'file-2',
        target: {
          query: 'coffee',
          keywords: ['coffee'],
          entities: [],
          categories: ['other'],
          scopes: ['global'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        },
        maxEntries: 8,
        maxChars: 3000,
      })
      expect(updatedEntries[0]?.content).toBe('Remember coffee')
      expect(updatedEntries[0]?.sector).toBe('procedural')
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prioritizes target keyword matches over unrelated high-salience rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-query-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const entries = [
      {
        localId: 'Memory_related',
        content: 'A related target memory',
        keywords: [],
        category: 'other' as const,
        partition,
        sourcePath: 'global.md',
        entryFingerprint: 'related-v1',
      },
      {
        localId: 'Memory_unrelated',
        content: 'An unrelated memory',
        keywords: ['noise'],
        category: 'other' as const,
        partition,
        sourcePath: 'global.md',
        entryFingerprint: 'unrelated-v1',
      },
    ]
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => ({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'file-v1',
        parserVersion: 'parser-v1',
        entries,
        valid: true,
      }),
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'file-v1',
        parserVersion: 'parser-v1',
        entries,
      })
      for (let index = 0; index < 10; index += 1) {
        await store.reinforce({
          partition,
          localId: 'Memory_unrelated',
          nowMs: index + 1,
        })
      }

      const rows = await store.query({
        partition,
        sourceFileFingerprint: 'file-v1',
        target: {
          query: 'target',
          keywords: ['target'],
          entities: [],
          categories: ['other'],
          scopes: ['global'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        },
        maxEntries: 1,
        maxChars: 3000,
      })

      expect(rows.map(({ id }) => id)).toEqual(['Memory_related'])
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps prior rows after a failed transaction and marks the partition dirty', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-index-rollback-'),
    )
    const partition = buildMemoryPartition({ scope: 'global' })
    let snapshot: MemorySourceSnapshot = {
      partition,
      sourcePath: 'global.md',
      sourceFileFingerprint: 'one',
      parserVersion: 'one',
      valid: true,
      entries: [
        {
          localId: 'Memory_1',
          content: 'stable',
          keywords: [],
          category: 'other',
          partition,
          sourcePath: 'global.md',
          entryFingerprint: 'one',
        },
      ],
    }
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => snapshot,
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'one',
        parserVersion: 'one',
        entries: snapshot.entries,
      })
      snapshot = {
        ...snapshot,
        sourceFileFingerprint: 'two',
        entries: [
          {
            ...snapshot.entries[0],
            category: 'not-a-category' as never,
            entryFingerprint: 'two',
          },
        ],
      }
      await expect(
        store.reconcilePartition({
          partition,
          sourcePath: 'global.md',
          sourceFileFingerprint: 'two',
          parserVersion: 'one',
          entries: snapshot.entries,
        }),
      ).rejects.toThrow()
      expect(
        await store.query({
          partition,
          sourceFileFingerprint: 'one',
          target: {
            query: '',
            keywords: [],
            entities: [],
            categories: ['other'],
            scopes: ['global'],
            sector: null,
            confidence: 1,
            isReferential: false,
            source: 'lexical',
          },
          maxEntries: 8,
          maxChars: 3000,
        }),
      ).toHaveLength(0)
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves edges for unchanged rows and removes them for changed rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-edges-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const first = {
      localId: 'Memory_1',
      content: 'first',
      keywords: [],
      category: 'other' as const,
      partition,
      sourcePath: 'global.md',
      entryFingerprint: 'first-v1',
    }
    const second = {
      ...first,
      localId: 'Memory_2',
      content: 'second',
      entryFingerprint: 'second-v1',
    }
    let snapshot: MemorySourceSnapshot = {
      partition,
      sourcePath: 'global.md',
      sourceFileFingerprint: 'file-v1',
      parserVersion: 'p',
      valid: true,
      entries: [first, second],
    }
    const app = {
      vault: { adapter: new TestFileSystemAdapter(root) },
    } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => snapshot,
    })
    const dbPath = path.join(root, 'YOLO', 'memory', 'index.sqlite')
    const countEdges = (): number => {
      const runtime = openSqliteRuntime({ dbPath })
      try {
        return (
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_edges where partition_key = ?',
            [partition.partitionKey],
          )?.count ?? 0
        )
      } finally {
        runtime.close()
      }
    }
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: snapshot.sourcePath,
        sourceFileFingerprint: snapshot.sourceFileFingerprint,
        parserVersion: snapshot.parserVersion,
        entries: snapshot.entries,
      })
      const runtime = openSqliteRuntime({ dbPath })
      runtime.exec(
        'insert into memory_edges (partition_key, src_local_id, dst_local_id, weight, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
        [partition.partitionKey, 'Memory_1', 'Memory_2', 0.8, 1, 1],
      )
      runtime.close()
      snapshot = { ...snapshot, sourceFileFingerprint: 'file-v2' }
      await store.reconcilePartition({
        partition,
        sourcePath: snapshot.sourcePath,
        sourceFileFingerprint: snapshot.sourceFileFingerprint,
        parserVersion: snapshot.parserVersion,
        entries: snapshot.entries,
      })
      expect(countEdges()).toBe(1)
      snapshot = {
        ...snapshot,
        sourceFileFingerprint: 'file-v3',
        entries: [{ ...first, entryFingerprint: 'first-v2' }, second],
      }
      await store.reconcilePartition({
        partition,
        sourcePath: snapshot.sourcePath,
        sourceFileFingerprint: snapshot.sourceFileFingerprint,
        parserVersion: snapshot.parserVersion,
        entries: snapshot.entries,
      })
      expect(countEdges()).toBe(0)
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('isolates identical local IDs and updates source paths across partitions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-scope-'))
    const global = buildMemoryPartition({ scope: 'global' })
    const assistant = buildMemoryPartition({
      scope: 'assistant',
      assistantId: 'assistant-1',
    })
    const snapshots = new Map<string, MemorySourceSnapshot>([
      [
        global.partitionKey,
        {
          partition: global,
          sourcePath: 'global.md',
          sourceFileFingerprint: 'g',
          parserVersion: 'p',
          valid: true,
          entries: [
            {
              localId: 'Memory_1',
              content: 'global',
              keywords: [],
              category: 'other',
              partition: global,
              sourcePath: 'global.md',
              entryFingerprint: 'g1',
            },
          ],
        },
      ],
      [
        assistant.partitionKey,
        {
          partition: assistant,
          sourcePath: 'assistant-renamed.md',
          sourceFileFingerprint: 'a',
          parserVersion: 'p',
          valid: true,
          entries: [
            {
              localId: 'Memory_1',
              content: 'assistant',
              keywords: [],
              category: 'other',
              partition: assistant,
              sourcePath: 'assistant-renamed.md',
              entryFingerprint: 'a1',
            },
          ],
        },
      ],
    ])
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async (partition) =>
        snapshots.get(partition.partitionKey)!,
    })
    try {
      for (const snapshot of snapshots.values())
        await store.reconcilePartition({
          partition: snapshot.partition,
          sourcePath: snapshot.sourcePath,
          sourceFileFingerprint: snapshot.sourceFileFingerprint,
          parserVersion: snapshot.parserVersion,
          entries: snapshot.entries,
        })
      expect(
        await store.query({
          partition: global,
          sourceFileFingerprint: 'g',
          target: {
            query: '',
            keywords: [],
            entities: [],
            categories: ['other'],
            scopes: ['global'],
            sector: null,
            confidence: 1,
            isReferential: false,
            source: 'lexical',
          },
          maxEntries: 8,
          maxChars: 3000,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'global' }),
        ]),
      )
      expect(
        await store.query({
          partition: assistant,
          sourceFileFingerprint: 'a',
          target: {
            query: '',
            keywords: [],
            entities: [],
            categories: ['other'],
            scopes: ['assistant'],
            sector: null,
            confidence: 1,
            isReferential: false,
            source: 'lexical',
          },
          maxEntries: 8,
          maxChars: 3000,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'assistant' }),
        ]),
      )
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not mutate rows for invalid or oversized source snapshots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-invalid-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const validEntry = {
      localId: 'Memory_1',
      content: 'stable',
      keywords: [],
      category: 'other' as const,
      partition,
      sourcePath: 'global.md',
      entryFingerprint: 'one',
    }
    let snapshot: MemorySourceSnapshot = {
      partition,
      sourcePath: 'global.md',
      sourceFileFingerprint: 'one',
      parserVersion: 'p',
      valid: true,
      entries: [validEntry],
    }
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => snapshot,
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'one',
        parserVersion: 'p',
        entries: [validEntry],
      })
      snapshot = { ...snapshot, valid: false, sourceFileFingerprint: 'bad' }
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'bad',
        parserVersion: 'p',
        entries: [],
      })
      expect(
        await store.query({
          partition,
          sourceFileFingerprint: 'one',
          target: {
            query: '',
            keywords: [],
            entities: [],
            categories: ['other'],
            scopes: ['global'],
            sector: null,
            confidence: 1,
            isReferential: false,
            source: 'lexical',
          },
          maxEntries: 8,
          maxChars: 3000,
        }),
      ).toHaveLength(0)
      snapshot = {
        ...snapshot,
        valid: true,
        entries: Array.from({ length: 20_001 }, (_, index) => ({
          ...validEntry,
          localId: `Memory_${index}`,
          entryFingerprint: String(index),
        })),
      }
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'too-many',
        parserVersion: 'p',
        entries: snapshot.entries,
      })
      expect(
        await store.query({
          partition,
          sourceFileFingerprint: 'too-many',
          target: {
            query: '',
            keywords: [],
            entities: [],
            categories: ['other'],
            scopes: ['global'],
            sector: null,
            confidence: 1,
            isReferential: false,
            source: 'lexical',
          },
          maxEntries: 8,
          maxChars: 3000,
        }),
      ).toHaveLength(0)
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reopens after database loss and switches base directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-reopen-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const entry = {
      localId: 'Memory_1',
      content: 'rebuild',
      keywords: [],
      category: 'other' as const,
      partition,
      sourcePath: 'global.md',
      entryFingerprint: 'one',
    }
    let baseDir = 'YOLO'
    const snapshot: MemorySourceSnapshot = {
      partition,
      sourcePath: 'global.md',
      sourceFileFingerprint: 'one',
      parserVersion: 'p',
      valid: true,
      entries: [entry],
    }
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: baseDir } }),
      getSourceSnapshot: async () => snapshot,
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'one',
        parserVersion: 'p',
        entries: [entry],
      })
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(path.join(root, 'YOLO'), { recursive: true, force: true })
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'one',
        parserVersion: 'p',
        entries: [entry],
      })
      baseDir = 'YOLO-2'
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'one',
        parserVersion: 'p',
        entries: [entry],
      })
      expect(
        fs.existsSync(path.join(root, 'YOLO-2', 'memory', 'index.sqlite')),
      ).toBe(true)
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
