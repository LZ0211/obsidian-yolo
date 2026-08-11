import { decideAfterLlmResult } from './loop-decision'
import { applyLoopPolicy, noopLoopPolicy } from './loop-policy'
import type { AgentLoopPolicyInput, AgentLoopPolicyResult } from './loop-policy'

describe('applyLoopPolicy', () => {
  it('uses the default decision when no policy is registered', async () => {
    const decision = decideAfterLlmResult({
      hasToolCalls: false,
      hasAssistantOutput: true,
      iteration: 1,
      maxIterations: 100,
    })
    const out = await applyLoopPolicy({
      input: {
        conversationId: 'c',
        branchId: 'b',
        iteration: 1,
        defaultDecision: decision,
      },
      policy: noopLoopPolicy,
    })
    expect(out).toEqual({ type: 'use_default' })
  })

  it('can stop a continuing decision but cannot bypass approval or raise budgets', async () => {
    const policy = async (
      input: AgentLoopPolicyInput,
    ): Promise<AgentLoopPolicyResult> =>
      input.defaultDecision.type === 'llm_request'
        ? { type: 'stop', reason: 'external_policy' }
        : { type: 'use_default' }
    const decision = { type: 'llm_request' as const, nextIteration: 2 }
    const out = await applyLoopPolicy({
      input: {
        conversationId: 'c',
        branchId: 'b',
        iteration: 1,
        defaultDecision: decision,
      },
      policy,
    })
    expect(out).toEqual({ type: 'stop', reason: 'external_policy' })
  })
})
