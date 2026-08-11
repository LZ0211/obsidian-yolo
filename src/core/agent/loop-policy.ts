import type { AgentFinishReason } from './finish-reason'
import type { LoopDecision } from './loop-decision'

/**
 * Serializable snapshot of a continuing loop decision, handed to an optional
 * main-thread policy hook BEFORE the runtime acts on it. The policy can only
 * turn a continuing decision (`llm_request`/`tool_phase`) into a terminal
 * `stop`; it can never bypass approval, raise budgets, or turn a terminal
 * provider outcome back into a request.
 */
export type AgentLoopPolicyInput = {
  conversationId: string
  branchId: string
  iteration: number
  finishReason?: AgentFinishReason
  defaultDecision: LoopDecision
  usage?: { inputTokens?: number; outputTokens?: number }
}

export type AgentLoopPolicyResult =
  | { type: 'use_default' }
  | { type: 'stop'; reason: 'external_policy' }

/**
 * Main-thread-only loop policy. The function itself is NEVER serialized (no
 * `toString()` into the worker); only the serializable `AgentLoopPolicyInput`
 * is exchanged, and the hook runs on the main thread.
 */
export type AgentLoopPolicy = (
  input: AgentLoopPolicyInput,
) => AgentLoopPolicyResult | Promise<AgentLoopPolicyResult>

export const noopLoopPolicy: AgentLoopPolicy = async () => ({
  type: 'use_default',
})

/**
 * Apply the registered policy to a continuing default decision. Swallows/logs
 * policy errors and falls back to `use_default` so a misbehaving hook can never
 * crash or stall the agent loop.
 */
export const applyLoopPolicy = async ({
  input,
  policy,
}: {
  input: AgentLoopPolicyInput
  policy: AgentLoopPolicy
}): Promise<AgentLoopPolicyResult> => {
  try {
    return await policy(input)
  } catch (error) {
    console.warn(
      '[YOLO][AgentLoopPolicy] policy evaluation failed; using default decision',
      error,
    )
    return { type: 'use_default' }
  }
}
