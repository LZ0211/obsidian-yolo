import type { McpServerState } from '../../../types/mcp.types'
import type { ChatCapabilityState } from '../../chat-runtime/contract'

/**
 * 把 MCP 注册表派生为契约 `mcpSharing` 能力（MCP 共享实例 plan Task 5）。
 *
 * - native（yolo）：native agent 经自身 McpManager 直连工具，恒 supported true；
 *   `transports` 反映当前共享 server 的传输面。
 * - claude-code / codex：SDK 透传 / codex 配置注入已实现，但进程级投影注入
 *   缝（coordinator runtime options）未接线前不得声明 true，避免能力与
 *   实际进程不一致；`processInjectionWired` 为真且存在共享 server 时才声明支持。
 */

const SHARED_TRANSPORTS = new Set(['http', 'sse', 'ws'])

export type McpSharingCapabilityRuntimeId = 'yolo' | 'claude-code' | 'codex'

export function deriveMcpSharingCapability(
  servers: readonly McpServerState[],
  runtimeId: McpSharingCapabilityRuntimeId,
  options?: { processInjectionWired?: boolean },
): ChatCapabilityState<{ transports: readonly ('http' | 'ws' | 'sse')[] }> {
  const shared = servers.filter(
    (server) =>
      server.config.enabled &&
      SHARED_TRANSPORTS.has(server.config.parameters.transport),
  )
  const transports = [
    ...new Set(
      shared.map((server) => server.config.parameters.transport),
    ),
  ] as ('http' | 'ws' | 'sse')[]

  if (runtimeId === 'yolo') {
    return { supported: true, info: { transports } }
  }

  if (!options?.processInjectionWired) {
    return {
      supported: false,
      reason:
        'CLI 进程级 MCP 投影注入未接线（coordinator runtime options seam）',
    }
  }

  return shared.length > 0
    ? { supported: true, info: { transports } }
    : { supported: false, reason: 'no shared MCP servers configured' }
}
