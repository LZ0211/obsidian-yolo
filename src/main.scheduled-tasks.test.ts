/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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

jest.mock('obsidian', () => {
  class ObsidianBase {}
  const Platform = { isDesktop: true, isMobile: false }
  return new Proxy(
    {
      Platform,
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
jest.mock('./core/cli-runtime/coordinator', () => ({
  createDesktopCliRuntimeCoordinator: jest.fn(),
}))
import { FileSystemAdapter, Platform } from 'obsidian'

import type { ScheduledTasksService } from './core/scheduled-tasks-service'
import YoloPlugin from './main'

type TestPlugin = {
  app: { vault: { adapter: { getBasePath(): string } } }
  settings: {
    yolo: { baseDir: string }
    scheduledTasks: {
      enabled: boolean
      enableScriptExecution: boolean
      allowedScriptDirectories: string[]
    }
    webRuntime: { maxConcurrentAgentRuns: number }
  }
  isUnloaded: boolean
  getScheduledTasksService(): ScheduledTasksService | null
  reconcileScheduledTasks(): void
}

const createPlugin = (scheduledTasksEnabled: boolean): TestPlugin => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-st-vault-'))
  const adapter = Object.create(FileSystemAdapter.prototype) as {
    getBasePath(): string
  }
  adapter.getBasePath = () => vaultRoot
  const plugin = Object.create(YoloPlugin.prototype) as unknown as TestPlugin
  Object.assign(plugin, {
    app: { vault: { adapter } },
    settings: {
      yolo: { baseDir: '' },
      scheduledTasks: {
        enabled: scheduledTasksEnabled,
        enableScriptExecution: false,
        allowedScriptDirectories: [],
      },
      webRuntime: { maxConcurrentAgentRuns: 12 },
    },
    isUnloaded: false,
    // Object.create(YoloPlugin.prototype) 跳过构造函数 → 类字段不会被初始化，
    // 手动补上与构造函数等价的初始值（否则字段为 undefined 而非 null）。
    scheduledTasksService: null,
    scheduledTasksStore: null,
    scheduledTasksReconcileInFlight: null,
  })
  return plugin
}

const vaultRootOf = (plugin: TestPlugin): string =>
  plugin.app.vault.adapter.getBasePath()

const closeServiceStore = (service: ScheduledTasksService | null): void => {
  ;(service as unknown as { store: { close(): void } } | null)?.store.close()
}

const removeVaultRoot = (vaultRoot: string): void => {
  try {
    fs.rmSync(vaultRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    })
  } catch {
    // Best-effort: see scheduler.test.ts for why this is swallowed on Windows.
  }
}

/** The scheduler poll loop runs iff the service was initialized (started). */
const isSchedulerStopped = (service: ScheduledTasksService): boolean =>
  (
    service as unknown as {
      scheduler: { stopped: boolean }
    }
  ).scheduler.stopped

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('YoloPlugin scheduled tasks wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Platform.isDesktop = true
    Platform.isMobile = false
  })

  it('builds the service while disabled but does not start the scheduler', async () => {
    const plugin = createPlugin(false)
    try {
      plugin.reconcileScheduledTasks()
      await waitFor(() => plugin.getScheduledTasksService() != null)

      const service = plugin.getScheduledTasksService()
      expect(service).not.toBeNull()
      // disabled: 数据访问可用（UI 可管理任务），调度循环不启动
      expect(isSchedulerStopped(service!)).toBe(true)
      closeServiceStore(service)
    } finally {
      removeVaultRoot(vaultRootOf(plugin))
    }
  })

  it('enabled toggle starts/stops the scheduler on the same service instance', async () => {
    const plugin = createPlugin(false)
    try {
      plugin.reconcileScheduledTasks()
      await waitFor(() => plugin.getScheduledTasksService() != null)
      const service = plugin.getScheduledTasksService()
      expect(isSchedulerStopped(service!)).toBe(true)

      // enabled 翻转 → 启动调度循环（复用同一实例，不重建 store）
      plugin.settings.scheduledTasks.enabled = true
      plugin.reconcileScheduledTasks()
      await waitFor(() => !isSchedulerStopped(service!))
      expect(plugin.getScheduledTasksService()).toBe(service)

      // 再翻转 → 停止调度循环，实例仍保留（disabled 下 UI 可继续管理任务）
      plugin.settings.scheduledTasks.enabled = false
      plugin.reconcileScheduledTasks()
      await waitFor(() => isSchedulerStopped(service!))
      expect(plugin.getScheduledTasksService()).toBe(service)

      closeServiceStore(service)
    } finally {
      removeVaultRoot(vaultRootOf(plugin))
    }
  })

  it('does not build the service on mobile (desktop gate)', async () => {
    Platform.isDesktop = false
    Platform.isMobile = true
    const plugin = createPlugin(true)
    try {
      plugin.reconcileScheduledTasks()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(plugin.getScheduledTasksService()).toBeNull()
    } finally {
      removeVaultRoot(vaultRootOf(plugin))
    }
  })
})
