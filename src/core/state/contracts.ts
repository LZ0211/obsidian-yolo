import { ENTITY_TITLE_KIND, LIFECYCLE_STATE } from './statuses'

export type Unsubscribe = () => void

export type Clock = {
  now(): number
}

export type IdGenerator = {
  next(namespace?: string): string
}

export type ExternalStore<TSnapshot> = {
  getSnapshot(): TSnapshot
  getServerSnapshot?(): TSnapshot
  subscribe(listener: () => void): Unsubscribe
}

export type EntityTitle =
  | { kind: typeof ENTITY_TITLE_KIND.UNTITLED }
  | { kind: typeof ENTITY_TITLE_KIND.NAMED; value: string }

export const isEntityTitle = (value: unknown): value is EntityTitle => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { kind?: unknown; value?: unknown }
  return (
    candidate.kind === ENTITY_TITLE_KIND.UNTITLED ||
    (candidate.kind === ENTITY_TITLE_KIND.NAMED &&
      typeof candidate.value === 'string')
  )
}

export const AGENT_SESSION_MODE = {
  EPHEMERAL: 'ephemeral',
  PERSISTENT: 'persistent',
} as const

export type AgentSessionMode =
  (typeof AGENT_SESSION_MODE)[keyof typeof AGENT_SESSION_MODE]

export const isAgentSessionMode = (value: unknown): value is AgentSessionMode =>
  value === AGENT_SESSION_MODE.EPHEMERAL ||
  value === AGENT_SESSION_MODE.PERSISTENT

export const COMMAND_RESULT_STATUS = {
  ACCEPTED: 'accepted',
  ALREADY_APPLIED: 'already_applied',
  REJECTED: 'rejected',
  CONFLICT: 'conflict',
  FAILED: 'failed',
} as const

export type CommandResultStatus =
  (typeof COMMAND_RESULT_STATUS)[keyof typeof COMMAND_RESULT_STATUS]

export type CommandResult<
  T = void,
  TRejection = unknown,
  TConflict = unknown,
> =
  | {
      status: typeof COMMAND_RESULT_STATUS.ACCEPTED
      sequence: number
      value: T
    }
  | {
      status: typeof COMMAND_RESULT_STATUS.ALREADY_APPLIED
      sequence: number
      value?: T
    }
  | { status: typeof COMMAND_RESULT_STATUS.REJECTED; reason: TRejection }
  | { status: typeof COMMAND_RESULT_STATUS.CONFLICT; conflict: TConflict }
  | {
      status: typeof COMMAND_RESULT_STATUS.FAILED
      incidentId: string
      retryable: boolean
    }

export type LifecycleState =
  (typeof LIFECYCLE_STATE)[keyof typeof LIFECYCLE_STATE]

export type LifecycleController = {
  start(): Promise<void>
  stop(): Promise<void>
}

export type ConversationProducer =
  | 'chat'
  | 'agent'
  | 'web'
  | 'bot'
  | 'mcp'
  | 'settings'
  | 'recovery'
