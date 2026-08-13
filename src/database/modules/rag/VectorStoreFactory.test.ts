/* eslint-disable import/no-nodejs-modules -- 测试在 Node 环境运行，读取工厂源码做静态导入图断言 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { Platform } from 'obsidian'

import { ShardedVectorStore } from '../vector/backend/sharded/ShardedVectorStore'

import { SqliteVectorStore } from './SqliteVectorStore'
import { createVectorStore } from './VectorStoreFactory'

const BASE_DIR = '/vault/.yolo'

// The factory only stores `app` (mobile) or ignores it (desktop); the
// constructors do no IO, so a minimal vault-shaped fake suffices.
const app = {
  vault: { adapter: {} },
}

const makeOptions = () => ({
  baseDir: BASE_DIR,
  pluginDir: 'plugin/dir',
  settings: {},
  app: app as never,
})

describe('createVectorStore platform dispatch', () => {
  afterEach(() => {
    Platform.isDesktop = true
  })

  it('returns the sharded backend on mobile', async () => {
    Platform.isDesktop = false

    const store = await createVectorStore(makeOptions())

    expect(store).toBeInstanceOf(ShardedVectorStore)
  })

  it('keeps the sqlite backend on desktop', async () => {
    Platform.isDesktop = true

    const store = await createVectorStore(makeOptions())

    expect(store).toBeInstanceOf(SqliteVectorStore)
  })

  it('never evaluates the desktop store module on the mobile branch', async () => {
    jest.resetModules()
    // If the mobile branch ever required SqliteVectorStore, its top-level
    // node:crypto/fs/path imports would throw — exactly what breaks the
    // mobile bundle. The factory must not touch the module at all.
    jest.doMock('./SqliteVectorStore', () => {
      throw new Error(
        'SqliteVectorStore must not be required on the mobile branch',
      )
    })
    try {
      const { createVectorStore: createMobileStore } = await import(
        './VectorStoreFactory'
      )
      // resetModules re-evaluated every module, so use the fresh class
      // identities for both the platform flag and the instanceof check.
      const { Platform: freshPlatform } = await import('obsidian')
      freshPlatform.isDesktop = false
      const { ShardedVectorStore: FreshShardedVectorStore } = await import(
        '../vector/backend/sharded/ShardedVectorStore'
      )
      const store = await createMobileStore(makeOptions())
      expect(store).toBeInstanceOf(FreshShardedVectorStore)
    } finally {
      jest.dontMock('./SqliteVectorStore')
    }
  })

  it('keeps the desktop store out of the factory static import graph', () => {
    const source = readFileSync(
      path.join(__dirname, 'VectorStoreFactory.ts'),
      'utf8',
    )

    // A value import would pull SqliteVectorStore's node:* imports into the
    // mobile bundle; only the type-only dependency may remain.
    expect(source).not.toMatch(/import \{[^}]*\} from '\.\/SqliteVectorStore'/)
    expect(source).toMatch(
      /import type \{[^}]*SqliteVectorStore[^}]*\} from '\.\/SqliteVectorStore'/,
    )
    expect(source).not.toMatch(/from 'node:/)
  })
})
