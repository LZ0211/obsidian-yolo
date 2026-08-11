/**
 * Web 运行时本地会话类型层（Task 10 master 适配产物）。
 *
 * backup 的 WebConversationGateway 构建在 `src/core/conversation/*` 子系统上
 * （gateway/commands、domain/types、gateway/ConversationGateway、
 * projection/ConversationProjection），该子系统在 master 已被 ChatManager
 * 取代、整体不存在。本文件把 gateway 实际消费的类型/命令/投影收拢为本地
 * 定义，语义与 backup 逐条对齐（gateway 逻辑本身零改动，仅 import 换源）；
 * 删除的部分是 backup 投影里依赖 backup 独有状态机（activity/durability/
 * run/submission 投影，基于 activityProjection/stateMappings/runStateReducer，
 * master 均无）的字段——web 的运行状态改由 agent 运行时状态提供。
 */

import type {
  ConversationProducer,
  EntityTitle,
  CommandResult as StateCommandResult,
} from '../../core/state/contracts'
import {
  type ApprovalDecision,
  ENTITY_TITLE_KIND,
  HYDRATION_STATUS,
  type HydrationStatus,
  type ToolExecutionStatus,
} from '../../core/state/statuses'
import type { RunOutcome } from '../../types/agentRun'
import type {
  ChatConversationCompactionLike,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import { stableStringify } from '../../utils/json/stableStringify'

/* ------------------------------------------------------------------ */
/* domain types（backup src/core/conversation/domain/types.ts 子集）    */
/* ------------------------------------------------------------------ */

export type ConversationMessage = Readonly<ChatMessage>
export type ConversationUserMessage = Readonly<ChatUserMessage>

/** Web 会话的 agent 绑定（master 会话类型无此字段；backup 的
 *  `ChatWebBinding` 在 master 由 core/web-server/webAgentTypes 定义，
 *  运行时层持本地等价物，避免 web 端静态依赖 web-server）。 */
export type WebChatBinding = {
  initialAgentId: string
  activeAgentId: string
  rootHash: string
  accessState?: 'active' | 'orphaned'
  orphanedReason?:
    | 'agent_deleted'
    | 'template_deleted'
    | 'root_unavailable'
    | 'agent_invalid'
  updatedAt?: number
}

export type ConversationMetadata = {
  createdAt: number
  updatedAt: number
  assistantId?: string | null
  conversationModelId?: string
  overrides?: ConversationOverrideSettings | null
  messageModelMap?: Record<string, string>
  activeBranchByUserMessageId?: Record<string, string>
  assistantGroupBoundaryMessageIds?: string[]
  isPinned?: boolean
  pinnedAt?: number
  reasoningLevel?: string
  workingDirectory?: string
  fileScopeLocked?: boolean
  workspaceId?: string | null
  agentInstanceId?: string | null
  webBinding?: WebChatBinding | null
  origin?: 'user' | 'external-agent'
  compaction?: ChatConversationCompactionLike | null
}

export type ConversationMetadataPatch = Partial<ConversationMetadata>

export type ConversationCompaction = {
  branchId: string
  anchorMessageId: string
  sourceMessageGeneration: number
  compactionBaseSequence: number
  summary: string
  compactedAt: number
}

/**
 * 聚合状态（backup 全量形状的裁剪版）：gateway/投影只触碰
 * sequence/title/metadata/messages/messageOrder/deleted；backup 的
 * submissions/runs/approvals/toolExecutions/subagents/compactions/
 * commandReceipts 在 master 无生产者，一并移除。
 */
export type ConversationAggregateState = {
  schemaVersion: 1
  conversationId: string
  sequence: number
  title: EntityTitle
  metadata: ConversationMetadata
  messages: ReadonlyMap<string, ConversationMessage>
  messageOrder: readonly string[]
  deleted: boolean
}

export const createEmptyConversationState = (
  conversationId: string,
): ConversationAggregateState => ({
  schemaVersion: 1,
  conversationId,
  sequence: 0,
  title: { kind: ENTITY_TITLE_KIND.UNTITLED },
  metadata: { createdAt: 0, updatedAt: 0 },
  messages: new Map(),
  messageOrder: [],
  deleted: false,
})

/* ------------------------------------------------------------------ */
/* commands（backup src/core/conversation/gateway/commands.ts 全量）    */
/* ------------------------------------------------------------------ */

export type ConversationCommandBase = {
  conversationId: string
  commandId: string
  payloadFingerprint: string
  correlationId: string
  producer: ConversationProducer
  expectedSequence?: number
  causationId?: string
}

export type CreateConversationCommand = ConversationCommandBase & {
  type: 'create_conversation'
  title?: EntityTitle
  metadata?: ConversationMetadataPatch
}

export type SubmitUserMessageCommand = ConversationCommandBase & {
  type: 'submit_user_message'
  submissionId: string
  message: ConversationUserMessage
}

export type QueueUserMessageCommand = ConversationCommandBase & {
  type: 'queue_user_message'
  submissionId: string
  message: ConversationUserMessage
}

export type RetryFailedSubmissionCommand = ConversationCommandBase & {
  type: 'retry_failed_submission'
  submissionId: string
}

export type DismissFailedSubmissionCommand = ConversationCommandBase & {
  type: 'dismiss_failed_submission'
  submissionId: string
}

export type StartRunCommand = ConversationCommandBase & {
  type: 'start_run'
  runId: string
  sourceUserMessageId: string
  sourceMessageGeneration: number
  branchId: string
}

export type BeginRunExecutionCommand = ConversationCommandBase & {
  type: 'begin_run_execution'
  runId: string
}

export type FinalizeMessageCommand = ConversationCommandBase & {
  type: 'finalize_message'
  runId: string
  message: ConversationMessage
  sourceUserMessageId: string
  sourceMessageGeneration: number
}

export type RequestApprovalCommand = ConversationCommandBase & {
  type: 'request_approval'
  approvalId: string
  runId: string
  toolCallId: string
  request: unknown
}

export type ResolveApprovalCommand = ConversationCommandBase & {
  type: 'resolve_approval'
  approvalId: string
  decision: ApprovalDecision
}

export type RequestToolExecutionCommand = ConversationCommandBase & {
  type: 'request_tool_execution'
  runId: string
  toolCallId: string
  payload: unknown
  requiresApproval?: boolean
}

export type SettleToolExecutionCommand = ConversationCommandBase & {
  type: 'settle_tool_execution'
  runId: string
  toolCallId: string
  status: ToolExecutionStatus
  result?: unknown
  errorMessage?: string
}

export type AttachSubagentCommand = ConversationCommandBase & {
  type: 'attach_subagent'
  sessionId: string
  taskId: string
  parentRunId: string
  toolCallId: string
}

export type SettleSubagentCommand = ConversationCommandBase & {
  type: 'settle_subagent'
  sessionId: string
  taskId: string
  status: RunOutcome
  result?: unknown
  errorMessage?: string
}

export type CompleteRunCommand = ConversationCommandBase & {
  type: 'complete_run'
  runId: string
}

export type FailRunCommand = ConversationCommandBase & {
  type: 'fail_run'
  runId: string
  errorMessage?: string
  incidentId?: string
}

export type AbortRunCommand = ConversationCommandBase & {
  type: 'abort_run'
  runId: string
  reason?: string
}

export type EditHistoricalTurnCommand = ConversationCommandBase & {
  type: 'edit_historical_turn'
  messageId: string
  message: ConversationMessage
  expectedMessageGeneration: number
}

export type DeleteHistoricalGroupCommand = ConversationCommandBase & {
  type: 'delete_historical_group'
  groupId: string
  messageIds: readonly string[]
  expectedMessageGenerations: Readonly<Record<string, number>>
}

export type ClaimHistoricalRetryCommand = ConversationCommandBase & {
  type: 'claim_historical_retry'
  messageId: string
  expectedMessageGeneration: number
}

export type PatchConversationMetadataCommand = ConversationCommandBase & {
  type: 'patch_conversation_metadata'
  patch: ConversationMetadataPatch
}

export type GenerateConversationTitleCommand = ConversationCommandBase & {
  type: 'generate_conversation_title'
  title: EntityTitle
  expectedTitle?: EntityTitle
  force?: boolean
}

export type CommitCompactionCommand = ConversationCommandBase & {
  type: 'commit_compaction'
  compaction: ConversationCompaction
}

export type DeleteConversationCommand = ConversationCommandBase & {
  type: 'delete_conversation'
}

export type ConversationCommand =
  | CreateConversationCommand
  | SubmitUserMessageCommand
  | QueueUserMessageCommand
  | RetryFailedSubmissionCommand
  | DismissFailedSubmissionCommand
  | StartRunCommand
  | BeginRunExecutionCommand
  | FinalizeMessageCommand
  | RequestApprovalCommand
  | ResolveApprovalCommand
  | RequestToolExecutionCommand
  | SettleToolExecutionCommand
  | AttachSubagentCommand
  | SettleSubagentCommand
  | CompleteRunCommand
  | FailRunCommand
  | AbortRunCommand
  | EditHistoricalTurnCommand
  | DeleteHistoricalGroupCommand
  | ClaimHistoricalRetryCommand
  | PatchConversationMetadataCommand
  | GenerateConversationTitleCommand
  | CommitCompactionCommand
  | DeleteConversationCommand

export type DomainRejection = {
  code:
    | 'conversation_deleted'
    | 'invalid_command'
    | 'invalid_state'
    | 'idempotency_key_reused'
    | 'already_deleted'
  message?: string
}

export type DomainConflict = {
  code:
    | 'stale_sequence'
    | 'stale_message_generation'
    | 'stale_compaction'
    | 'stale_approval'
    | 'stale_tool_execution'
    | 'stale_title'
  entityId?: string
  expectedGeneration?: number
  actualGeneration?: number
}

export type CommandResult<T = void> = StateCommandResult<
  T,
  DomainRejection,
  DomainConflict
>

export type ConversationCommandValue<TCommand extends ConversationCommand> =
  TCommand extends CreateConversationCommand
    ? { conversationId: string }
    : TCommand extends SubmitUserMessageCommand | QueueUserMessageCommand
      ? { submissionId: string }
      : TCommand extends StartRunCommand
        ? { runId: string }
        : TCommand extends FinalizeMessageCommand
          ? { messageId: string }
          // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- backup commands.ts 同源：无值命令的 value 类型
          : void

export type CommandHandle<TCommand extends ConversationCommand> = {
  commandId: string
  settled: Promise<CommandResult<ConversationCommandValue<TCommand>>>
}

/* ------------------------------------------------------------------ */
/* gateway 接口（backup gateway/ConversationGateway.ts 全量）           */
/* ------------------------------------------------------------------ */

/**
 * Identity of an in-memory resource pin held by a consumer (a mounted view,
 * an active run, a pending effect, or a serialized command mailbox). Pins only
 * keep the actor-era LRU registry from evicting the conversation; the
 * snapshot-backed gateway keeps every projection in memory, so pins are
 * accepted and dropped (no-op).
 */
export type ActorPin =
  | `view:${string}`
  | `run:${string}`
  | `effect:${string}`
  | `mailbox:${string}`

export type MetadataPageRequest = {
  limit?: number
  cursor?: string
}

export type ConversationMetadataEntry = {
  conversationId: string
  sequence: number
  hash: string
  updatedAt: number
}

export type MetadataPage = {
  items: readonly ConversationMetadataEntry[]
  nextCursor?: string
}

export type ConversationGateway = {
  dispatch<TCommand extends ConversationCommand>(
    command: TCommand,
  ): CommandHandle<TCommand>
  getSnapshot(conversationId: string): ConversationProjection
  subscribe(conversationId: string, listener: () => void): () => void
  listMetadataPage(request: MetadataPageRequest): Promise<MetadataPage>
  ensureHydrated(conversationId: string): Promise<void>
  pin(conversationId: string, pin: ActorPin): () => void
  replaceRuntimeMessages(
    conversationId: string,
    messages: readonly ConversationMessage[],
  ): void
  clearRuntimeMessages(conversationId: string): void
}

export type ConversationCommandResult<TCommand extends ConversationCommand> =
  Awaited<CommandHandle<TCommand>['settled']> extends infer Result
    ? Result extends { value: ConversationCommandValue<TCommand> }
      ? Result
      : Awaited<CommandHandle<TCommand>['settled']>
    : never

/* ------------------------------------------------------------------ */
/* 投影（backup projection/ConversationProjection.ts 裁剪版）           */
/* ------------------------------------------------------------------ */

export type TimelineItemProjection = {
  id: string
  kind: 'message'
  message: ConversationMessage
  runtimeOnly?: boolean
}

export type HydrationProjection = {
  status: HydrationStatus
  error?: string
}

export type ConversationProjection = {
  conversationId: string
  sequence: number
  metadata: ConversationMetadata & {
    title: ConversationAggregateState['title']
  }
  timelineIds: readonly string[]
  itemsById: ReadonlyMap<string, TimelineItemProjection>
  hydration: HydrationProjection
}

const messageFingerprint = (message: ConversationMessage): string =>
  stableStringify(message)

export class ConversationProjectionStore {
  private state: ConversationAggregateState
  private snapshot: ConversationProjection
  private readonly listeners = new Set<() => void>()
  private runtimeItems = new Map<string, TimelineItemProjection>()
  private runtimeTimeline: readonly TimelineItemProjection[] | null = null
  private runtimeMessageFingerprints = new Map<string, string>()
  private hydration: HydrationProjection = {
    status: HYDRATION_STATUS.UNHYDRATED,
  }
  private asyncNotifyScheduled = false

  constructor(
    conversationId: string,
    state: ConversationAggregateState = createEmptyConversationState(
      conversationId,
    ),
  ) {
    this.state = state
    this.snapshot = this.buildSnapshot()
  }

  getSnapshot = (): ConversationProjection => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  applyDurableState(state: ConversationAggregateState): void {
    if (state.sequence < this.state.sequence) return
    this.state = state
    // Runtime-only delta items whose message is now covered by the durable
    // state must not keep shadowing it. Overlay copies of durable messages
    // that were removed from the durable set (e.g. edit truncation) must not
    // resurrect as runtime-only items either.
    this.runtimeItems = new Map(
      [...this.runtimeItems].filter(([id]) => !state.messages.has(id)),
    )
    this.runtimeTimeline = this.pruneRuntimeTimeline()
    this.hydration = { status: HYDRATION_STATUS.READY }
    this.publish()
  }

  /**
   * The durable message list in timeline order. The projection snapshot can be
   * shadowed by a full-timeline runtime overlay, so persistence must read the
   * durable source instead of `getSnapshot().itemsById`.
   */
  durableMessages(): ConversationMessage[] {
    return this.state.messageOrder.flatMap((messageId) => {
      const message = this.state.messages.get(messageId)
      return message ? [message] : []
    })
  }

  replaceRuntimeMessages(messages: readonly ConversationMessage[]): void {
    const nextFingerprints = new Map<string, string>()
    const nextTimeline: TimelineItemProjection[] = messages.map((message) => {
      // A message that already reached the durable journal must never be
      // reverted by a stale runtime copy (the UI sync path writes the agent
      // service's snapshot back; the snapshot may lag one event behind the
      // journal). Reverting it would make content appear/disappear as the two
      // states alternate. Use the durable message as the source of truth.
      const durableMessage = this.state.messages.get(message.id)
      const effectiveMessage = durableMessage ?? message
      const runtimeOnly = !durableMessage
      const previous = this.snapshot.itemsById.get(message.id)
      const existingFingerprint = this.runtimeMessageFingerprints.get(
        message.id,
      )
      const fingerprint =
        previous?.message === effectiveMessage
          ? existingFingerprint
          : messageFingerprint(effectiveMessage)
      if (fingerprint !== undefined) {
        nextFingerprints.set(message.id, fingerprint)
      }
      if (
        previous &&
        previous.runtimeOnly === runtimeOnly &&
        (previous.message === effectiveMessage ||
          (fingerprint !== undefined && existingFingerprint === fingerprint))
      ) {
        return previous
      }
      return {
        id: message.id,
        kind: 'message',
        message: effectiveMessage,
        runtimeOnly,
      }
    })
    // The runtime overlay only contributes runtime-only increments to the
    // snapshot (durable messages always come from the durable base). A
    // write-back that changes only durable copies is therefore a no-op: the
    // UI sync path mirrors the visible timeline back on every publish, and
    // republishing an unchanged increment would recurse forever. An empty
    // overlay is the absence of an overlay (normalized to null below), so
    // writing [] while no overlay exists is also a no-op; treating it as a
    // change would publish → forceStoreRerender → replace([]) → publish forever.
    const currentTimeline = this.runtimeTimeline
    const currentRuntimeOnly = currentTimeline
      ? currentTimeline.filter((item) => !this.state.messages.has(item.id))
      : null
    const nextRuntimeOnly = nextTimeline.filter(
      (item) => !this.state.messages.has(item.id),
    )
    const nextIsEmpty = nextTimeline.length === 0
    if (
      (currentRuntimeOnly &&
        nextRuntimeOnly.length === currentRuntimeOnly.length &&
        nextRuntimeOnly.every(
          (item, index) => item === currentRuntimeOnly[index],
        )) ||
      (!currentTimeline && nextRuntimeOnly.length === 0)
    ) {
      return
    }
    this.runtimeTimeline = nextIsEmpty ? null : nextTimeline
    this.runtimeItems.clear()
    this.runtimeMessageFingerprints = nextFingerprints
    // Stream updates can publish many times per frame (one replace per LLM
    // delta). Notifying listeners synchronously interrupts a concurrent React
    // render (useSyncExternalStore's forceStoreRerender counts as a nested
    // update while rendering is suspended), accumulating past the 50-update
    // limit and wedging the chat ("Maximum update depth exceeded"). Frame-
    // coalescing lets each render complete and the nested counter reset.
    this.publishAsync()
  }

  /**
   * Overlay items whose id is now covered by the durable set are dropped:
   * durable messages always render from the durable base, so a stale copy
   * (whether it was written before finalize as runtime-only or after as a
   * durable duplicate) must not resurrect when the durable message leaves the
   * set again (edit truncation, delete). Only live streaming items (id not in
   * the durable set) stay.
   */
  private pruneRuntimeTimeline(): readonly TimelineItemProjection[] | null {
    if (!this.runtimeTimeline) return null
    const next = this.runtimeTimeline.filter(
      (item) => !this.state.messages.has(item.id),
    )
    return next.length === 0 ? null : next
  }

  clearRuntimeMessages(): void {
    if (!this.runtimeTimeline && this.runtimeItems.size === 0) return
    const runtimeOnlyItems = this.runtimeTimeline
      ? this.runtimeTimeline.filter((item) => item.runtimeOnly)
      : [...this.runtimeItems.values()].filter((item) => item.runtimeOnly)
    if (runtimeOnlyItems.length > 0) return
    this.runtimeTimeline = null
    this.runtimeItems.clear()
    this.runtimeMessageFingerprints.clear()
    this.publish()
  }

  setHydrationStatus(
    status: HydrationProjection['status'],
    error?: string,
  ): void {
    this.hydration = { status, ...(error ? { error } : {}) }
    this.publish()
  }

  private buildSnapshot(): ConversationProjection {
    const itemsById = new Map<string, TimelineItemProjection>()
    const hideTimeline = this.hydration.status === HYDRATION_STATUS.HYDRATING
    const timelineIds: string[] = []
    if (!hideTimeline) {
      // The durable timeline is always the base; the runtime overlay only adds
      // runtime-only increments on top (a stale UI sync must never shadow
      // durable messages that arrived after the overlay was written).
      for (const messageId of this.state.messageOrder) {
        const message = this.state.messages.get(messageId)
        if (!message) continue
        const previous = this.snapshot?.itemsById.get(messageId)
        const runtime = this.runtimeItems.get(messageId)
        if (runtime) {
          itemsById.set(messageId, runtime)
        } else if (
          previous?.runtimeOnly !== true &&
          previous?.message === message
        ) {
          itemsById.set(messageId, previous)
        } else {
          itemsById.set(messageId, { id: messageId, kind: 'message', message })
        }
        timelineIds.push(messageId)
      }
      for (const item of this.runtimeTimeline ?? []) {
        if (itemsById.has(item.id)) continue
        itemsById.set(item.id, item)
        timelineIds.push(item.id)
      }
      for (const [messageId, item] of this.runtimeItems) {
        if (itemsById.has(messageId)) continue
        itemsById.set(messageId, item)
        timelineIds.push(messageId)
      }
    }

    const metadata = {
      title: this.state.title,
      ...this.state.metadata,
    }
    return {
      conversationId: this.state.conversationId,
      sequence: this.state.sequence,
      metadata,
      timelineIds,
      itemsById,
      hydration: this.hydration,
    }
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  /** Same as publish(), but notifies listeners on the next frame (coalesced).
   *  Used by the streaming overlay path; see the comment at the call site. */
  private publishAsync(): void {
    this.snapshot = this.buildSnapshot()
    if (this.asyncNotifyScheduled) return
    this.asyncNotifyScheduled = true
    const notify = () => {
      this.asyncNotifyScheduled = false
      for (const listener of this.listeners) listener()
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(notify)
    } else {
      setTimeout(notify, 0)
    }
  }
}
