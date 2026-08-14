import type { McpServerState } from '../../../types/mcp.types'

import { deriveMcpSharingCapability } from './mcpSharingCapability'

function serverState(
  name: string,
  overrides: {
    enabled?: boolean
    transport?: 'http' | 'sse' | 'ws' | 'stdio'
  } = {},
): McpServerState {
  return {
    name,
    config: {
      id: name,
      enabled: overrides.enabled ?? true,
      parameters: {
        transport: overrides.transport ?? 'http',
        url: `http://127.0.0.1:1/${name}`,
      },
      toolOptions: {},
    },
    status: 'disconnected',
  } as McpServerState
}

describe('deriveMcpSharingCapability', () => {
  const servers = [
    serverState('http-a', { transport: 'http' }),
    serverState('sse-b', { transport: 'sse' }),
    serverState('ws-c', { transport: 'ws' }),
    serverState('stdio-d', { transport: 'stdio' }),
    serverState('off-e', { enabled: false }),
  ]

  it('declares native supported with the union of shared transports', () => {
    const capability = deriveMcpSharingCapability(servers, 'yolo')
    expect(capability.supported).toBe(true)
    if (capability.supported) {
      expect(capability.info?.transports).toEqual(['http', 'sse', 'ws'])
    }
  })

  it('excludes stdio and disabled servers from transports', () => {
    const capability = deriveMcpSharingCapability(servers, 'yolo')
    if (capability.supported) {
      expect(capability.info?.transports).not.toContain('stdio')
      expect(capability.info?.transports).toHaveLength(3)
    }
  })

  it('keeps claude/codex unsupported until process injection is wired', () => {
    for (const runtimeId of ['claude-code', 'codex'] as const) {
      const capability = deriveMcpSharingCapability(servers, runtimeId)
      expect(capability.supported).toBe(false)
    }
  })

  it('declares claude/codex supported only when wired and servers exist', () => {
    const capability = deriveMcpSharingCapability(servers, 'claude-code', {
      processInjectionWired: true,
    })
    expect(capability.supported).toBe(true)
    const empty = deriveMcpSharingCapability([], 'codex', {
      processInjectionWired: true,
    })
    expect(empty.supported).toBe(false)
  })

  it('keeps Hermes and pi unsupported without an MCP process projection', () => {
    for (const runtimeId of ['hermes', 'pi'] as const) {
      const capability = deriveMcpSharingCapability(servers, runtimeId, {
        processInjectionWired: true,
      })
      expect(capability.supported).toBe(false)
    }
  })
})
