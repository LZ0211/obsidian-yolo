import type { ChatMessage } from '../../../types/chat'
import type { Mentionable } from '../../../types/mentionable'
import type { CliRuntimeId } from '../../cli-runtime/types'
import type { ChatRuntimeRunFailure, ChatRuntimeRunState } from '../contract'

export type CliBackendSessionRef = Readonly<{
  runtimeId: CliRuntimeId
  nativeSessionId: string
  sessionPathHint?: string
}>

export type CliBackendEvent =
  | Readonly<{ type: 'session_bound'; ref: CliBackendSessionRef }>
  | Readonly<{ type: 'message_upsert'; message: ChatMessage }>
  | Readonly<{ type: 'message_remove'; messageId: string }>
  | Readonly<{
      type: 'run_state'
      state: ChatRuntimeRunState
      error?: string
      /** 结构化失效载荷，adapter 透传到契约 run.state.failure。 */
      failure?: ChatRuntimeRunFailure
    }>
  | Readonly<{ type: 'context_usage'; usage: unknown }>
  | Readonly<{ type: 'turn_metrics'; usage?: unknown; durationMs?: number }>
  | Readonly<{ type: 'compaction_state'; isCompacting: boolean }>
  | Readonly<{
      type: 'compaction_boundary'
      boundary: { id: string; afterMessageId: string | null }
    }>
  | Readonly<{
      type: 'submission.accepted'
      optimisticMessageId: string
      nativeMessageId: string
      baseRevision?: number
    }>
  | Readonly<{
      type: 'submission.rejected'
      messageId: string
      reason: string
      retryable: boolean
    }>

export type CliBackendSnapshot = Readonly<{
  surfaceId: string
  conversationEpoch: number
  messages: readonly ChatMessage[]
  sessionRef: CliBackendSessionRef | null
  runState: ChatRuntimeRunState
  error: string | null
  /** 与 error 同源的失效分类（无则省略）。 */
  failure?: ChatRuntimeRunFailure | null
  configuration: unknown
}>

export type CliBackendTurnInput = Readonly<{
  sessionRef?: CliBackendSessionRef | null
  userMessageId?: string
  content: string
  mentionables?: readonly Mentionable[]
  assistantId?: string
  selectedSkills?: readonly {
    name: string
    description?: string
    path?: string
  }[]
}>

export type CliBackend = {
  /**
   * 只订阅 controller 的稳定快照流（乐观消息、provider ID 对账、stale submission
   * 保护都在 controller 内完成）；禁止旁路订阅 raw CliRuntime 事件。
   */
  subscribe(listener: (event: CliBackendEvent) => void): () => void
  getSnapshot(): CliBackendSnapshot
  sendTurn(input: CliBackendTurnInput): Promise<void>
  rewriteTurn(
    input: CliBackendTurnInput & { sourceUserMessageId: string },
  ): Promise<void>
  rollbackToTurn(sourceUserMessageId: string): Promise<void>
  cancel(): Promise<void>
  respondApproval(response: {
    requestId: string
    decision: 'approve_once' | 'approve_for_session' | 'reject'
  }): Promise<void>
  respondQuestion(response: {
    requestId: string
    answer: unknown
  }): Promise<void>
  updateConfiguration(update: {
    modelId?: string | null
    reasoningEffort?: string | null
  }): Promise<void>
  updatePermissionProfile(update: {
    mode: 'ask' | 'agent' | 'plan'
    yoloEnabled: boolean
  }): Promise<void>
  listSessions(): Promise<readonly CliBackendSessionSummary[]>
  openSession(ref: CliBackendSessionRef): Promise<void>
  renameSession(ref: CliBackendSessionRef, title: string): Promise<void>
  deleteSession(ref: CliBackendSessionRef): Promise<void>
  setSessionTitle(ref: CliBackendSessionRef, title: string): Promise<void>
  setSessionPinned(ref: CliBackendSessionRef, pinned: boolean): Promise<void>
  compact(): Promise<void>
  readSubagent(ref: {
    parentSessionRef: CliBackendSessionRef
    toolCallId: string
    subagentId: string
  }): Promise<readonly ChatMessage[]>
  dispose(): Promise<void>
}

export type CliBackendSessionSummary = Readonly<{
  ref: CliBackendSessionRef
  title: string
  preview?: string
  updatedAt: number
  isPinned?: boolean
}>
