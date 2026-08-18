jest.mock('obsidian')

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemAdapter } from 'obsidian'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'

import { MemoryEmbeddingStore } from './memoryEmbeddings'
import { openMemoryIndexStore } from './memoryIndex'
import { buildMemoryPartition } from './memoryIndex'
import type { MemoryIndexMaintenanceStore } from './memoryIndex'
import {
  MemoryIndexRuntime,
  closeMemoryIndexRuntime,
  getMemoryIndexRuntime,
  getMemoryIndexRuntimeHandle,
  getMemoryIndexStore,
  planMemorySettingsReconcile,
  resolveMemoryRename,
} from './memoryIndexRuntime'
import { MemoryIndexMaintenanceQueue } from './memoryIndexMaintenanceQueue'
import type { MemorySourceSnapshot } from './memoryManager'
import { MemoryRecallOrchestrator } from './memoryRecallOrchestrator'
import type { MemoryPartition } from './memoryTypes'

jest.mock('./memoryJiebaTokenizer', () => ({
  cutForSearchWithJieba: jest.fn(async () => ['minimal', 'design']),
}))

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

  it('creates a live runtime when the index is re-enabled during async close', async () => {
    const app = { vault: {} } as never
    let enabled = true
    const getSettings = () => ({ advancedMemoryIndexEnabled: enabled })
    const runtime = getMemoryIndexRuntime(app, getSettings)
    let resolveStoreClose!: () => void
    const storeClose = new Promise<void>((resolve) => {
      resolveStoreClose = resolve
    })
    const store = {
      capability: 'sqlite' as const,
      close: jest.fn(() => storeClose),
    } as unknown as MemoryIndexMaintenanceStore
    const privateRuntime = runtime as unknown as {
      storePromise: Promise<MemoryIndexMaintenanceStore>
    }
    privateRuntime.storePromise = Promise.resolve(store)

    enabled = false
    const closing = closeMemoryIndexRuntime(app)
    enabled = true

    const reopened = getMemoryIndexRuntime(app, getSettings)

    expect(reopened).not.toBe(runtime)

    resolveStoreClose()
    await closing
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

  it('deletes a removed assistant partition when disabling the index', async () => {
    const deletePartition = jest.fn(async () => undefined)
    const store = {
      capability: 'sqlite' as const,
      deletePartition,
    } as unknown as MemoryIndexMaintenanceStore
    let enabled = true
    const runtime = new MemoryIndexRuntime({ vault: {} } as never, () => ({
      advancedMemoryIndexEnabled: enabled,
    }))
    const privateRuntime = runtime as unknown as {
      storePromise: Promise<MemoryIndexMaintenanceStore>
    }
    privateRuntime.storePromise = Promise.resolve(store)

    enabled = false
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

  it('plans assistant removal cleanup and full reconciles from a settings change', () => {
    const plan = planMemorySettingsReconcile({
      previousAssistantIds: ['agent-1', 'agent-2', 'agent-3'],
      settings: {
        yolo: { baseDir: 'YOLO' },
        advancedMemoryIndexEnabled: true,
        assistants: [
          { id: 'agent-2', name: 'Agent 2' },
          { id: 'agent-3', name: 'Agent 3' },
        ],
      },
    })

    expect(plan.removedAssistantIds).toEqual(['agent-1'])
    expect(plan.reconciles).toEqual(
      expect.arrayContaining([
        {
          partition: buildMemoryPartition({ scope: 'global' }),
          sourcePath: 'YOLO/memory/global.md',
        },
        {
          partition: buildMemoryPartition({
            scope: 'assistant',
            assistantId: 'agent-2',
          }),
          sourcePath: 'YOLO/memory/Agent 2.md',
        },
        {
          partition: buildMemoryPartition({
            scope: 'assistant',
            assistantId: 'agent-3',
          }),
          sourcePath: 'YOLO/memory/Agent 3.md',
        },
      ]),
    )
    expect(plan.reconciles).toHaveLength(3)
  })

  it('plans only assistant cleanup when the advanced index is disabled', () => {
    const plan = planMemorySettingsReconcile({
      previousAssistantIds: ['agent-1'],
      settings: {
        advancedMemoryIndexEnabled: false,
        assistants: [],
      },
    })

    expect(plan.removedAssistantIds).toEqual(['agent-1'])
    expect(plan.reconciles).toEqual([])
  })

  it('runs periodic maintenance for every tracked partition', async () => {
    const enqueueMaintenance = jest.fn()
    const runtime = new MemoryIndexRuntime({ vault: {} } as never, () => ({
      advancedMemoryIndexEnabled: true,
    }))
    const privateRuntime = runtime as unknown as {
      queue: {
        enqueueMaintenance: jest.Mock
        shutdown: () => Promise<boolean>
      } | null
      knownPartitions: Map<string, MemoryPartition>
    }
    privateRuntime.knownPartitions.set(
      'global',
      buildMemoryPartition({ scope: 'global' }),
    )
    privateRuntime.knownPartitions.set(
      'assistant:a',
      buildMemoryPartition({ scope: 'assistant', assistantId: 'a' }),
    )
    privateRuntime.queue = {
      enqueueMaintenance,
      shutdown: async () => false,
    }

    await runtime.runPeriodicMaintenance()

    expect(enqueueMaintenance).toHaveBeenCalledWith(
      buildMemoryPartition({ scope: 'global' }),
    )
    expect(enqueueMaintenance).toHaveBeenCalledWith(
      buildMemoryPartition({ scope: 'assistant', assistantId: 'a' }),
    )
    expect(enqueueMaintenance).toHaveBeenCalledTimes(2)
    await runtime.close()
  })

  it('does not run maintenance at startup — only the reconcile is queued', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const order: string[] = []
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
    privateRuntime.storePromise = Promise.resolve(store)
    const enqueueMaintenance = jest
      .spyOn(MemoryIndexMaintenanceQueue.prototype, 'enqueueMaintenance')
      .mockImplementation(() => {
        order.push('maintenance')
      })
    const enqueueReconcile = jest
      .spyOn(MemoryIndexMaintenanceQueue.prototype, 'enqueueReconcile')
      .mockImplementation(() => {
        order.push('reconcile')
      })

    try {
      runtime.onSourceCommitted({
        partition,
        sourcePath: 'YOLO/memory/global.md',
      })
      await new Promise<void>((resolve) => setImmediate(resolve))

      // Startup must not fan decay/archive work out across partitions; the
      // first maintenance pass is scheduled on the interval instead.
      expect(order).toEqual(['reconcile'])
    } finally {
      enqueueMaintenance.mockRestore()
      enqueueReconcile.mockRestore()
      await runtime.close()
    }
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

      const orderedRows = await store.query({
        partition,
        sourceFileFingerprint: 'file-v1',
        target: {
          query: 'unrelated',
          keywords: ['unrelated'],
          entities: [],
          categories: ['other'],
          scopes: ['global'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        },
        memoryKeys: ['global::Memory_unrelated', 'global::Memory_related'],
        maxEntries: 2,
        maxChars: 3000,
      })
      expect(orderedRows.map(({ id }) => id)).toEqual([
        'Memory_unrelated',
        'Memory_related',
      ])
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

describe('vector recall path write-through', () => {
  const makeEntry = (
    localId: string,
    content: string,
    partition: MemoryPartition,
    fingerprint = `${localId}-v1`,
  ) => ({
    localId,
    content,
    keywords: [],
    category: 'other' as const,
    partition,
    sourcePath: 'global.md',
    entryFingerprint: fingerprint,
  })

  it('persists embeddings during reconcile and returns vector recall hits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vector-write-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const fingerprint = 'file-v1'
    const entries = [
      makeEntry('Memory_minimal', '用户偏好极简风格的设计', partition),
      makeEntry('Memory_unrelated', '一段与查询无关的记忆', partition),
    ]
    const embedContent = jest.fn(
      async (content: string): Promise<number[]> =>
        content.includes('极简') ? [1, 0, 0, 0] : [0, 1, 0, 0],
    )
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => ({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
        valid: true,
      }),
      embedContent,
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
      })
      const runtime = await store.getRuntime()
      const rows = runtime.query<{ memory_key: string }>(
        'select memory_key from memory_embeddings where partition_key = ? order by memory_key',
        [partition.partitionKey],
      )
      expect(rows.map(({ memory_key }) => memory_key)).toEqual([
        'global::Memory_minimal',
        'global::Memory_unrelated',
      ])
      expect(embedContent).toHaveBeenCalledWith('用户偏好极简风格的设计')

      const orchestrator = new MemoryRecallOrchestrator(
        store as never,
        new MemoryEmbeddingStore(runtime),
        async () => [1, 0, 0, 0],
      )
      const context = await orchestrator.recall(
        { latestQuery: '极简', recentUserMessages: ['极简'] },
        partition,
        fingerprint,
      )
      expect(context.paths).toContain('vector')
      expect(context.entries.map(({ memoryKey }) => memoryKey)).toContain(
        'global::Memory_minimal',
      )
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reconcile completes when embedContent never settles so the operationChain cannot stall', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vector-hang-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const fingerprint = 'file-v1'
    const entries = [
      makeEntry('Memory_hang', '永不返回的嵌入请求', partition),
    ]
    // A hung embedding call (never resolves, never rejects) must not pin
    // the serialized operationChain — later store.query calls await it.
    const embedContent = jest.fn(() => new Promise<number[]>(() => undefined))
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => ({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
        valid: true,
      }),
      embedContent,
      embedTimeoutMs: 100,
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
      })

      // The chain must remain usable after the timeout degradation.
      const runtime = await store.getRuntime()
      const rows = runtime.query<{ memory_key: string }>(
        'select memory_key from memory_embeddings where partition_key = ?',
        [partition.partitionKey],
      )
      expect(rows).toEqual([])
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops vectors of removed entries and keeps embeddings of unchanged entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vector-remove-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const first = makeEntry('Memory_keep', 'keep me', partition, 'keep-v1')
    const second = makeEntry('Memory_gone', 'remove me', partition, 'gone-v1')
    const embedContent = jest.fn(async (content: string): Promise<number[]> => {
      const buffer = new ArrayBuffer(4)
      new Float32Array(buffer).set([content.length])
      return Array.from(new Float32Array(buffer))
    })
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    let snapshot: MemorySourceSnapshot = {
      partition,
      sourcePath: 'global.md',
      sourceFileFingerprint: 'file-v1',
      parserVersion: 'p',
      entries: [first, second],
      valid: true,
    }
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => snapshot,
      embedContent,
    })
    const memoryKeys = (): Promise<string[]> =>
      store.getRuntime().then((runtime) =>
        runtime
          .query<{
            memory_key: string
          }>(
            'select memory_key from memory_embeddings where partition_key = ? order by memory_key',
            [partition.partitionKey],
          )
          .map(({ memory_key }) => memory_key),
      )
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'file-v1',
        parserVersion: 'p',
        entries: [first, second],
      })
      snapshot = {
        ...snapshot,
        sourceFileFingerprint: 'file-v2',
        entries: [first],
      }
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'file-v2',
        parserVersion: 'p',
        entries: [first],
      })
      expect(await memoryKeys()).toEqual(['global::Memory_keep'])
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops all vectors when a memory partition is deleted', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-vector-partition-delete-'),
    )
    const partition = buildMemoryPartition({
      scope: 'assistant',
      assistantId: 'assistant-removed',
    })
    const entry = makeEntry('Memory_old', 'old memory', partition)
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => ({
        partition,
        sourcePath: 'assistant.md',
        sourceFileFingerprint: 'file-v1',
        parserVersion: 'p',
        entries: [entry],
        valid: true,
      }),
      embedContent: async () => [1, 0, 0, 0],
    })

    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'assistant.md',
        sourceFileFingerprint: 'file-v1',
        parserVersion: 'p',
        entries: [entry],
      })
      const runtime = await store.getRuntime()
      expect(
        runtime.query<{ memory_key: string }>(
          'select memory_key from memory_embeddings where partition_key = ?',
          [partition.partitionKey],
        ),
      ).toHaveLength(1)

      await store.deletePartition(partition)

      expect(
        runtime.query<{ memory_key: string }>(
          'select memory_key from memory_embeddings where partition_key = ?',
          [partition.partitionKey],
        ),
      ).toHaveLength(0)
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('recall reinforce wiring', () => {
  const waitFor = async (
    predicate: () => Promise<boolean>,
    timeoutMs = 2000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('timed out waiting for condition')
  }

  it('recall strengthens matched entries and refreshes last_recalled_at', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reinforce-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const entries = [
      {
        localId: 'Memory_minimal',
        content: '用户偏好极简风格的设计',
        keywords: ['minimal'],
        category: 'preferences' as const,
        partition,
        sourcePath: 'global.md',
        entryFingerprint: 'minimal-v1',
      },
      {
        localId: 'Memory_noise',
        content: '一段与查询无关的记忆',
        keywords: ['noise'],
        category: 'other' as const,
        partition,
        sourcePath: 'global.md',
        entryFingerprint: 'noise-v1',
      },
    ]
    const fingerprint = 'file-v1'
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => ({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
        valid: true,
      }),
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
      })
      const orchestrator = new MemoryRecallOrchestrator(
        store as never,
        new MemoryEmbeddingStore(await store.getRuntime()),
        async () => null,
      )
      const context = await orchestrator.recall(
        {
          latestQuery: 'minimal design',
          recentUserMessages: ['minimal design'],
          assistantId: undefined,
        },
        partition,
        fingerprint,
      )
      expect(context.entries.map((entry) => entry.memoryKey)).toEqual(
        expect.arrayContaining(['global::Memory_minimal']),
      )

      const row = (localId: string) =>
        store.getRuntime().then((runtime) =>
          runtime.queryOne<{
            salience: number
            last_recalled_at: number | null
          }>(
            'select salience, last_recalled_at from memory_index where partition_key = ? and local_id = ?',
            [partition.partitionKey, localId],
          ),
        )

      await waitFor(
        async () => ((await row('Memory_minimal'))?.salience ?? 0) > 0.5,
      )
      expect((await row('Memory_minimal'))?.last_recalled_at).not.toBeNull()
      expect((await row('Memory_noise'))?.salience).toBe(0.5)
      expect((await row('Memory_noise'))?.last_recalled_at).toBeNull()
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('memory salience decay', () => {
  it('decays salience by elapsed time and keeps updated_at stable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-decay-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const entry = {
      localId: 'Memory_stale',
      content: '长期未用的记忆',
      keywords: ['stale'],
      category: 'other' as const,
      partition,
      sourcePath: 'global.md',
      entryFingerprint: 'stale-v1',
    }
    const fingerprint = 'file-v1'
    const t0 = Date.parse('2026-08-01T00:00:00Z')
    const clock = jest.fn(() => t0)
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => ({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries: [entry],
        valid: true,
      }),
      clock,
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries: [entry],
      })
      const before = await store.getRuntime().then((runtime) =>
        runtime.queryOne<{
          salience: number
          updated_at: number
        }>(
          'select salience, updated_at from memory_index where partition_key = ? and local_id = ?',
          [partition.partitionKey, 'Memory_stale'],
        ),
      )
      expect(before?.salience).toBe(0.5)

      await (
        store as MemoryIndexMaintenanceStore & {
          applyDecay(input: {
            partition: MemoryPartition
            nowMs: number
          }): Promise<void>
        }
      ).applyDecay({ partition, nowMs: t0 + 30 * 86_400_000 })

      const after = await store.getRuntime().then((runtime) =>
        runtime.queryOne<{
          salience: number
          updated_at: number
        }>(
          'select salience, updated_at from memory_index where partition_key = ? and local_id = ?',
          [partition.partitionKey, 'Memory_stale'],
        ),
      )
      expect(after?.salience).toBeLessThan(0.5)
      expect(after?.salience).toBeGreaterThan(0)
      expect(after?.updated_at).toBe(before?.updated_at)
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('cold memory archive', () => {
  const makeEntry = (
    localId: string,
    content: string,
    keywords: string[],
    category: 'profile' | 'preferences' | 'other',
    partition: MemoryPartition,
  ) => ({
    localId,
    content,
    keywords,
    category,
    partition,
    sourcePath: 'global.md',
    entryFingerprint: `${localId}-v1`,
  })

  it('excludes stale low-salience entries from recall and drops their vectors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cold-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const fingerprint = 'file-v1'
    const entries = [
      makeEntry('Memory_cold', '很久没用的记忆', ['cold'], 'other', partition),
      makeEntry('Memory_fresh', '新的记忆', ['fresh'], 'other', partition),
      makeEntry(
        'Memory_hot',
        '经常命中的记忆',
        ['hot'],
        'preferences',
        partition,
      ),
    ]
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => ({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
        valid: true,
      }),
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
      })
      const runtime = await store.getRuntime()
      const now = Date.now()
      runtime.exec(
        'update memory_index set salience = ?, last_recalled_at = ? where partition_key = ? and local_id = ?',
        [0.08, now - 40 * 86_400_000, partition.partitionKey, 'Memory_cold'],
      )
      runtime.exec(
        'update memory_index set last_recalled_at = ? where partition_key = ? and local_id = ?',
        [now - 2 * 86_400_000, partition.partitionKey, 'Memory_hot'],
      )

      const embeddings = new MemoryEmbeddingStore(runtime)
      embeddings.upsert(
        {
          partitionKey: partition.partitionKey,
          memoryKey: 'global::Memory_cold',
          localId: 1,
        },
        Array(4).fill(0.1),
      )
      embeddings.upsert(
        {
          partitionKey: partition.partitionKey,
          memoryKey: 'global::Memory_fresh',
          localId: 2,
        },
        Array(4).fill(0.2),
      )

      const results = await store.query({
        partition,
        sourceFileFingerprint: fingerprint,
        target: {
          query: '记忆',
          keywords: ['记忆'],
          entities: [],
          categories: ['profile', 'preferences', 'other'],
          scopes: ['global'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        } as never,
        maxEntries: 8,
        maxChars: 3000,
      })
      const keys = results.map((entry) => entry.memoryKey)
      expect(keys).not.toContain('global::Memory_cold')
      expect(keys).toEqual(
        expect.arrayContaining(['global::Memory_fresh', 'global::Memory_hot']),
      )

      await (
        store as MemoryIndexMaintenanceStore & {
          archiveColdEntries(input: {
            partition: MemoryPartition
          }): Promise<void>
        }
      ).archiveColdEntries({ partition })

      const coldVector = runtime.queryOne<{ memory_key: string }>(
        'select memory_key from memory_embeddings where partition_key = ? and memory_key = ?',
        [partition.partitionKey, 'global::Memory_cold'],
      )
      const freshVector = runtime.queryOne<{ memory_key: string }>(
        'select memory_key from memory_embeddings where partition_key = ? and memory_key = ?',
        [partition.partitionKey, 'global::Memory_fresh'],
      )
      expect(coldVector).toBeUndefined()
      expect(freshVector).not.toBeUndefined()
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * Pre-03b377087 v2 DDL (dead hash-band/consolidated columns included).
 * Kept verbatim so the migration test exercises the exact legacy shape the
 * old schema creator produced.
 */
const LEGACY_V2_SCHEMA_SQL: readonly string[] = [
  `create table if not exists memory_schema_meta (
    key text primary key,
    value text not null
  );`,
  `create table if not exists memory_index (
    partition_key text not null,
    memory_key text not null unique,
    scope text not null check (scope in ('global', 'assistant')),
    assistant_id text,
    local_id text not null,
    category text not null check (category in ('profile', 'preferences', 'other')),
    sector text not null check (sector in ('episodic', 'semantic', 'procedural', 'emotional', 'reflective')),
    content text not null,
    keywords_json text not null,
    content_hash text not null,
    hash_band_0 integer not null,
    hash_band_1 integer not null,
    hash_band_2 integer not null,
    hash_band_3 integer not null,
    salience real not null default 0.5 check (salience >= 0 and salience <= 1),
    last_recalled_at integer,
    created_at integer not null,
    updated_at integer not null,
    source_path text not null,
    source_file_fingerprint text not null,
    entry_fingerprint text not null,
    parser_version text not null,
    consolidated integer not null default 0 check (consolidated in (0, 1)),
    primary key (partition_key, local_id),
    check ((scope = 'global' and assistant_id is null) or
           (scope = 'assistant' and assistant_id is not null))
  );`,
  `create index if not exists idx_memory_partition_score
    on memory_index(partition_key, category, salience, updated_at);`,
  `create index if not exists idx_memory_partition_hash
    on memory_index(partition_key, hash_band_0, hash_band_1, hash_band_2, hash_band_3);`,
  `create table if not exists memory_keywords (
    partition_key text not null,
    local_id text not null,
    keyword text not null,
    primary key (partition_key, local_id, keyword),
    foreign key (partition_key, local_id)
      references memory_index(partition_key, local_id) on delete cascade
  );`,
  `create index if not exists idx_memory_keyword_lookup
    on memory_keywords(partition_key, keyword);`,
  `create table if not exists memory_edges (
    partition_key text not null,
    src_local_id text not null,
    dst_local_id text not null,
    weight real not null check (weight >= 0 and weight <= 1),
    created_at integer not null,
    updated_at integer not null,
    primary key (partition_key, src_local_id, dst_local_id),
    check (src_local_id <> dst_local_id),
    foreign key (partition_key, src_local_id)
      references memory_index(partition_key, local_id) on delete cascade,
    foreign key (partition_key, dst_local_id)
      references memory_index(partition_key, local_id) on delete cascade
  );`,
  `create table if not exists memory_reflections (
    partition_key text not null,
    reflection_id text not null,
    content text not null,
    sector text not null check (sector = 'reflective'),
    source_keys_json text not null,
    source_fingerprint text not null,
    prompt_version text not null,
    created_at integer not null,
    updated_at integer not null,
    primary key (partition_key, reflection_id),
    unique (partition_key, source_fingerprint, prompt_version)
  );`,
  `create table if not exists memory_partition_state (
    partition_key text primary key,
    source_path text not null,
    source_file_fingerprint text not null,
    parser_version text not null,
    dirty_reason text,
    last_reconciled_at integer,
    last_reflection_at integer,
    updated_at integer not null
  );`,
  `create table if not exists memory_maintenance_log (
    id integer primary key,
    partition_key text,
    operation text not null,
    status text not null check (status in ('started', 'completed', 'failed')),
    source_file_fingerprint text,
    created_at integer not null
  );`,
  `create table if not exists memory_embeddings (
    partition_key text not null,
    memory_key text not null,
    local_id integer not null,
    embedding blob not null,
    dimension integer not null,
    updated_at integer not null,
    primary key (partition_key, memory_key)
  );`,
]

describe('legacy schema migration (v2 → v3 dead columns)', () => {
  it('migrates a legacy database so reconcile inserts succeed and data survives', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-migrate-'))
    const dbPath = path.join(root, 'YOLO', 'memory', 'index.sqlite')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const legacy = openSqliteRuntime({ dbPath })
    try {
      for (const sql of LEGACY_V2_SCHEMA_SQL) legacy.exec(sql)
      legacy.exec(
        "insert into memory_schema_meta (key, value) values ('schema_version', '2')",
      )
      legacy.exec(
        `insert into memory_index
         (partition_key, memory_key, scope, assistant_id, local_id, category, sector, content, keywords_json,
          content_hash, hash_band_0, hash_band_1, hash_band_2, hash_band_3, salience, last_recalled_at,
          created_at, updated_at, source_path, source_file_fingerprint, entry_fingerprint, parser_version, consolidated)
         values ('global', 'global::Memory_1', 'global', null, 'Memory_1', 'other', 'episodic', 'legacy preserved', '[]',
          'h', 1, 2, 3, 4, 0.5, null, 1, 2, 'global.md', 'fp-v1', 'e-v1', 'p', 0)`,
      )
    } finally {
      legacy.close()
    }

    const partition = buildMemoryPartition({ scope: 'global' })
    const entry = {
      localId: 'Memory_1',
      content: 'legacy preserved',
      keywords: [],
      category: 'other' as const,
      partition,
      sourcePath: 'global.md',
      entryFingerprint: 'e-v1',
    }
    const snapshot: MemorySourceSnapshot = {
      partition,
      sourcePath: 'global.md',
      sourceFileFingerprint: 'fp-v1',
      parserVersion: 'p',
      entries: [entry],
      valid: true,
    }
    const app = { vault: { adapter: new TestFileSystemAdapter(root) } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => snapshot,
    })
    try {
      expect(store.capability).toBe('sqlite')
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'fp-v1',
        parserVersion: 'p',
        entries: [entry],
      })
      const runtime = await (store as MemoryIndexMaintenanceStore).getRuntime()
      const row = runtime.queryOne<{ content: string }>(
        'select content from memory_index where partition_key = ? and local_id = ?',
        ['global', 'Memory_1'],
      )
      expect(row?.content).toBe('legacy preserved')
      expect(
        runtime.queryOne<{ value: string }>(
          "select value from memory_schema_meta where key = 'schema_version'",
        )?.value,
      ).toBe('3')
      const columns = runtime
        .query<{ name: string }>('pragma table_info(memory_index)')
        .map(({ name }) => name)
      expect(columns).not.toContain('hash_band_0')
      expect(columns).not.toContain('consolidated')
      expect(
        runtime.queryOne<{ count: number }>(
          "select count(*) as count from sqlite_master where type = 'index' and name = 'idx_memory_partition_hash'",
        )?.count,
      ).toBe(0)
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
