import type {
  AgentFileChange,
  ChatConversationCompactionState,
  ChatMessage,
} from '../../../types/chat'
import type { AgentSessionMode } from '../../state/contracts'
import {
  SUBAGENT_MESSAGE_INTENT_STATE,
  SUBAGENT_RUN_STATUS,
  SUBAGENT_SESSION_STATUS,
} from '../../state/statuses'

import type { SubagentResult } from './types'

export const SUBAGENT_SESSION_SCHEMA_VERSION = 1

export function makeSubagentRunKey(
  sessionId: string,
  runSequence: number,
): string {
  if (!sessionId.trim()) {
    throw new Error('sessionId must be nonempty.')
  }
  if (!Number.isSafeInteger(runSequence) || runSequence < 1) {
    throw new Error('runSequence must be a safe integer greater than zero.')
  }
  return `${sessionId}:${runSequence}`
}

export type SubagentSessionStatus =
  (typeof SUBAGENT_SESSION_STATUS)[keyof typeof SUBAGENT_SESSION_STATUS]

export type SubagentRunStatus =
  (typeof SUBAGENT_RUN_STATUS)[keyof typeof SUBAGENT_RUN_STATUS]

export type SubagentResultSummary = {
  status: SubagentResult['status']
  content: string
  durationMs: number
  toolUseCount: number
  modelName?: string
}

export type ResolvedSubagentRunPolicySnapshot = {
  modelId: string
  delegatedRoleId?: string
  allowedToolNames: readonly string[]
  allowedSkillPaths: readonly string[]
  toolApprovalMode: 'full_access' | 'require_approval'
  resolvedAt: number
}

export type SubagentSession = {
  sessionId: string
  parentConversationId: string
  originAssistantMessageId: string
  originToolCallId: string
  originBranchId?: string
  title: string
  mode: AgentSessionMode
  status: SubagentSessionStatus
  revision: number
  nextRunSequence: number
  currentRunSequence?: number
  delegatedRoleId?: string
  modelPreferenceId?: string
  memoryAssistantId: string
  createdAt: number
  lastActiveAt: number
  archivedAt?: number
}

export type SubagentRun = {
  sessionId: string
  runSequence: number
  runKey: string
  promptMessageId: string
  /**
   * 首 run prompt 文本（Task 7 ⚠️ 落盘要求）：backup 的 SubagentRun 无此字段
   * （backup 由 session actor 经 submit_session_message 持久化 prompt），master
   * 无 actor，spawn 时随 run 记录落盘；reload 后 transcript 为空时
   * `runSubagentSessionContinuation` 用它重建首条 user 消息。
   */
  prompt?: string
  status: SubagentRunStatus
  basedOnSessionRevision: number
  resolvedPolicySnapshot?: ResolvedSubagentRunPolicySnapshot
  startedAt?: number
  completedAt?: number
  result?: SubagentResultSummary
  errorCode?: string
}

export type SubagentSessionSnapshot = {
  session: Readonly<SubagentSession>
  currentRun?: Readonly<SubagentRun>
  recentRuns: readonly Readonly<SubagentRun>[]
  /**
   * 队列意图（Task 10 UI）：pending/recovery_required 供卡片 queued 计数与
   * 详情弹窗 resend/drop 决断；读路径透出，写路径不变。
   */
  intents?: readonly SubagentMessageIntent[]
  transcriptPage?: readonly ChatMessage[]
  compaction?: ChatConversationCompactionState
  nextCursor?: string
  changes?: readonly AgentFileChange[]
  queryError?: {
    code: 'transcript_corrupt'
    segmentId: string
  }
}

export type SubagentMessageIntentState =
  (typeof SUBAGENT_MESSAGE_INTENT_STATE)[keyof typeof SUBAGENT_MESSAGE_INTENT_STATE]

export type SubagentMessageIntent = {
  requestId: string
  sessionId: string
  messageId: string
  text: string
  delivery: 'next_boundary' | 'after_run'
  state: SubagentMessageIntentState
  createdAt: number
  claimedByRunKey?: string
  committedRunKey?: string
}

export type TrustedSubagentCallerContext = {
  parentConversationId: string
  originAssistantMessageId: string
  originToolCallId: string
  originBranchId?: string
}

export type SubagentSpawnInput = {
  title: string
  prompt: string
  mode: AgentSessionMode
  delegatedRoleId?: string
  modelPreferenceId?: string
  requestId: string
}

export type SubagentSendInput = {
  sessionId: string
  messageId: string
  text: string
  delivery: 'next_boundary' | 'after_run'
  expectedSessionRevision: number
  requestId: string
}

export type SubagentQueueRecoveryInput = {
  sessionId: string
  messageId: string
  expectedSessionRevision: number
  action: 'resend' | 'drop'
  requestId: string
}

export type SubagentCloseInput = {
  sessionId: string
  expectedSessionRevision: number
  requestId: string
  reason?: string
}

export type SubagentRecoverInput = {
  sessionId: string
  expectedSessionRevision: number
  action: 'mark_interrupted_run_aborted'
  requestId: string
}

export type SubagentQueryOptions = {
  detail?: 'summary' | 'transcript' | 'changes'
  cursor?: string
  limit?: number
}

export type SubagentControlErrorCode =
  | 'ownership_mismatch'
  | 'request_id_reused'
  | 'revision_conflict'
  | 'session_not_found'
  | 'session_not_sendable'
  | 'policy_unavailable'
  | 'resource_limit'
  | 'queue_recovery_required'
  | 'transcript_corrupt'
  | 'parent_orphaned'
  | 'durability_failed'

export type SubagentControlRejected =
  | {
      accepted: false
      errorCode: 'revision_conflict'
      retryable: true
      current: Readonly<SubagentSessionSnapshot>
    }
  | {
      accepted: false
      errorCode: Exclude<SubagentControlErrorCode, 'revision_conflict'>
      retryable: boolean
      current?: Readonly<SubagentSessionSnapshot>
    }

export type SubagentSpawnResult =
  | {
      accepted: true
      sessionId: string
      runKey: string
      sessionRevision: number
    }
  | SubagentControlRejected

export type SubagentSendResult =
  | {
      accepted: true
      runKey?: string
      queued: boolean
      sessionRevision: number
    }
  | SubagentControlRejected

export type SubagentCloseResult =
  | {
      accepted: true
      status:
        | typeof SUBAGENT_SESSION_STATUS.CLOSING
        | typeof SUBAGENT_SESSION_STATUS.ARCHIVED
      sessionRevision: number
    }
  | SubagentControlRejected

export type SubagentRecoverResult =
  | {
      accepted: true
      status: typeof SUBAGENT_SESSION_STATUS.IDLE
      sessionRevision: number
    }
  | SubagentControlRejected

export type SubagentQueueRecoveryResult =
  | {
      accepted: true
      state:
        | typeof SUBAGENT_MESSAGE_INTENT_STATE.PENDING
        | typeof SUBAGENT_MESSAGE_INTENT_STATE.DROPPED
      sessionRevision: number
    }
  | SubagentControlRejected

/** beginRun 输入（Task 7 审查 #2：IDLE 续跑前创建新 run 记录并推进 nextRunSequence）。 */
export type SubagentBeginRunInput = {
  sessionId: string
  expectedSessionRevision: number
  prompt: string
}

export type SubagentBeginRunResult =
  | {
      accepted: true
      runKey: string
      runSequence: number
      sessionRevision: number
      /**
       * 新 run 的实际 prompt（Task 9 意图投递）：原子 claim 的 after_run 意图
       * 文本（deliveredIntent=true 时），否则输入兜底 prompt。runner 用它构造
       * 新 run 的首条 user 消息（Task 7 Minor #1：意图文本合入，非旧 prompt）。
       */
      prompt: string
      /** true = 本次 beginRun 原子 claim 了首个 PENDING after_run 意图 */
      deliveredIntent: boolean
    }
  | SubagentControlRejected
