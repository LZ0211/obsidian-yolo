import type {
  AgentFileChange,
  ChatMessage,
  DelegatedRoleMetadata,
  TaskSource,
} from '../../../types/chat'
import type { ResponseUsage } from '../../../types/llm/response'
import type { AgentSessionMode } from '../../state/contracts'

export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'aborted'

/**
 * Optional read-only parent-context fork for a delegated sub-agent.
 * - `none` (default): the child sees only the prompt — byte-identical to today.
 * - `last_turns`: compose the parent's last N messages into the child prompt.
 * - `full`: compose the whole parent history (size-capped) into the child prompt.
 * The fork is a read-only snapshot of the parent transcript as of the parent
 * run's start (buildSubagentParentContext captures `input.messages` at run
 * start, not at dispatch time).
 */
export type ForkContext = 'none' | 'last_turns' | 'full'

export type SubagentAcceptedResult = {
  accepted: true
  taskId: string
  /** Durable session identity (aligned with backup types.ts). */
  sessionId?: string
  runKey?: string
  sessionRevision?: number
  mode?: AgentSessionMode
  title: string
  status: 'running'
  note: string
  modelName?: string
  /** Delegated role identity (C3: backup types.ts 有，Task 6 只补了 4 字段). */
  delegatedRole?: DelegatedRoleMetadata
}

export type SubagentResult = {
  taskId: string
  status: 'completed' | 'failed' | 'aborted'
  content: string
  activityLog?: string
  durationMs: number
  toolUseCount: number
  usage?: ResponseUsage
  prompt?: string
  modelName?: string
  transcript?: ChatMessage[]
  changes?: AgentFileChange[]
  delegatedRole?: DelegatedRoleMetadata
}

export type SubagentTaskRecord = {
  taskId: string
  conversationId: string
  source: TaskSource
  title: string
  status: SubagentTaskStatus
  createdAt: number
  completedAt?: number
  prompt: string
  result?: SubagentResult
  liveTranscript?: ChatMessage[]
  activityLog?: string
  error?: string
  delegatedRole?: DelegatedRoleMetadata
  abortController: AbortController
  /** Durable session identity (aligned with backup types.ts). */
  sessionId?: string
  runSequence?: number
  runKey?: string
  mode?: AgentSessionMode
}

/** Registry-facing projection without streaming transcripts or abort owners. */
export type SubagentTaskSummary = Omit<
  SubagentTaskRecord,
  'liveTranscript' | 'abortController'
>

/** Completion-event record: summary plus the optional final transcript. */
export type SubagentTaskCompletionRecord = SubagentTaskSummary & {
  liveTranscript?: ChatMessage[]
}
