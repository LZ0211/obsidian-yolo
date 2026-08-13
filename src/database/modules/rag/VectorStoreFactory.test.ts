import { Platform } from 'obsidian'

import { ShardedVectorStore } from '../vector/backend/sharded/ShardedVectorStore'
import { createVectorStore } from './VectorStoreFactory'
import { SqliteVectorStore } from './SqliteVectorStore'

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

  it('returns the sharded backend on mobile', () => {
    Platform.isDesktop = false

    const store = createVectorStore(makeOptions())

    expect(store).toBeInstanceOf(ShardedVectorStore)
  })

  it('keeps the sqlite backend on desktop', () => {
    Platform.isDesktop = true

    const store = createVectorStore(makeOptions())

    expect(store).toBeInstanceOf(SqliteVectorStore)
  })
})
