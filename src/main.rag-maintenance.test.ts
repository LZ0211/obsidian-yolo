jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react')
  return { __esModule: true, ...actual, default: actual }
})
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: () => null,
  defaultUrlTransform: (url: string) => url,
}))
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('remark-math', () => ({ __esModule: true, default: jest.fn() }))

// Mutable holder so tests can flip the platform for the mobile gate checks.
const mockPlatform = { isDesktop: true, isMobile: false }
jest.mock('obsidian', () => {
  class ObsidianBase {}
  return new Proxy(
    {
      Platform: mockPlatform,
      Plugin: ObsidianBase,
      normalizePath: (path: string) => path,
      getLanguage: () => 'en',
    },
    {
      get(target, property: string) {
        if (property in target) {
          return target[property as keyof typeof target]
        }
        return ObsidianBase
      },
    },
  )
})

jest.mock('./ChatView', () => ({ ChatView: jest.fn() }))
jest.mock('./constants/bakedVersion', () => ({ BAKED_PLUGIN_VERSION: 'test' }))
jest.mock(
  './core/runtime-components',
  () =>
    new Proxy(
      { BAKED_RUNTIME_COMPONENT_REGISTRY: {} },
      {
        get: (target, property: string) =>
          (target as Record<string, unknown>)[property] ?? jest.fn(),
      },
    ),
)

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import YoloPlugin from './main'
import { MAINTENANCE_JOB_KIND } from './core/maintenance/types'

type TestPlugin = {
  databaseMaintenanceControllers: Map<
    string,
    ReturnType<YoloPlugin['getDatabaseMaintenanceController']>
  >
  getDatabaseMaintenanceController: YoloPlugin['getDatabaseMaintenanceController']
  runRagIndex: jest.Mock
  getRagIndexService: jest.Mock
  getVectorBackendStatus: jest.Mock
}

const createPlugin = (): TestPlugin => {
  const plugin = Object.create(
    YoloPlugin.prototype,
  ) as unknown as TestPlugin
  Object.assign(plugin, {
    app: { vault: { adapter: {} } },
    settings: { yolo: { baseDir: 'first' }, ragOptions: { enabled: true } },
    isUnloaded: false,
    databaseMaintenanceControllers: new Map(),
    runRagIndex: jest.fn(async () => ({
      permanentFailedPaths: [],
      chunkifyFailedPaths: [],
    })),
    getRagIndexService: jest.fn(() => ({ cancelActiveRun: jest.fn() })),
  })
  return plugin
}

describe('YoloPlugin RAG maintenance runJob', () => {
  it('dispatches index jobs to RagIndexService with live progress mapping', async () => {
    const plugin = createPlugin()
    const controller = plugin.getDatabaseMaintenanceController('rag')

    const result = await controller.startJob({
      kind: MAINTENANCE_JOB_KIND.UPDATE_CHANGED_SOURCES,
      operationKey: 'rag:sync',
      scope: { kind: 'all' },
    })

    expect(result.status).toBe('completed')
    expect(plugin.runRagIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'none',
      }),
    )
  })

  it('maps FULL_REBUILD to rebuild mode and forwards file progress', async () => {
    const plugin = createPlugin()
    const controller = plugin.getDatabaseMaintenanceController('rag')

    const result = await controller.startJob({
      kind: MAINTENANCE_JOB_KIND.FULL_REBUILD,
      operationKey: 'rag:rebuild',
      scope: { kind: 'all' },
    })

    expect(result.status).toBe('completed')
    expect(plugin.runRagIndex).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'rebuild' }),
    )
    const onProgress = plugin.runRagIndex.mock.calls[0][0]
      .onProgress as (progress: {
      completedFiles: number
      totalFiles: number
      currentFile?: string
    }) => void
    onProgress({
      completedFiles: 3,
      totalFiles: 10,
      currentFile: 'a.md',
    })
  })

  it('cancels the active index run when the maintenance job is aborted', async () => {
    const plugin = createPlugin()
    let finishRun!: () => void
    const runPending = new Promise<void>((resolve) => {
      finishRun = resolve
    })
    plugin.runRagIndex.mockImplementation(
      () => runPending.then(() => ({ permanentFailedPaths: [], chunkifyFailedPaths: [] })),
    )
    const cancelActiveRun = jest.fn()
    plugin.getRagIndexService.mockReturnValue({ cancelActiveRun })
    const controller = plugin.getDatabaseMaintenanceController('rag')

    const job = controller.startJob({
      kind: MAINTENANCE_JOB_KIND.UPDATE_CHANGED_SOURCES,
      operationKey: 'rag:cancel',
      scope: { kind: 'all' },
    })
    const cancelPromise = controller.cancelActiveJob()
    expect(cancelActiveRun).toHaveBeenCalledTimes(1)

    finishRun()
    await expect(cancelPromise).resolves.toMatchObject({ status: 'cancelled' })
    await expect(job).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('maintenance open rejects a missing database without creating the file', async () => {
    const plugin = createPlugin()
    const missingDbPath = path.join(
      os.tmpdir(),
      `yolo-rag-maintenance-missing-${Date.now()}`,
      'rag',
      'missing.sqlite',
    )
    plugin.getVectorBackendStatus = jest.fn(async () => ({
      backend: 'sqlite',
      readiness: 'ready',
      rebuildRequired: true,
      storagePath: missingDbPath,
      executionMode: 'plugin-host',
      persistenceMode: 'native-sqlite-file',
      recoveryAction: 'rebuild_index',
    }))
    const controller = plugin.getDatabaseMaintenanceController('rag')

    const result = await controller.loadSummary()

    expect(result.status).toBe('failed')
    // The explorer is read-only: opening it must not create the missing
    // database file (which would also flip rebuildRequired via existsSync).
    expect(fs.existsSync(missingDbPath)).toBe(false)
  })

  it('maintenance open rejects on mobile without touching the filesystem', async () => {
    mockPlatform.isDesktop = false
    try {
      const plugin = createPlugin()
      const missingDbPath = path.join(
        os.tmpdir(),
        `yolo-rag-maintenance-mobile-${Date.now()}`,
        'rag',
        'rag.sqlite',
      )
      plugin.getVectorBackendStatus = jest.fn(async () => ({
        backend: 'sqlite',
        readiness: 'ready',
        rebuildRequired: true,
        storagePath: missingDbPath,
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        recoveryAction: 'rebuild_index',
      }))
      const controller = plugin.getDatabaseMaintenanceController('rag')

      const result = await controller.loadSummary()

      expect(result.status).toBe('failed')
      expect(fs.existsSync(missingDbPath)).toBe(false)
    } finally {
      mockPlatform.isDesktop = true
    }
  })
})

describe('YoloPlugin RAG backend status', () => {
  it('queries the namespace for the configured provider and endpoint', async () => {
    const getStatus = jest.fn(async (_namespace: unknown) => ({
      backend: 'sqlite' as const,
      readiness: 'ready' as const,
      rebuildRequired: false,
    }))
    const getStats = jest.fn(async (_namespace: unknown) => ({ chunkCount: 1 }))
    const plugin = Object.create(YoloPlugin.prototype) as YoloPlugin
    Object.assign(plugin, {
      settings: {
        embeddingModelId: 'embedding-1',
        embeddingModels: [
          {
            id: 'embedding-1',
            model: 'text-embedding-3-small',
            dimension: 1536,
            providerId: 'provider-1',
          },
        ],
        providers: [
          { id: 'provider-1', baseUrl: 'https://embedding.example/v1/' },
        ],
        ragBackendSettings: { rebuildRequired: false },
      },
      getDbManager: jest.fn(async () => ({
        getVectorStore: () => ({ getStatus, getStats }),
      })),
    })

    await plugin.getVectorBackendStatus()

    expect(getStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        providerIdentity: 'provider-1',
        endpointIdentity: 'https://embedding.example/v1/',
      }),
    )
    expect(getStats).toHaveBeenCalledWith(getStatus.mock.calls[0][0])
  })
})
