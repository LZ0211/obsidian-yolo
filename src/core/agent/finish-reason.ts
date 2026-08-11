// src/core/agent/finish-reason.ts
export type AgentFinishReasonKind =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'error'
  | 'continue'
  | 'unknown'

export type AgentFinishReason = {
  kind: AgentFinishReasonKind
  raw: string | null
}

const PROVIDER_ALIASES: Record<string, AgentFinishReasonKind> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  tool_use: 'tool_calls',
  length: 'length',
  max_tokens: 'length',
  content_filter: 'content_filter',
  error: 'error',
  end_turn_continue: 'continue',
}

export const normalizeAgentFinishReason = (
  raw: string | null | undefined,
): AgentFinishReason => {
  if (!raw) return { kind: 'unknown', raw: null }
  const normalized = raw.trim().toLowerCase()
  return { kind: PROVIDER_ALIASES[normalized] ?? 'unknown', raw }
}
