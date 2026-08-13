jest.mock('obsidian')

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemAdapter } from 'obsidian'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'

import { buildMemoryPartition, openMemoryIndexStore } from './memoryIndex'
import type { MemoryRecallTarget } from './memoryRecallTarget'
import type { MemorySourceEntry } from './memoryTypes'

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }

  override getBasePath(): string {
    return this.basePath
  }
}

const target: MemoryRecallTarget = {
  query: 'alpha',
  keywords: ['alpha'],
  entities: [],
  categories: ['profile', 'preferences', 'other'],
  scopes: ['global'],
  sector: null,
  confidence: 1,
  isReferential: false,
  source: 'lexical',
}

describe('sqlite memory graph integration', () => {
  it('builds partitioned double edges and expands one hop through preferences', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-graph-store-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const assistant = buildMemoryPartition({
      scope: 'assistant',
      assistantId: 'assistant-1',
    })
    const entry = (
      localId: string,
      keywords: string[],
      category: MemorySourceEntry['category'] = 'other',
      sourcePartition = partition,
    ): MemorySourceEntry => ({
      localId,
      content: `${localId} alpha`,
      keywords,
      category,
      partition: sourcePartition,
      sourcePath: `${sourcePartition.partitionKey}.md`,
      entryFingerprint: `${localId}-v1`,
    })
    const entries = [
      entry('A', ['a', 'b', 'c']),
      entry('B', ['a', 'b', 'c', 'd'], 'preferences'),
      entry('C', ['b', 'c', 'd']),
    ]
    const assistantEntries = [
      entry('A', ['a', 'b', 'c'], 'other', assistant),
      entry('B', ['a', 'b', 'c', 'd'], 'other', assistant),
    ]
    const app = {
      vault: { adapter: new TestFileSystemAdapter(root) },
    } as never
    const snapshots = new Map([
      [
        partition.partitionKey,
        {
          partition,
          sourcePath: 'global.md',
          sourceFileFingerprint: 'global-v1',
          parserVersion: 'p',
          entries,
          valid: true,
        },
      ],
      [
        assistant.partitionKey,
        {
          partition: assistant,
          sourcePath: 'assistant.md',
          sourceFileFingerprint: 'assistant-v1',
          parserVersion: 'p',
          entries: assistantEntries,
          valid: true,
        },
      ],
    ])
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({
        yolo: { baseDir: 'YOLO' },
        assistants: [{ id: 'assistant-1', name: 'Assistant' }],
      }),
      getSourceSnapshot: async (sourcePartition) =>
        snapshots.get(sourcePartition.partitionKey)!,
      clock: () => 100,
    })
    try {
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'global-v1',
        parserVersion: 'p',
        entries,
      })
      await store.reconcilePartition({
        partition: assistant,
        sourcePath: 'assistant.md',
        sourceFileFingerprint: 'assistant-v1',
        parserVersion: 'p',
        entries: assistantEntries,
      })
      await store.rebuildEdges({
        partition,
        localIds: entries.map(({ localId }) => localId),
      })
      await store.rebuildEdges({
        partition: assistant,
        localIds: assistantEntries.map(({ localId }) => localId),
      })

      const runtime = openSqliteRuntime({
        dbPath: path.join(root, 'YOLO', 'memory', 'index.sqlite'),
      })
      try {
        const globalEdges = runtime.query<{
          src_local_id: string
          dst_local_id: string
        }>(
          'select src_local_id, dst_local_id from memory_edges where partition_key = ? order by src_local_id, dst_local_id',
          [partition.partitionKey],
        )
        expect(globalEdges).toEqual([
          { src_local_id: 'A', dst_local_id: 'B' },
          { src_local_id: 'B', dst_local_id: 'A' },
          { src_local_id: 'B', dst_local_id: 'C' },
          { src_local_id: 'C', dst_local_id: 'B' },
        ])
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_edges where src_local_id = dst_local_id',
          )?.count,
        ).toBe(0)
      } finally {
        runtime.close()
      }

      const direct = await store.query({
        partition,
        sourceFileFingerprint: 'global-v1',
        target: { ...target, categories: ['other'] },
        maxEntries: 8,
        maxChars: 3000,
      })
      const seed = direct.find(({ id }) => id === 'A')
      expect(seed).toBeDefined()
      const expanded = await store.expandViaEdges({
        partition,
        seeds: [seed!],
        target,
        maxEntries: 8,
      })
      expect(expanded.map(({ id }) => id)).toEqual(['A', 'B'])
      expect(expanded.map(({ id }) => id)).not.toContain('C')
    } finally {
      if ('close' in store && typeof store.close === 'function') {
        await store.close()
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('caps additions at five and cleans edited and deleted edge endpoints', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-graph-cleanup-'))
    const partition = buildMemoryPartition({ scope: 'global' })
    const makeEntry = (
      localId: string,
      keywords: string[],
      fingerprint = `${localId}-v1`,
    ): MemorySourceEntry => ({
      localId,
      content: `${localId} alpha`,
      keywords,
      category: 'other',
      partition,
      sourcePath: 'global.md',
      entryFingerprint: fingerprint,
    })
    let entries = [
      makeEntry('source', ['shared', 'alpha']),
      ...Array.from({ length: 8 }, (_, index) =>
        makeEntry(`target-${index}`, ['shared', 'alpha']),
      ),
    ]
    const app = {
      vault: { adapter: new TestFileSystemAdapter(root) },
    } as never
    let sourceFileFingerprint = 'file-v1'
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => ({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint,
        parserVersion: 'p',
        entries,
        valid: true,
      }),
      clock: () => 200,
    })
    const reconcile = async (fingerprint: string): Promise<void> => {
      sourceFileFingerprint = fingerprint
      await store.reconcilePartition({
        partition,
        sourcePath: 'global.md',
        sourceFileFingerprint: fingerprint,
        parserVersion: 'p',
        entries,
      })
      await store.rebuildEdges({
        partition,
        localIds: entries.map(({ localId }) => localId),
      })
    }
    try {
      await reconcile('file-v1')
      const direct = await store.query({
        partition,
        sourceFileFingerprint: 'file-v1',
        target,
        maxEntries: 8,
        maxChars: 3000,
      })
      const seed = direct.find(({ id }) => id === 'source')
      const expanded = await store.expandViaEdges({
        partition,
        seeds: [seed!],
        target,
        maxEntries: 99,
      })
      expect(expanded).toHaveLength(6)
      expect(new Set(expanded.map(({ memoryKey }) => memoryKey)).size).toBe(6)

      entries = entries.map((entry) =>
        entry.localId === 'source'
          ? makeEntry('source', ['unrelated'], 'source-v2')
          : entry,
      )
      await reconcile('file-v2')
      const runtime = openSqliteRuntime({
        dbPath: path.join(root, 'YOLO', 'memory', 'index.sqlite'),
      })
      try {
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_edges where src_local_id = ? or dst_local_id = ?',
            ['source', 'source'],
          )?.count,
        ).toBe(0)
      } finally {
        runtime.close()
      }

      entries = entries.filter(({ localId }) => localId !== 'source')
      await reconcile('file-v3')
      const cleanupRuntime = openSqliteRuntime({
        dbPath: path.join(root, 'YOLO', 'memory', 'index.sqlite'),
      })
      try {
        expect(
          cleanupRuntime.queryOne<{ count: number }>(
            `select count(*) as count from memory_edges e
             where not exists (
               select 1 from memory_index i
               where i.partition_key = e.partition_key and i.local_id = e.src_local_id
             ) or not exists (
               select 1 from memory_index i
               where i.partition_key = e.partition_key and i.local_id = e.dst_local_id
             )`,
          )?.count,
        ).toBe(0)
      } finally {
        cleanupRuntime.close()
      }
    } finally {
      if ('close' in store && typeof store.close === 'function') {
        await store.close()
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
