import { createWebMcpManager } from './createWebMcpManager'

describe('createWebMcpManager', () => {
  it('delegates listAvailableTools to the server instead of synthesizing an empty list', async () => {
    const api = {
      postJson: jest.fn().mockResolvedValue([{ name: 'tool-a' }]),
    }
    const manager = createWebMcpManager({ api } as never)

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
    const manager = createWebMcpManager({ api } as never)

    await expect(manager.abortToolCall('tool-call-1')).resolves.toBe(true)

    expect(api.postJson).toHaveBeenCalledWith('/api/mcp/abort-tool-call', {
      id: 'tool-call-1',
    })
  })

  it('throws explicit errors for MCP admin state that is not available in shared web', () => {
    const manager = createWebMcpManager({ api: { postJson: jest.fn() } } as never)

    expect(() => manager.getServers()).toThrow(
      'MCP server administration is not available in the shared web runtime.',
    )
  })

  it('provides a stable server-change subscription for selector consumers', () => {
    const manager = createWebMcpManager({ api: { postJson: jest.fn() } } as never)
    const unsubscribe = manager.subscribeServersChange(() => {})

    expect(unsubscribe).toEqual(expect.any(Function))
    expect(() => unsubscribe()).not.toThrow()
  })
})
