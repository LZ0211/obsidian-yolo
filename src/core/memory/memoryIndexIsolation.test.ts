jest.mock('obsidian')

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemAdapter } from 'obsidian'

import { buildMemoryPartition, openMemoryIndexStore } from './memoryIndex'
import type { MemorySourceEntry } from './memoryTypes'

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }

  override getBasePath(): string {
    return this.basePath
  }
}

const makeEntry = (
  localId: string,
  keywords: string[],
  partition: MemorySourceEntry['partition'],
  content?: string,
): MemorySourceEntry => ({
  localId,
  content: content ?? `${localId} alpha`,
  keywords,
  category: 'preferences',
  partition,
  sourcePath: `${partition.partitionKey}.md`,
  entryFingerprint: `${localId}-v1`,
})

describe('memory index multi-tenant isolation', () => {
  it('keeps assistant partitions isolated from each other and from global', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-isolation-'))
    const global = buildMemoryPartition({ scope: 'global' })
    const assistantA = buildMemoryPartition({
      scope: 'assistant',
      assistantId: 'assistant-a',
    })
    const assistantB = buildMemoryPartition({
      scope: 'assistant',
      assistantId: 'assistant-b',
    })

    const entriesA = [
      makeEntry('A_Dark', ['dark', 'theme'], assistantA, '用户偏好深色模式'),
    ]
    const entriesB = [makeEntry('B_Tea', ['tea'], assistantB, '用户喜欢普洱茶')]

    const snapshots = new Map([
      [
        assistantA.partitionKey,
        {
          partition: assistantA,
          sourcePath: 'a.md',
          sourceFileFingerprint: 'a-v1',
          parserVersion: 'p',
          entries: entriesA,
          valid: true,
        },
      ],
      [
        assistantB.partitionKey,
        {
          partition: assistantB,
          sourcePath: 'b.md',
          sourceFileFingerprint: 'b-v1',
          parserVersion: 'p',
          entries: entriesB,
          valid: true,
        },
      ],
    ])

    const store = await openMemoryIndexStore({
      app: {
        vault: { adapter: new TestFileSystemAdapter(root) },
      } as never,
      getSettings: () => ({
        yolo: { baseDir: 'YOLO' },
        assistants: [
          { id: 'assistant-a', name: 'A' },
          { id: 'assistant-b', name: 'B' },
        ],
      }),
      getSourceSnapshot: async (sourcePartition) =>
        snapshots.get(sourcePartition.partitionKey)!,
      clock: () => 100,
    })

    try {
      await store.reconcilePartition({
        partition: assistantA,
        sourcePath: 'a.md',
        sourceFileFingerprint: 'a-v1',
        parserVersion: 'p',
        entries: entriesA,
      })
      await store.reconcilePartition({
        partition: assistantB,
        sourcePath: 'b.md',
        sourceFileFingerprint: 'b-v1',
        parserVersion: 'p',
        entries: entriesB,
      })

      // assistant-a sees only its own entry.
      const resultsA = await store.query({
        partition: assistantA,
        sourceFileFingerprint: 'a-v1',
        target: {
          query: 'dark',
          keywords: ['dark'],
          entities: [],
          categories: ['preferences'],
          scopes: ['assistant'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        },
        maxEntries: 8,
        maxChars: 3000,
      })
      const idsA = resultsA.map(({ id }) => id)
      expect(idsA).toContain('A_Dark')
      expect(idsA).not.toContain('B_Tea')

      // assistant-b sees only its own entry.
      const resultsB = await store.query({
        partition: assistantB,
        sourceFileFingerprint: 'b-v1',
        target: {
          query: 'tea',
          keywords: ['tea'],
          entities: [],
          categories: ['preferences'],
          scopes: ['assistant'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        },
        maxEntries: 8,
        maxChars: 3000,
      })
      const idsB = resultsB.map(({ id }) => id)
      expect(idsB).toContain('B_Tea')
      expect(idsB).not.toContain('A_Dark')

      // Even a keyword that matches the other partition returns nothing from
      // assistant-a's partition.
      const leakCheck = await store.query({
        partition: assistantA,
        sourceFileFingerprint: 'a-v1',
        target: {
          query: 'tea',
          keywords: ['tea'],
          entities: [],
          categories: ['preferences'],
          scopes: ['assistant'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        },
        maxEntries: 8,
        maxChars: 3000,
      })
      expect(leakCheck.map(({ id }) => id)).not.toContain('B_Tea')
    } finally {
      if ('close' in store && typeof store.close === 'function') {
        await store.close()
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
    }
  })

  it('skips reconcile for a partition whose source fingerprint is unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-probe-'))
    const global = buildMemoryPartition({ scope: 'global' })
    const entry = makeEntry('P_Theme', ['theme'], global, '深色模式')
    const snapshot = {
      partition: global,
      sourcePath: 'global.md',
      sourceFileFingerprint: 'g-v1',
      parserVersion: 'p',
      entries: [entry],
      valid: true,
    }
    const getSourceSnapshot = jest.fn(async () => snapshot)
    const store = await openMemoryIndexStore({
      app: {
        vault: { adapter: new TestFileSystemAdapter(root) },
      } as never,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot,
      getSourceFingerprint: jest.fn(async () => ({
        fingerprint: 'g-v1',
        parserVersion: 'p',
      })),
      clock: () => 100,
    })

    try {
      const input = {
        partition: global,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'g-v1',
        parserVersion: 'p',
        entries: [entry],
      }
      await store.reconcilePartition(input)
      expect(getSourceSnapshot).toHaveBeenCalledTimes(1)

      // Same source content + parser version → the probe skips the read,
      // the parse, and every write; rows stay untouched.
      await store.reconcilePartition(input)
      expect(getSourceSnapshot).toHaveBeenCalledTimes(1)

      const results = await store.query({
        partition: global,
        sourceFileFingerprint: 'g-v1',
        target: {
          query: 'theme',
          keywords: ['theme'],
          entities: [],
          categories: ['preferences'],
          scopes: ['global'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        },
        maxEntries: 8,
        maxChars: 3000,
      })
      expect(results.map(({ id }) => id)).toEqual(['P_Theme'])
      expect(results[0]?.content).toBe('深色模式')
    } finally {
      if ('close' in store && typeof store.close === 'function') {
        await store.close()
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
    }
  })

  it('reconciles when the source fingerprint changed even if rows exist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-probe-'))
    const global = buildMemoryPartition({ scope: 'global' })
    const oldEntry = makeEntry('P_Theme', ['theme'], global, '旧内容')
    const newEntry = makeEntry('P_Theme', ['theme'], global, '新内容')
    let currentEntry = oldEntry
    const getSourceSnapshot = jest.fn(async () => ({
      partition: global,
      sourcePath: 'global.md',
      sourceFileFingerprint: 'g-v1',
      parserVersion: 'p',
      entries: [currentEntry],
      valid: true,
    }))
    const store = await openMemoryIndexStore({
      app: {
        vault: { adapter: new TestFileSystemAdapter(root) },
      } as never,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot,
      getSourceFingerprint: jest.fn(async () => ({
        fingerprint: currentEntry === oldEntry ? 'g-v1' : 'g-v2',
        parserVersion: 'p',
      })),
      clock: () => 100,
    })

    try {
      const input = {
        partition: global,
        sourcePath: 'global.md',
        sourceFileFingerprint: 'g-v1',
        parserVersion: 'p',
        entries: [currentEntry],
      }
      await store.reconcilePartition(input)
      expect(getSourceSnapshot).toHaveBeenCalledTimes(1)

      // Probe now differs from the stored state → full reconcile picks up
      // the new content.
      currentEntry = newEntry
      await store.reconcilePartition(input)
      expect(getSourceSnapshot).toHaveBeenCalledTimes(2)

      const results = await store.query({
        partition: global,
        sourceFileFingerprint: 'g-v1',
        target: {
          query: 'theme',
          keywords: ['theme'],
          entities: [],
          categories: ['preferences'],
          scopes: ['global'],
          sector: null,
          confidence: 1,
          isReferential: false,
          source: 'lexical',
        },
        maxEntries: 8,
        maxChars: 3000,
      })
      expect(results[0]?.content).toBe('新内容')
    } finally {
      if ('close' in store && typeof store.close === 'function') {
        await store.close()
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
    }
  })
})
