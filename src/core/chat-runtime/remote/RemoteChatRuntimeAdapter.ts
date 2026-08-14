import {
  type ChatCommandError,
  type ChatCommandResult,
  type ChatRuntime,
  type ChatRuntimeCapabilities,
  type ChatRuntimeEvent,
  ChatRuntimeEventSequencer,
  type ChatRuntimeSnapshot,
  type ChatSessionListResult,
  type ChatSessionRef,
  type ChatSessionSummary,
  type ChatSubmissionHandle,
  ChatSubmissionTracker,
  type ChatTurnInput,
  chatCommandOk,
  chatCommandUnsupported,
} from '../contract'

import {
  CHAT_RUNTIME_ENDPOINTS,
  type WireEventEnvelope,
  decodeChatRuntimeEvent,
} from './remoteProtocol'

export type RemoteTransport = {
  open: (url: string) => {
    addEventListener(
      type: 'message',
      handler: (event: MessageEvent) => void,
    ): void
    addEventListener(type: 'error', handler: (event: Event) => void): void
    removeEventListener(
      type: 'message',
      handler: (event: MessageEvent) => void,
    ): void
    close(): void
  }
  post: (
    path: string,
    body: unknown,
  ) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
  get: (path: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
}

const createDefaultCapabilities = (
  runtimeId: 'yolo' | 'claude-code' | 'codex',
): ChatRuntimeCapabilities => {
  const isCli = runtimeId !== 'yolo'
  return {
    transport: 'remote',
    hostHistory: { supported: true, info: { source: 'gateway' } },
    providerSessions: isCli
      ? { supported: true, info: { scope: 'provider-native' } }
      : {
          supported: false,
          reason: 'native remote has no provider-native sessions',
        },
    agentPlanMode: { supported: true },
    approvalFlow: { supported: true },
    subagents: {
      supported: false,
      reason: 'remote v1: subagent endpoints pending',
    },
    skills: { supported: true },
    modelConfig: { supported: true },
    reasoningEffort: { supported: true },
    compaction: { supported: true },
    contextUsage: { supported: true },
    rewrite: {
      supported: false,
      reason: 'rewrite is handled by the UI transaction layer',
    },
    sessionPin: isCli ? { supported: true } : { supported: false },
    compact: { supported: false },
    mcpSharing: {
      supported: false,
      reason: 'derived from server runtime via capability.changed',
    },
    // 远程 v1：MoA 与命令注册表由服务端 runtime 经 capability.changed 派生。
    moa: {
      supported: false,
      reason: 'derived from server runtime via capability.changed',
    },
    commands: { supported: true, info: { commands: [] } },
    cliSurface: isCli ? { supported: true } : { supported: false },
  }
}

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000

export class RemoteChatRuntimeAdapter implements ChatRuntime {
  readonly runtimeId: 'yolo' | 'claude-code' | 'codex'
  readonly capabilities: ChatRuntimeCapabilities

  private readonly listeners = new Set<(event: ChatRuntimeEvent) => void>()
  private readonly sequencer: ChatRuntimeEventSequencer
  private eventSource: ReturnType<RemoteTransport['open']> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private lastSequence = 0
  private disposed = false
  private readonly submissionTrackers = new Map<string, ChatSubmissionTracker>()
  /** 客户端侧事件聚合快照：SSE 事件流驱动，与其他 adapter 语义一致。 */
  private currentSnapshot: ChatRuntimeSnapshot

  constructor(
    runtimeId: 'yolo' | 'claude-code' | 'codex',
    private readonly transport: RemoteTransport,
    private readonly conversationId: string,
  ) {
    this.runtimeId = runtimeId
    this.capabilities = createDefaultCapabilities(runtimeId)
    this.currentSnapshot = this.buildInitialSnapshot()
    this.sequencer = new ChatRuntimeEventSequencer(
      `remote:${conversationId}`,
      conversationId,
      null,
    )
  }

  subscribe(listener: (event: ChatRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    // A reconnect may already be scheduled (eventSource null while the
    // backoff timer waits) — don't open a second connection.
    if (this.eventSource === null && this.reconnectTimer === null) {
      this.connect()
    }
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): ChatRuntimeSnapshot {
    return this.currentSnapshot
  }

  private buildInitialSnapshot(): ChatRuntimeSnapshot {
    return {
      replayCursor: this.lastSequence,
      runId: `remote:${this.conversationId}`,
      conversationId: this.conversationId,
      sessionRef: null,
      messages: [],
      runState: 'idle',
      error: null,
      compactionBoundaries: [],
      configuration: null,
      capabilities: this.capabilities,
    }
  }

  async sendTurn(input: ChatTurnInput): Promise<ChatSubmissionHandle> {
    const requestId = input.requestId ?? `remote-${Date.now()}`
    const messageId = input.messageId ?? `remote-msg-${Date.now()}`
    const tracker = new ChatSubmissionTracker(requestId, messageId)
    // 绑定 submission 事件：accepted -> durably_accepted；rejected -> rejected。
    this.bindSubmissionTracking(requestId, messageId, tracker)
    await this.transport.post(CHAT_RUNTIME_ENDPOINTS.turn(this.runtimeId), {
      requestId,
      messageId,
      baseRevision: input.baseRevision,
      messageGeneration: input.messageGeneration,
      conversationId: input.conversationId ?? this.conversationId,
      sessionRef: input.sessionRef,
      content: input.content,
      selectedSkills: input.selectedSkills,
    })
    return {
      requestId,
      messageId,
      getState: () => tracker.getState(),
      acceptance: tracker.getAcceptance(),
      cancel: async () => {
        await this.transport.post(
          CHAT_RUNTIME_ENDPOINTS.cancel(this.runtimeId),
          {
            requestId,
            conversationId: this.conversationId,
          },
        )
        return chatCommandOk()
      },
    }
  }

  async cancel(): Promise<ChatCommandResult> {
    await this.transport.post(CHAT_RUNTIME_ENDPOINTS.cancel(this.runtimeId), {
      conversationId: this.conversationId,
    })
    return chatCommandOk()
  }
  async respondApproval(response: {
    requestId: string
    decision: 'approve_once' | 'approve_for_session' | 'reject'
  }): Promise<ChatCommandResult> {
    await this.transport.post(CHAT_RUNTIME_ENDPOINTS.approval(this.runtimeId), {
      ...response,
      conversationId: this.conversationId,
    })
    return chatCommandOk()
  }
  async respondQuestion(response: {
    requestId: string
    answer: unknown
  }): Promise<ChatCommandResult> {
    await this.transport.post(CHAT_RUNTIME_ENDPOINTS.question(this.runtimeId), {
      ...response,
      conversationId: this.conversationId,
    })
    return chatCommandOk()
  }
  async updateConfiguration(update: {
    modelId?: string | null
    reasoningEffort?: string | null
  }): Promise<ChatCommandResult> {
    await this.transport.post(CHAT_RUNTIME_ENDPOINTS.config(this.runtimeId), {
      ...update,
      conversationId: this.conversationId,
    })
    return chatCommandOk()
  }
  async updatePermissionProfile(update: {
    mode: 'ask' | 'agent' | 'plan'
    yoloEnabled: boolean
  }): Promise<ChatCommandResult> {
    await this.transport.post(
      CHAT_RUNTIME_ENDPOINTS.permission(this.runtimeId),
      {
        ...update,
        conversationId: this.conversationId,
      },
    )
    return chatCommandOk()
  }
  async rewriteTurn(): Promise<ChatCommandResult> {
    return chatCommandUnsupported('rewrite')
  }
  async rollbackToTurn(): Promise<ChatCommandResult> {
    return chatCommandUnsupported('rewrite')
  }
  async listSessions(): Promise<ChatSessionListResult> {
    const response = await this.transport.get(
      CHAT_RUNTIME_ENDPOINTS.sessions(this.runtimeId),
    )
    const payload = (await response.json().catch(() => null)) as
      | { ok: true; sessions: readonly ChatSessionSummary[] }
      | { ok: false; error: ChatCommandError }
      | null
    if (payload?.ok === true) {
      return { ok: true, sessions: payload.sessions }
    }
    if (payload?.ok === false) {
      return { ok: false, error: payload.error }
    }
    return { ok: false, error: { kind: 'failed' } }
  }

  private async sessionCommand(
    path: string,
    body: unknown,
  ): Promise<ChatCommandResult> {
    const response = await this.transport.post(path, body)
    const payload = (await response.json().catch(() => null)) as
      | { ok: true }
      | { ok: false; error: ChatCommandError }
      | null
    if (payload?.ok === true) return chatCommandOk()
    if (payload?.ok === false) return payload
    return { ok: false, error: { kind: 'failed' } }
  }

  async openSession(ref: ChatSessionRef): Promise<ChatCommandResult> {
    return this.sessionCommand(
      CHAT_RUNTIME_ENDPOINTS.sessionOpen(this.runtimeId),
      { ref, conversationId: this.conversationId },
    )
  }
  async renameSession(
    ref: ChatSessionRef,
    title: string,
  ): Promise<ChatCommandResult> {
    return this.sessionCommand(
      CHAT_RUNTIME_ENDPOINTS.sessionRename(this.runtimeId),
      { ref, title, conversationId: this.conversationId },
    )
  }
  async deleteSession(ref: ChatSessionRef): Promise<ChatCommandResult> {
    return this.sessionCommand(
      CHAT_RUNTIME_ENDPOINTS.sessionDelete(this.runtimeId),
      { ref, conversationId: this.conversationId },
    )
  }
  async setSessionTitle(
    ref: ChatSessionRef,
    title: string,
  ): Promise<ChatCommandResult> {
    return this.sessionCommand(
      CHAT_RUNTIME_ENDPOINTS.sessionTitle(this.runtimeId),
      { ref, title, conversationId: this.conversationId },
    )
  }
  async setSessionPinned(
    ref: ChatSessionRef,
    pinned: boolean,
  ): Promise<ChatCommandResult> {
    return this.sessionCommand(
      CHAT_RUNTIME_ENDPOINTS.sessionPin(this.runtimeId),
      { ref, pinned, conversationId: this.conversationId },
    )
  }
  async compact() {
    return chatCommandUnsupported('compact')
  }
  async readSubagent() {
    return {
      ok: false as const,
      error: {
        kind: 'unsupported' as const,
        capability: 'subagents' as const,
      },
    }
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
    this.disposed = true
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.eventSource?.close()
    this.eventSource = null
    this.listeners.clear()
  }

  /**
   * Opens the contract SSE stream. Reconnects with exponential backoff
   * (1s → 15s cap) on transport error — EventSource-style auto-reconnect with
   * the fetch-based web transport must not hammer the server in a tight loop.
   */
  private connect(): void {
    if (this.disposed) return
    const url = `${CHAT_RUNTIME_ENDPOINTS.stream(
      this.runtimeId,
    )}?cursor=${this.lastSequence}&conversationId=${encodeURIComponent(
      this.conversationId,
    )}`
    this.eventSource = this.transport.open(url)
    this.eventSource.addEventListener('message', (event) => {
      this.reconnectAttempts = 0
      this.handleWireEvent(JSON.parse(String(event.data)) as WireEventEnvelope)
    })
    this.eventSource.addEventListener('error', () => {
      if (this.disposed) return
      this.eventSource?.close()
      this.eventSource = null
      const delayMs = Math.min(
        RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
        RECONNECT_MAX_MS,
      )
      this.reconnectAttempts += 1
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, delayMs)
    })
  }

  private handleWireEvent(wire: WireEventEnvelope): void {
    const decoded = decodeChatRuntimeEvent(wire)
    if (decoded.sequence <= this.lastSequence) return
    if (decoded.sequence > this.lastSequence + 1) {
      void this.reconnectFromSnapshot()
      return
    }
    this.lastSequence = decoded.sequence
    const event = {
      eventId: decoded.eventId,
      sequence: decoded.sequence,
      runId: decoded.runId,
      conversationId: decoded.conversationId,
      sessionRef: decoded.sessionRef,
      timestamp: decoded.timestamp,
      type: decoded.type,
      payload: decoded.payload,
    } as ChatRuntimeEvent
    if (event.type === 'submission.accepted') {
      const tracker = this.submissionTrackers.get(event.payload.requestId)
      if (tracker) tracker.markDurablyAccepted()
    } else if (event.type === 'submission.rejected') {
      const tracker = this.submissionTrackers.get(event.payload.requestId)
      if (tracker) {
        tracker.markRejected(event.payload.reason, event.payload.retryable)
      }
    }
    this.applyEventToSnapshot(event)
    this.listeners.forEach((listener) => listener(event))
  }

  private applyEventToSnapshot(event: ChatRuntimeEvent): void {
    const current = this.currentSnapshot
    switch (event.type) {
      case 'snapshot':
        this.currentSnapshot = {
          ...event.payload,
          replayCursor: this.lastSequence,
          runId: event.runId,
          capabilities: this.capabilities,
        }
        return
      case 'run.state':
        this.currentSnapshot = {
          ...current,
          runState: event.payload.state,
          // 非粘滞：payload 未带 error 即清空（快照 error 为 string | null，
          // 清空用 null；undefined 不进快照，避免跨 run 残留错误卡）。
          error: event.payload.error ?? null,
        }
        return
      case 'message.upsert': {
        const message = event.payload.message
        const index = current.messages.findIndex(
          (candidate) => candidate.id === message.id,
        )
        const messages =
          index < 0
            ? [...current.messages, message]
            : current.messages.map((candidate, candidateIndex) =>
                candidateIndex === index ? message : candidate,
              )
        this.currentSnapshot = { ...current, messages }
        return
      }
      case 'message.remove':
        this.currentSnapshot = {
          ...current,
          messages: current.messages.filter(
            (message) => message.id !== event.payload.messageId,
          ),
        }
        return
      case 'session.changed':
        this.currentSnapshot = {
          ...current,
          sessionRef: event.payload.sessionRef,
        }
        return
      case 'capability.changed':
        this.currentSnapshot = {
          ...current,
          capabilities: event.payload.capabilities,
        }
        return
      default:
        // submission/compaction/context/metrics 不改变渲染快照。
        return
    }
  }

  private bindSubmissionTracking(
    requestId: string,
    messageId: string,
    tracker: ChatSubmissionTracker,
  ): void {
    this.submissionTrackers.set(requestId, tracker)
  }

  private async reconnectFromSnapshot(): Promise<void> {
    const response = await this.transport.get(
      `${CHAT_RUNTIME_ENDPOINTS.snapshot(
        this.runtimeId,
      )}?conversationId=${encodeURIComponent(this.conversationId)}`,
    )
    if (!response.ok) return
    const body = (await response.json()) as {
      snapshot: ChatRuntimeSnapshot
      cursor: number
    }
    this.lastSequence = body.cursor
    const event = this.sequencer.next('snapshot', body.snapshot)
    this.listeners.forEach((listener) => listener(event))
  }
}
