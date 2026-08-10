import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemAdapter } from 'obsidian'

import { DatabaseManager } from './DatabaseManager'

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
})
