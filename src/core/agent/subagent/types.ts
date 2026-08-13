import type {
  AgentFileChange,
  ChatMessage,
  DelegatedRoleMetadata,
  TaskSource,
} from '../../../types/chat'
import type { ResponseUsage } from '../../../types/llm/response'
import type { ProjectTaskBinding } from '../project/types'

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
  // Project delivery bridge parity: project/ 的 deliveryBridge 与测试（T1 拷贝）
  // 访问 projectTask/runKey/sessionId/runSequence（T1 补前两字段，T2 补后两字段）。
  projectTask?: ProjectTaskBinding
  abortController: AbortController
  runKey?: string
  sessionId?: string
  runSequence?: number
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
