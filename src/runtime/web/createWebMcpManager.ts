import type { WebApiClient } from './WebApiClient'

import type {
  JsSandboxSettings,
  YoloSettings,
} from '../../settings/schema/setting.types'

/**
 * Web 运行时无法导入 core 的 getJsSandboxSettings（jsSandboxSettings.ts 会
 * 拖入 jsSandboxTool → obsidian，破坏 web bundle 边界）。就地实现与其
 * normalizeJsSandboxConfig 相同的归一化：启用外部脚本隐式启用网络（任何
 * 远程脚本自己就能 fetch）。
 */
const normalizeWebJsSandboxSettings = (
  settings?: YoloSettings,
): JsSandboxSettings => {
  const config = settings?.jsSandbox ?? {}
  if (config.allowExternalScripts && !config.allowFetch) {
    return { ...config, allowFetch: true }
  }
  return config
}

export function createWebMcpManager({
  api,
  getSettings,
}: {
  api: WebApiClient
  getSettings: () => YoloSettings
}) {
  return {
    listAvailableTools: (options: {
      includeBuiltinTools?: boolean
      chatModelModalities?: unknown[]
    }) => api.postJson('/api/mcp/list-tools', options),
    allowToolForConversation: (
      requestToolName: string,
      conversationId: string,
      requestArgs?: Record<string, unknown>,
    ) =>
      api.postJson('/api/mcp/allow-tool-for-conversation', {
        requestToolName,
        conversationId,
        requestArgs,
      }),
    callTool: (input: Record<string, unknown>) =>
      api.postJson('/api/mcp/call-tool', input),
    abortToolCall: async (id: string) => {
      const response = await api.postJson<{ aborted: boolean }>(
        '/api/mcp/abort-tool-call',
        { id },
      )
      return response.aborted
    },
    /**
     * js_eval 在 web 端没有本地执行路径：调用经 /api/mcp/call-tool 代理到
     * 宿主的 localFileTools（宿主侧的 getJsSandboxSettings 才是执行时权威）。
     * 此处返回真实设置（含与桌面一致的 allowExternalScripts → allowFetch
     * 归一化）的镜像，供客户端能力描述/上下文估算消费，而不是旧实现硬编码
     * 的虚构形状（enabled/requireReview/allowNetwork/readLimitKb 与真实的
     * JsSandboxSettings 字段完全不同，会让 selectAllowedTools 等消费方误判
     * 能力为全关——与宿主实际执行行为脱节）。
     */
    getJsSandboxSettings: (): JsSandboxSettings =>
      normalizeWebJsSandboxSettings(getSettings()),
    /** 与桌面 McpManager.getSettingsSnapshot 同签名：当前设置快照。 */
    getSettingsSnapshot: (): YoloSettings => getSettings(),
    /**
     * 明确的 no-op：web 端不存在宿主侧的实时服务器状态订阅（服务器连接由
     * 宿主进程持有，浏览器端不感知）。返回空卸载函数，保持
     * McpManager.subscribeServersChange 的契约形状（unsubscribe）不变。
     */
    subscribeServersChange: (_listener: (servers: unknown[]) => void) =>
      () => undefined,
    /**
     * 与桌面 McpManager.getServers 同签名但返回空快照：web 端无服务器状态
     * 概念（连接状态只在宿主侧存在，且 /api/settings 不下发实时状态）。
     * 共享 UI 中只有桌面设置区（AgentSection/McpSection）消费服务器数组；
     * 返回空数组让任何意外消费方退化为"无服务器"而不是抛错。
     */
    getServers: (): unknown[] => [],
  }
}
