import { AGENT_RUN_STATUS, type AgentRunStatus } from '../core/state/statuses'

export const AGENT_MODE = {
  ASK: 'ask',
  AGENT: 'agent',
  PLAN: 'plan',
} as const

export type AgentMode = (typeof AGENT_MODE)[keyof typeof AGENT_MODE]

export const AGENT_MODES: readonly AgentMode[] = [
  AGENT_MODE.ASK,
  AGENT_MODE.AGENT,
  AGENT_MODE.PLAN,
]

export const isAgentMode = (value: unknown): value is AgentMode =>
  value === AGENT_MODE.ASK ||
  value === AGENT_MODE.AGENT ||
  value === AGENT_MODE.PLAN

export const RUN_OUTCOME = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
} as const

export type RunOutcome = (typeof RUN_OUTCOME)[keyof typeof RUN_OUTCOME]

export const RUN_OUTCOME_VALUES: readonly RunOutcome[] = [
  RUN_OUTCOME.COMPLETED,
  RUN_OUTCOME.FAILED,
  RUN_OUTCOME.ABORTED,
]

export const isRunOutcome = (value: unknown): value is RunOutcome =>
  RUN_OUTCOME_VALUES.includes(value as RunOutcome)

export type AgentRunTerminalStatus = Exclude<
  AgentRunStatus,
  typeof AGENT_RUN_STATUS.IDLE
>
