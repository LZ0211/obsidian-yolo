import { createWebMcpManager } from './createWebMcpManager'

describe('createWebMcpManager', () => {
  const settings = {
    jsSandbox: {
      allowFetch: true,
      fetchMaxResponseKb: 512,
    },
  }

  function createManager(
    api: { postJson: jest.Mock } = { postJson: jest.fn() },
    getSettings: () => unknown = () => settings,
  ) {
    return createWebMcpManager({
      api: api as never,
      getSettings: getSettings as never,
    })
  }

  it('delegates listAvailableTools to the server instead of synthesizing an empty list', async () => {
    const api = {
      postJson: jest.fn().mockResolvedValue([{ name: 'tool-a' }]),
    }
    const manager = createManager(api)

    await expect(
      manager.listAvailableTools({
        includeBuiltinTools: true,
        chatModelModalities: ['text'],
      } as never),
    ).resolves.toEqual([{ name: 'tool-a' }])

    expect(api.postJson).toHaveBeenCalledWith('/api/mcp/list-tools', {
      includeBuiltinTools: true,
      chatModelModalities: ['text'],
    })
  })

  it('delegates abortToolCall to the server and returns the backend result', async () => {
    const api = {
      postJson: jest.fn().mockResolvedValue({ aborted: true }),
    }
    const manager = createManager(api)

    await expect(
      manager.abortToolCall('tool-call-1', 'conversation-1'),
    ).resolves.toBe(true)

    expect(api.postJson).toHaveBeenCalledWith('/api/mcp/abort-tool-call', {
      id: 'tool-call-1',
      conversationId: 'conversation-1',
    })
  })

  it('returns an empty server snapshot instead of throwing', () => {
    const manager = createManager()

    // The web runtime has no server-state concept; consumers must see an
    // empty list, never an exception (matches McpManager.getServers shape).
    expect(manager.getServers()).toEqual([])
  })

  it('provides a stable server-change subscription for selector consumers', () => {
    const manager = createManager()
    const unsubscribe = manager.subscribeServersChange(() => {})

    expect(unsubscribe).toEqual(expect.any(Function))
    expect(() => unsubscribe()).not.toThrow()
  })

  it('returns the current settings snapshot', () => {
    const manager = createManager()

    expect(manager.getSettingsSnapshot()).toBe(settings)
  })

  it('derives getJsSandboxSettings from real settings', () => {
    const manager = createManager()

    expect(manager.getJsSandboxSettings()).toEqual({
      allowFetch: true,
      fetchMaxResponseKb: 512,
    })
  })

  it('normalizes allowExternalScripts to implicitly enable fetch, matching the desktop source of truth', () => {
    const manager = createManager(undefined, () => ({
      jsSandbox: { allowExternalScripts: true },
    }))

    expect(manager.getJsSandboxSettings()).toEqual({
      allowExternalScripts: true,
      allowFetch: true,
    })
  })

  it('keeps the capability off when settings carry no sandbox config', () => {
    const manager = createManager(undefined, () => ({}))

    expect(manager.getJsSandboxSettings()).toEqual({})
  })
})
