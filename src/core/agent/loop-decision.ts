type LlmResultInput = {
  hasToolCalls: boolean
  hasAssistantOutput: boolean
  iteration: number
  maxIterations: number
}

type ToolResultInput = {
  hasPendingTools: boolean
  iteration: number
  maxIterations: number
  forceStopReason?: 'repeated_tool_failure' | 'repeated_read_call'
  /**
   * Set when the exact duplicate-call guard fired (N consecutive identical
   * tool signatures). Checked after the existing repeated guards so those keep
   * priority, and before the approval pause and the iteration budget.
   */
  repeatedToolCall?: boolean
  /**
   * When true, one tools-disabled request is allowed past the iteration
   * budget. The flag lives in worker state, not a closure, so the Blob script
   * embeds this function self-contained.
   */
  graceEnabled?: boolean
  /**
   * Set when the single grace request has already been issued. With grace
   * enabled this must be true before the `max_iterations` branch can fire
   * again, otherwise the branch returns the one-off grace request instead.
   */
  graceUsed?: boolean
}

export type LoopDoneReason =
  | 'completed'
  | 'max_iterations'
  | 'repeated_tool_failure'
  | 'repeated_read_call'
  | 'repeated_tool_call'

export type LoopDecision =
  | { type: 'tool_phase' }
  | { type: 'llm_request'; nextIteration: number; toolsDisabled?: boolean }
  | { type: 'done'; reason: LoopDoneReason }

export type LlmLoopDecision =
  | { type: 'tool_phase' }
  | { type: 'llm_request'; nextIteration: number; toolsDisabled?: boolean }
  | { type: 'done'; reason: LoopDoneReason }

export type ToolLoopDecision =
  | { type: 'llm_request'; nextIteration: number; toolsDisabled?: boolean }
  | { type: 'done'; reason: LoopDoneReason }

export const decideAfterLlmResult = ({
  hasToolCalls,
}: LlmResultInput): LlmLoopDecision => {
  if (hasToolCalls) {
    return { type: 'tool_phase' }
  }

  // No tool calls → the turn is complete.
  // Retrying with the same input would not produce a different result,
  // so there is no reason to continue the loop.
  return { type: 'done', reason: 'completed' }
}

export const decideAfterToolResult = ({
  forceStopReason,
  repeatedToolCall,
  hasPendingTools,
  iteration,
  maxIterations,
  graceEnabled,
  graceUsed,
}: ToolResultInput): ToolLoopDecision => {
  if (forceStopReason) {
    return { type: 'done', reason: forceStopReason }
  }

  if (repeatedToolCall) {
    return { type: 'done', reason: 'repeated_tool_call' }
  }

  if (hasPendingTools) {
    return { type: 'done', reason: 'completed' }
  }

  if (iteration >= maxIterations) {
    if (graceEnabled && !graceUsed) {
      return {
        type: 'llm_request',
        nextIteration: iteration + 1,
        toolsDisabled: true,
      }
    }
    return { type: 'done', reason: 'max_iterations' }
  }

  return {
    type: 'llm_request',
    nextIteration: iteration + 1,
  }
}
