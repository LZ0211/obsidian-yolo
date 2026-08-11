// src/core/agent/finish-reason.test.ts
import { normalizeAgentFinishReason } from './finish-reason'

describe('normalizeAgentFinishReason', () => {
  it('maps known provider aliases deterministically', () => {
    expect(normalizeAgentFinishReason('stop')).toEqual({ kind: 'stop', raw: 'stop' })
    expect(normalizeAgentFinishReason('tool_use')).toEqual({ kind: 'tool_calls', raw: 'tool_use' })
    expect(normalizeAgentFinishReason('tool_calls')).toEqual({ kind: 'tool_calls', raw: 'tool_calls' })
    expect(normalizeAgentFinishReason('max_tokens')).toEqual({ kind: 'length', raw: 'max_tokens' })
    expect(normalizeAgentFinishReason('length')).toEqual({ kind: 'length', raw: 'length' })
    expect(normalizeAgentFinishReason('content_filter')).toEqual({ kind: 'content_filter', raw: 'content_filter' })
    expect(normalizeAgentFinishReason('error')).toEqual({ kind: 'error', raw: 'error' })
  })

  it('maps the responses end_turn-continue alias to the continue kind', () => {
    expect(normalizeAgentFinishReason('end_turn_continue')).toEqual({
      kind: 'continue',
      raw: 'end_turn_continue',
    })
  })

  it('maps unknown strings to unknown while preserving raw', () => {
    expect(normalizeAgentFinishReason('bogus_reason')).toEqual({ kind: 'unknown', raw: 'bogus_reason' })
  })

  it('maps a missing reason to unknown, not stop', () => {
    expect(normalizeAgentFinishReason(null)).toEqual({ kind: 'unknown', raw: null })
    expect(normalizeAgentFinishReason(undefined)).toEqual({ kind: 'unknown', raw: null })
  })
})
