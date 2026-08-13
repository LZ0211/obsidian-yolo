// Simulates a mobile environment: node:sqlite is unavailable (the dynamic
// import throws) and the vault adapter is not a FileSystemAdapter, so the
// store must fall through to the sqlite-engine runtime component with the
// vault-relative dbPath passed through unchanged.
jest.mock('obsidian')

jest.mock('../../database/sqlite/sqliteNativeRuntime', () => ({
  openSqliteRuntime: jest.fn(() => {
    throw new Error('node:sqlite unavailable (mobile)')
  }),
}))

import {
  setRuntimeComponentAcquirerForTests,
} from '../runtime-components/runtimeComponentAccess'

import { buildMemoryPartition, openMemoryIndexStore } from './memoryIndex'
import type { MemorySourceSnapshot } from './memoryManager'

describe('memory index mobile openRuntime branch', () => {
  afterEach(() => {
    setRuntimeComponentAcquirerForTests(null)
  })

  it('opens the sqlite-engine runtime with the vault-relative path when node:sqlite is unavailable', async () => {
    const opened: Array<{ relativePath: string }> = []
    setRuntimeComponentAcquirerForTests(async (id) => {
      expect(id).toBe('sqlite-engine')
      return {
        api: {
          openSqliteJsRuntime: async (options: {
            relativePath: string
          }): Promise<unknown> => {
            opened.push({ relativePath: options.relativePath })
            return {
              exec: jest.fn(),
              query: jest.fn(() => []),
              queryOne: jest.fn(() => undefined),
              transaction: (fn: () => void) => {
                fn()
              },
              close: jest.fn(),
            }
          },
          dispose: () => undefined,
        },
        release: () => undefined,
      } as never
    })

    const partition = buildMemoryPartition({ scope: 'global' })
    const snapshot: MemorySourceSnapshot = {
      partition,
      sourcePath: 'YOLO/memory/global.md',
      sourceFileFingerprint: 'fp',
      parserVersion: 'p',
      entries: [],
      valid: true,
    }
    // Mobile app: vault adapter without FileSystemAdapter.
    const app = { vault: { adapter: {} } } as never
    const store = await openMemoryIndexStore({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      getSourceSnapshot: async () => snapshot,
    })

    try {
      expect(store.capability).toBe('sqlite')
      expect(opened).toEqual([
        { relativePath: 'YOLO/memory/index.sqlite' },
      ])
    } finally {
      if ('close' in store && typeof store.close === 'function')
        await store.close()
    }
  })
})
