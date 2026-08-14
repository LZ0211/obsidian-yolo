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
  const FileSystemAdapter = class {
    getBasePath(): string {
      return '/vault'
    }
  }
  const Platform = { isDesktop: true, isMobile: false }
  return new Proxy(
    {
      Platform,
      FileSystemAdapter,
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

import { FileSystemAdapter } from 'obsidian'

import YoloPlugin from './main'

type TestPlugin = YoloPlugin & {
  settings: YoloPlugin['settings']
  setSettings: jest.Mock
}

const agent = {
  id: 'wa-1',
  name: 'Workspace Agent',
  templateId: 'template-1',
  workspacePolicy: {
    workspaceRoot: '04-专利',
    readAllowlist: [],
    readDenylist: [],
    writeDenylist: [],
  },
  createdAt: 1,
  updatedAt: 1,
}

const createPlugin = (): TestPlugin => {
  const plugin = Object.create(YoloPlugin.prototype) as unknown as TestPlugin
  Object.assign(plugin, {
    app: {
      vault: {
        adapter: new FileSystemAdapter(),
        getName: () => 'Test Vault',
      },
    },
    settings: {
      yolo: { baseDir: '.yolo' },
      workspaceAgents: [agent],
    },
    isUnloaded: false,
  })
  plugin.setSettings = jest.fn(
    async (next: YoloPlugin['settings']) => {
      plugin.settings = next
      return true
    },
  ) as unknown as TestPlugin['setSettings']
  return plugin
}

describe('YoloPlugin share token management', () => {
  it('creates a share token through the plugin method and persists it', async () => {
    const plugin = createPlugin()

    const result = await plugin.createWorkspaceAgentShareToken('wa-1', {
      scopeKind: 'agent',
    })

    expect(result.plaintext).toBeTruthy()
    expect(result.publicTokenId).toBeTruthy()
    expect(plugin.settings.workspaceAgents[0].shareTokens).toHaveLength(1)
    expect(plugin.settings.workspaceAgents[0].shareTokens![0].id).toBe(
      result.publicTokenId,
    )
    expect(plugin.setSettings).toHaveBeenCalled()
  })

  it('updates token metadata through the plugin method', async () => {
    const plugin = createPlugin()
    const created = await plugin.createWorkspaceAgentShareToken('wa-1', {
      scopeKind: 'agent',
    })

    await plugin.updateWorkspaceAgentShareToken('wa-1', created.publicTokenId, {
      label: 'LAN share',
      disabled: true,
    })

    const token = plugin.settings.workspaceAgents[0].shareTokens![0]
    expect(token.label).toBe('LAN share')
    expect(token.disabled).toBe(true)
  })

  it('revokes a share token through the plugin method', async () => {
    const plugin = createPlugin()
    const created = await plugin.createWorkspaceAgentShareToken('wa-1', {
      scopeKind: 'agent',
    })
    const revokeShareToken = jest.fn(
      async (_agentId: string, _tokenId: string) => {
        // Mirror WebAgentLifecycleService.revokeShareToken: mark revoked in
        // persisted settings.
        plugin.settings = {
          ...plugin.settings,
          workspaceAgents: plugin.settings.workspaceAgents.map((a) =>
            a.id === 'wa-1'
              ? {
                  ...a,
                  shareTokens: (a.shareTokens ?? []).map((token) =>
                    token.id === created.publicTokenId
                      ? { ...token, revokedAt: Date.now() }
                      : token,
                  ),
                }
              : a,
          ),
        }
      },
    )
    ;(
      plugin as unknown as {
        webAgentLifecycleService?: { revokeShareToken: unknown }
      }
    ).webAgentLifecycleService = { revokeShareToken }

    await plugin.revokeWorkspaceAgentShareToken('wa-1', created.publicTokenId)

    expect(revokeShareToken).toHaveBeenCalledWith('wa-1', created.publicTokenId)
    expect(
      plugin.settings.workspaceAgents[0].shareTokens![0].revokedAt,
    ).toEqual(expect.any(Number))
  })

  it('computes the workspace root hash through the plugin method', () => {
    const plugin = createPlugin()

    const hash = plugin.getWorkspaceAgentRootHash('wa-1')

    expect(hash).toEqual(expect.any(String))
    expect(hash!.length).toBeGreaterThan(0)
  })
})
