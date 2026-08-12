import type {
  AgentFileChange,
  ChatMessage,
  DelegatedRoleMetadata,
  TaskSource,
} from '../../../types/chat'
import type { ResponseUsage } from '../../../types/llm/response'
import type { AgentSessionMode } from '../../state/contracts'

export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'aborted'

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
