/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块（临时 sqlite 文件/目录） */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemAdapter, Platform } from 'obsidian'

import { DatabaseManager } from './DatabaseManager'
import { ShardedVectorStore } from './modules/vector/backend/sharded/ShardedVectorStore'

class TempFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }
  override getBasePath(): string {
    return this.basePath
  }
}

function createTempApp() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-manager-test-'))
  const app = {
    vault: {
      adapter: new TempFileSystemAdapter(rootDir),
    },
  }
  return { rootDir, app }
}

describe('DatabaseManager SQLite lifecycle', () => {
  it('opens vector and trace stores, saves, and quiesces on cleanup', async () => {
    const { rootDir, app } = createTempApp()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      'plugin/dir',
    )

    expect(manager.getVectorStore()).not.toBeNull()
    expect(manager.getRetrievalTraceStore()).not.toBeNull()
    expect(manager.getVectorManager()).toBeDefined()

    await manager.save()
    await manager.quiesceAndCleanup()

    expect(manager.getVectorStore()).toBeNull()
    expect(manager.getRetrievalTraceStore()).toBeNull()

    await manager.cleanup()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('stays inert when the vault has no filesystem adapter', async () => {
    const app = { vault: { adapter: {} } }
    const manager = await DatabaseManager.create(app as never, null)

    expect(manager.getVectorStore()).toBeNull()
    expect(manager.getRetrievalTraceStore()).toBeNull()
    await manager.cleanup()
  })

  it('mobile: vault-relative base dir for the sharded backend, no desktop trace store', async () => {
    Platform.isDesktop = false
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
        },
      },
    }
    try {
      const manager = await DatabaseManager.create(
        app as never,
        { yolo: { baseDir: 'YOLO' } },
        'plugin/dir',
      )

      // node:sqlite RetrievalTraceStore must not be constructed on mobile.
      expect(manager.getRetrievalTraceStore()).toBeNull()

      const store = manager.getVectorStore()
      expect(store).toBeInstanceOf(ShardedVectorStore)
      // The sharded backend receives a vault-relative base dir: its layout is
      // `YOLO/rag-index/v1/...` inside the vault (sql.js opens shard files
      // through vault-relative paths, memoryIndex.ts pattern).
      const status = await store!.getStatus()
      expect(status.storagePath).toBe('YOLO/rag-index/v1')
      expect(status.rebuildRequired).toBe(true)

      await manager.cleanup()
    } finally {
      Platform.isDesktop = true
    }
  })
})
