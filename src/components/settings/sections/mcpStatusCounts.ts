import {
  McpServerState,
  McpServerStatus,
} from '../../../types/mcp.types'

export type McpStatusCounts = {
  /** Runtime-connected servers. */
  connected: number
  /** Servers currently attempting to connect; falls back to the enabled-configured count while the manager is still initializing. */
  loading: number
  /** Servers in Error status — shown outside the connected count, with their own badge. */
  error: number
  /**
   * The number the "N MCP servers connected" label renders. Runtime-connected
   * count once the manager is live; the enabled-configured count while the
   * manager is still initializing (no runtime states exist yet, and showing 0
   * would lie about the connection status).
   */
  labelCount: number
}

/**
 * Single source of truth for the Agent section's MCP status headline. The
 * "N MCP servers connected" label must reflect the *runtime* connection
 * state, not the number of configured entries: Error / Disconnected / plain
 * disabled servers are not connected and must not inflate the count.
 */
export function computeMcpStatusCounts({
  servers,
  loading,
  enabledConfiguredCount,
}: {
  servers: McpServerState[]
  loading: boolean
  enabledConfiguredCount: number
}): McpStatusCounts {
  const connected = servers.filter(
    (server) => server.status === McpServerStatus.Connected,
  ).length
  const loadingCount = loading
    ? enabledConfiguredCount
    : servers.filter((server) => server.status === McpServerStatus.Connecting)
        .length
  const error = servers.filter(
    (server) => server.status === McpServerStatus.Error,
  ).length
  return {
    connected,
    loading: loadingCount,
    error,
    labelCount: loading ? enabledConfiguredCount : connected,
  }
}
