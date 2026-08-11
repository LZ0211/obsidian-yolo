import type { WebApiClient } from './WebApiClient'

export function createWebMcpManager({ api }: { api: WebApiClient }) {
  const unavailable = (): never => {
    throw new Error(
      'MCP server administration is not available in the shared web runtime.',
    )
  }

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
    getJsSandboxSettings: () => ({
      enabled: false,
      requireReview: true,
      allowNetwork: false,
      readLimitKb: 0,
    }),
    subscribeServersChange: (_listener: (servers: unknown[]) => void) =>
      () => undefined,
    getServers: unavailable,
  }
}
