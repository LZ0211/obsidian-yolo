import { McpServerState, McpServerStatus } from '../../../types/mcp.types'

import { computeMcpStatusCounts } from './mcpStatusCounts'

const baseConfig = { enabled: true, parameters: { transport: 'stdio', command: 'noop' }, toolOptions: {} }

const state = (
  status: McpServerStatus,
  name: string,
): McpServerState =>
  ({
    name,
    config: baseConfig,
    status,
    ...(status === McpServerStatus.Connected
      ? { client: {} as never, tools: [] }
      : status === McpServerStatus.Error
        ? { error: new Error('boom') }
        : {}),
  }) as McpServerState

describe('computeMcpStatusCounts', () => {
  it('counts only runtime-connected servers in the connected count and label', () => {
    const counts = computeMcpStatusCounts({
      servers: [
        state(McpServerStatus.Connected, 'a'),
        state(McpServerStatus.Connected, 'b'),
        state(McpServerStatus.Error, 'c'),
        state(McpServerStatus.Disconnected, 'd'),
        state(McpServerStatus.Connecting, 'e'),
      ],
      loading: false,
      enabledConfiguredCount: 5,
    })

    expect(counts.connected).toBe(2)
    expect(counts.error).toBe(1)
    expect(counts.loading).toBe(1)
    // The label says "connected" — Error/Disconnected/Connecting entries
    // must not inflate it.
    expect(counts.labelCount).toBe(2)
  })

  it('excludes Error servers from the connected count even when many are configured', () => {
    const counts = computeMcpStatusCounts({
      servers: [
        state(McpServerStatus.Error, 'bad-1'),
        state(McpServerStatus.Error, 'bad-2'),
      ],
      loading: false,
      enabledConfiguredCount: 3,
    })

    expect(counts.connected).toBe(0)
    expect(counts.labelCount).toBe(0)
    expect(counts.error).toBe(2)
  })

  it('falls back to the enabled-configured count while the manager is initializing', () => {
    const counts = computeMcpStatusCounts({
      servers: [],
      loading: true,
      enabledConfiguredCount: 4,
    })

    // No runtime states exist yet; 0 would lie about the connection status.
    expect(counts.connected).toBe(0)
    expect(counts.loading).toBe(4)
    expect(counts.labelCount).toBe(4)
  })

  it('keeps Connecting servers out of the connected count once live', () => {
    const counts = computeMcpStatusCounts({
      servers: [state(McpServerStatus.Connecting, 'a')],
      loading: false,
      enabledConfiguredCount: 3,
    })

    expect(counts.connected).toBe(0)
    expect(counts.loading).toBe(1)
    expect(counts.labelCount).toBe(0)
  })
})
