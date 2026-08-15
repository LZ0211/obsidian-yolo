import type { CliRuntimeId } from '../../cli-runtime/types'
import {
  type ChatCommandResult,
  type ChatRewriteTurnInput,
  type ChatRuntime,
  type ChatRuntimeCapabilities,
  type ChatRuntimeEvent,
  ChatRuntimeEventSequencer,
  type ChatRuntimeSnapshot,
  type ChatSubmissionHandle,
  ChatSubmissionTracker,
  type ChatTurnInput,
  chatCommandOk,
  chatCommandUnsupported,
  isChatCapabilitySupported,
} from '../contract'

import type {
  CliBackend,
  CliBackendEvent,
  CliBackendSessionRef,
} from './CliRuntimeBackend'

function sessionRefToContract(
  ref: CliBackendSessionRef | null,
): ChatRuntimeSnapshot['sessionRef'] {
  if (ref === null) return null
  return {
    runtimeId: ref.runtimeId,
    nativeSessionId: ref.nativeSessionId,
    sessionPathHint: ref.sessionPathHint,
  }
}

function eventToContract(event: CliBackendEvent): ChatRuntimeEvent['type'] {
  switch (event.type) {
    case 'session_bound':
      return 'session.changed'
    case 'message_upsert':
      return 'message.upsert'
    case 'message_remove':
      return 'message.remove'
    case 'run_state':
      return 'run.state'
    case 'context_usage':
      return 'context.usage'
    case 'turn_metrics':
      return 'turn.metrics'
    case 'compaction_state':
      return 'compaction.state'
    case 'compaction_boundary':
      return 'compaction.boundary'
    case 'submission.accepted':
      return 'submission.accepted'
    case 'submission.rejected':
      return 'submission.rejected'
  }
}

export function deriveCliCapabilities(
  runtimeId: CliRuntimeId,
): ChatRuntimeCapabilities {
  return {
    transport: 'local',
    hostHistory: { supported: true, info: { source: 'gateway' } },
    providerSessions: { supported: true, info: { scope: 'provider-native' } },
    agentPlanMode: { supported: true },
    approvalFlow: { supported: true },
    subagents: { supported: true },
    skills: { supported: true },
    modelConfig: { supported: true },
    reasoningEffort: { supported: true },
    compaction: { supported: true },
    contextUsage: { supported: true },
    rewrite: { supported: true },
    sessionPin: { supported: true },
    compact: {
      supported: runtimeId === 'claude-code',
      reason:
        runtimeId === 'claude-code'
          ? undefined
          : 'CLI runtime does not expose compaction in this version',
    },
    mcpSharing: {
      supported: false,
      reason: 'no shared MCP servers configured',
    },
    moa: {
      supported: false,
      reason:
        'MoA aggregation is native-only in v1; CLI runs its own prompt commands',
    },
    commands: { supported: true, info: { commands: [] } },
    cliSurface: { supported: true },
  }
}

export class CliChatRuntimeAdapter implements ChatRuntime {
  readonly runtimeId: CliRuntimeId
  readonly capabilities: ChatRuntimeCapabilities

  private readonly listeners = new Set<(event: ChatRuntimeEvent) => void>()
  private sequencer: ChatRuntimeEventSequencer
  private unsubscribeBackend: () => void
  private sessionRef: CliBackendSessionRef | null
  private lastEpoch: number
  /** adapter 内部接管 coordinator 语义：并发守卫 + 当前提交状态机。 */
  private pending: {
    token: number
    requestId: string
    messageId: string
    tracker: ChatSubmissionTracker
  } | null = null
  private nextToken = 1

  constructor(
    private readonly backend: CliBackend,
    /**
     * 该表面的运行时身份：组装层按用户选择创建（createCliChatRuntime 传入）。
     * 不随已绑定会话变化——sessionRef.runtimeId 属于会话绑定，与表面身份
     * 是两回事（此前从后端快照派生，未绑定时会错误回落为 claude-code）。
     */
    runtimeId: CliRuntimeId = 'claude-code',
    capabilities?: ChatRuntimeCapabilities,
  ) {
    const snapshot = backend.getSnapshot()
    this.runtimeId = runtimeId
    this.capabilities = capabilities ?? deriveCliCapabilities(runtimeId)
    this.sessionRef = snapshot.sessionRef
    this.lastEpoch = snapshot.conversationEpoch
    this.sequencer = this.createSequencer(snapshot.conversationEpoch)
    this.unsubscribeBackend = backend.subscribe((event) => {
      if (event.type === 'session_bound') {
        this.sessionRef = event.ref
        this.emitSessionChanged(event.ref)
        return
      }
      if (event.type === 'submission.accepted') {
        this.handleAccepted(event)
        return
      }
      if (event.type === 'submission.rejected') {
        this.handleRejected(event)
        return
      }
      this.emitContractEvent(event)
    })
  }

  subscribe(listener: (event: ChatRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    listener(this.sequencer.next('snapshot', this.buildSnapshot()))
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): ChatRuntimeSnapshot {
    return this.buildSnapshot()
  }

  async sendTurn(input: ChatTurnInput): Promise<ChatSubmissionHandle> {
    // CLI 是 provider 原生会话面：retry/continue 由 CLI 自身状态机/命令负责，
    // 契约 continuation 显式拒绝（fail-fast，不静默丢弃）。
    if (input.continuation) {
      throw new Error('CLI runtime does not support continuation inputs')
    }
    // mode 忽略：CLI 经 updatePermissionProfile 持自身交互模式，不消费提交级 mode。
    const requestId = input.requestId ?? `cli-${Date.now()}`
    const messageId = input.messageId ?? `cli-msg-${Date.now()}`
    if (this.pending) {
      const error = new Error('CLI runtime is busy') as Error & {
        kind: 'busy'
      }
      error.kind = 'busy'
      throw error
    }
    const tracker = new ChatSubmissionTracker(requestId, messageId)
    this.pending = { token: this.nextToken++, requestId, messageId, tracker }
    const token = this.pending.token
    try {
      await this.backend.sendTurn({
        sessionRef: this.sessionRef,
        userMessageId: messageId,
        content: typeof input.content === 'string' ? input.content : '',
        ...(input.mentionables ? { mentionables: input.mentionables } : {}),
        ...(input.assistantId ? { assistantId: input.assistantId } : {}),
        selectedSkills: input.selectedSkills?.map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: skill.path,
        })),
      })
    } catch (error) {
      // 发送失败必须解除 busy 锁并通知拒绝，否则该会话的 CLI 面永久 busy
      // （pending 仅靠 submission.accepted 清空，emitSnapshotDiff 不发 rejected）。
      const message = error instanceof Error ? error.message : String(error)
      if (this.pending?.token === token) {
        this.pending = null
        tracker.markRejected(message, false)
        this.emitSubmissionRejected(tracker, message, false)
      }
      throw error
    }
    return {
      requestId,
      messageId,
      getState: () => tracker.getState(),
      acceptance: tracker.getAcceptance(),
      cancel: async () => {
        if (this.pending?.token === token) {
          tracker.markRejected('cancelled', false)
          this.emitSubmissionRejected(tracker, 'cancelled', false)
        } else {
          await this.backend.cancel()
        }
        return chatCommandOk()
      },
    }
  }

  async rewriteTurn(input: ChatRewriteTurnInput): Promise<ChatCommandResult> {
    await this.backend.rewriteTurn({
      sessionRef: this.sessionRef,
      sourceUserMessageId: input.sourceUserMessageId,
      content: typeof input.content === 'string' ? input.content : '',
    })
    return chatCommandOk()
  }
  async rollbackToTurn(
    sourceUserMessageId: string,
  ): Promise<ChatCommandResult> {
    await this.backend.rollbackToTurn(sourceUserMessageId)
    return chatCommandOk()
  }
  async cancel(): Promise<ChatCommandResult> {
    await this.backend.cancel()
    return chatCommandOk()
  }
  async respondApproval(response: {
    requestId: string
    decision: 'approve_once' | 'approve_for_session' | 'reject'
  }): Promise<ChatCommandResult> {
    await this.backend.respondApproval(response)
    return chatCommandOk()
  }
  async respondQuestion(response: {
    requestId: string
    answer: unknown
  }): Promise<ChatCommandResult> {
    await this.backend.respondQuestion(response)
    return chatCommandOk()
  }
  async updateConfiguration(update: {
    modelId?: string | null
    reasoningEffort?: string | null
  }): Promise<ChatCommandResult> {
    if (!isChatCapabilitySupported(this.capabilities.modelConfig)) {
      return chatCommandUnsupported('modelConfig')
    }
    await this.backend.updateConfiguration(update)
    return chatCommandOk()
  }
  async updatePermissionProfile(update: {
    mode: 'ask' | 'agent' | 'plan'
    yoloEnabled: boolean
  }): Promise<ChatCommandResult> {
    if (!isChatCapabilitySupported(this.capabilities.agentPlanMode)) {
      return chatCommandUnsupported('agentPlanMode')
    }
    await this.backend.updatePermissionProfile(update)
    return chatCommandOk()
  }
  async setSessionPinned(
    ref: CliBackendSessionRef,
    pinned: boolean,
  ): Promise<ChatCommandResult> {
    if (!isChatCapabilitySupported(this.capabilities.sessionPin)) {
      return chatCommandUnsupported('sessionPin')
    }
    await this.backend.setSessionPinned(ref, pinned)
    return chatCommandOk()
  }
  async compact(): Promise<ChatCommandResult> {
    if (!isChatCapabilitySupported(this.capabilities.compact)) {
      return chatCommandUnsupported('compact')
    }
    await this.backend.compact()
    return chatCommandOk()
  }
  async listSessions() {
    const sessions = await this.backend.listSessions()
    return {
      ok: true as const,
      sessions: sessions.map((session) => ({
        ref: sessionRefToContract(session.ref)!,
        title: session.title,
        preview: session.preview,
        updatedAt: session.updatedAt,
        isPinned: session.isPinned,
      })),
    }
  }
  async openSession(ref: CliBackendSessionRef) {
    await this.backend.openSession(ref)
    return chatCommandOk()
  }
  async renameSession(ref: CliBackendSessionRef, title: string) {
    await this.backend.renameSession(ref, title)
    return chatCommandOk()
  }
  async deleteSession(ref: CliBackendSessionRef) {
    await this.backend.deleteSession(ref)
    return chatCommandOk()
  }
  async setSessionTitle(ref: CliBackendSessionRef, title: string) {
    await this.backend.setSessionTitle(ref, title)
    return chatCommandOk()
  }
  async readSubagent(ref: {
    parentSessionRef: unknown
    toolCallId: string
    subagentId: string
  }) {
    const messages = await this.backend.readSubagent(ref as never)
    return { ok: true as const, messages }
  }
  async watchSubagent() {
    return {
      ok: false as const,
      error: {
        kind: 'unsupported' as const,
        capability: 'subagents' as const,
      },
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribeBackend()
    this.listeners.clear()
    await this.backend.dispose()
  }

  private buildSnapshot(): ChatRuntimeSnapshot {
    const snapshot = this.backend.getSnapshot()
    return {
      replayCursor: this.sequencer.getCursor(),
      runId: this.sequencer.runId,
      conversationId: snapshot.surfaceId,
      sessionRef: sessionRefToContract(this.sessionRef ?? snapshot.sessionRef),
      messages: [...snapshot.messages],
      runState: snapshot.runState,
      error: snapshot.error,
      compactionBoundaries: [],
      configuration:
        snapshot.configuration as ChatRuntimeSnapshot['configuration'],
      capabilities: this.capabilities,
    }
  }

  private createSequencer(epoch: number): ChatRuntimeEventSequencer {
    const snapshot = this.backend.getSnapshot()
    return new ChatRuntimeEventSequencer(
      `cli:${snapshot.surfaceId}:${epoch}`,
      snapshot.surfaceId,
      sessionRefToContract(this.sessionRef ?? snapshot.sessionRef),
    )
  }

  private emitContractEvent(event: CliBackendEvent): void {
    const snapshot = this.backend.getSnapshot()
    if (snapshot.conversationEpoch !== this.lastEpoch) {
      this.lastEpoch = snapshot.conversationEpoch
      // sequence 全局单调递增：beginRun 只换 runId，不重建 sequencer。
      this.sequencer.beginRun(
        `cli:${snapshot.surfaceId}:${snapshot.conversationEpoch}`,
        sessionRefToContract(this.sessionRef),
      )
    }
    const type = eventToContract(event)
    const contractEvent = this.sequencer.next(type, eventToPayload(event))
    this.listeners.forEach((listener) => listener(contractEvent))
  }

  private emitSessionChanged(ref: CliBackendSessionRef): void {
    const event = this.sequencer.next('session.changed', {
      sessionRef: sessionRefToContract(ref),
    })
    this.listeners.forEach((listener) => listener(event))
  }

  private handleAccepted(
    event: Extract<CliBackendEvent, { type: 'submission.accepted' }>,
  ): void {
    if (!this.pending || this.pending.messageId !== event.optimisticMessageId) {
      return
    }
    this.pending.tracker.markDurablyAccepted({
      ...(event.baseRevision !== undefined
        ? { baseRevision: event.baseRevision }
        : {}),
    })
    const contractEvent = this.sequencer.next('submission.accepted', {
      requestId: this.pending.requestId,
      messageId: event.nativeMessageId,
      ...(event.baseRevision !== undefined
        ? { baseRevision: event.baseRevision }
        : {}),
    })
    this.listeners.forEach((listener) => listener(contractEvent))
    this.pending = null
  }

  private handleRejected(
    event: Extract<CliBackendEvent, { type: 'submission.rejected' }>,
  ): void {
    if (!this.pending || this.pending.messageId !== event.messageId) return
    this.pending.tracker.markRejected(event.reason, event.retryable)
    this.emitSubmissionRejected(
      this.pending.tracker,
      event.reason,
      event.retryable,
    )
    this.pending = null
  }

  private emitSubmissionRejected(
    tracker: ChatSubmissionTracker,
    reason: string,
    retryable: boolean,
  ): void {
    const event = this.sequencer.next('submission.rejected', {
      requestId: tracker.requestId,
      messageId: tracker.messageId,
      reason,
      retryable,
    })
    this.listeners.forEach((listener) => listener(event))
  }
}

function eventToPayload(event: CliBackendEvent): ChatRuntimeEvent['payload'] {
  switch (event.type) {
    case 'message_upsert':
      return { message: event.message }
    case 'message_remove':
      return { messageId: event.messageId }
    case 'run_state':
      return {
        state: event.state,
        ...(event.error ? { error: event.error } : {}),
        ...(event.failure ? { failure: event.failure } : {}),
      }
    case 'context_usage':
      return event.usage as ChatRuntimeEvent['payload']
    case 'turn_metrics':
      return { usage: event.usage, durationMs: event.durationMs }
    case 'compaction_state':
      return { isCompacting: event.isCompacting }
    case 'compaction_boundary':
      return { boundary: event.boundary }
    case 'submission.accepted':
    case 'submission.rejected':
      // 提交事件在 subscribe 回调中被 handleAccepted/handleRejected 拦截，
      // 不会走到这里；保留 case 仅为类型穷尽（字段名不一致的旧转换已删除）。
      throw new Error(
        'unreachable: submission events are handled in the adapter',
      )
    case 'session_bound':
      return { sessionRef: null }
  }
}
