import {
  type ChatCapabilityState,
  type ChatRuntime,
  type ChatRuntimeCapabilities,
  type ChatRuntimeEvent,
  type ChatRuntimeEventEnvelope,
  type ChatRuntimeEventMap,
  ChatRuntimeEventSequencer,
  type ChatRuntimeSnapshot,
  ChatSubmissionTracker,
  type ChatTurnInput,
  chatCommandOk,
  chatCommandUnsupported,
  isChatCapabilitySupported,
  isChatRuntimeEventStale,
} from './contract'

describe('capability discriminant', () => {
  it('detects supported and unsupported capability states', () => {
    const supported: ChatCapabilityState = {
      supported: true,
      info: { source: 'gateway' },
    }
    const unsupported: ChatCapabilityState = {
      supported: false,
      reason: 'desktop only',
    }
    expect(isChatCapabilitySupported(supported)).toBe(true)
    expect(isChatCapabilitySupported(unsupported)).toBe(false)
  })
})

describe('command results', () => {
  it('returns ok for success', () => {
    expect(chatCommandOk()).toEqual({ ok: true })
  })

  it('returns a discriminated unsupported result with capability id', () => {
    const result = chatCommandUnsupported(
      'approvalFlow',
      'CLI bridge is a stub',
    )
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'unsupported',
        capability: 'approvalFlow',
        reason: 'CLI bridge is a stub',
      },
    })
  })
})

describe('ChatSubmissionTracker', () => {
  const now = (): number => 1000

  it('starts received and transitions to durably_accepted', () => {
    const tracker = new ChatSubmissionTracker('req-1', 'msg-1', now)
    expect(tracker.getState()).toEqual({ status: 'received', receivedAt: 1000 })
    tracker.markDurablyAccepted({ baseRevision: 7 })
    expect(tracker.getState()).toEqual({
      status: 'durably_accepted',
      acceptedAt: 1000,
      baseRevision: 7,
    })
  })

  it('rejects from received with reason and retryable flag', () => {
    const tracker = new ChatSubmissionTracker('req-2', 'msg-2', now)
    tracker.markRejected('gateway unavailable', true)
    expect(tracker.getState()).toEqual({
      status: 'rejected',
      rejectedAt: 1000,
      reason: 'gateway unavailable',
      retryable: true,
    })
  })

  it('cancel succeeds only while received and is idempotent', () => {
    const tracker = new ChatSubmissionTracker('req-3', 'msg-3', now)
    expect(tracker.cancel()).toEqual({ ok: true })
    expect(tracker.cancel()).toEqual({
      ok: false,
      error: { kind: 'cancelled' },
    })
    expect(tracker.getState()).toEqual({
      status: 'rejected',
      rejectedAt: 1000,
      reason: 'cancelled',
      retryable: false,
    })
  })

  it('cannot transition after durably_accepted', () => {
    const tracker = new ChatSubmissionTracker('req-4', 'msg-4', now)
    tracker.markDurablyAccepted()
    tracker.markRejected('late', false)
    expect(tracker.getState().status).toBe('durably_accepted')
  })

  it('resolves the acceptance promise on terminal transition', async () => {
    const tracker = new ChatSubmissionTracker('req-5', 'msg-5', now)
    const acceptance = tracker.getAcceptance()
    tracker.markDurablyAccepted()
    await expect(acceptance).resolves.toEqual({
      status: 'durably_accepted',
      acceptedAt: 1000,
    })
  })
})

const identity = {
  runId: 'run-1',
  conversationId: 'conv-1',
}

function event(overrides: Partial<ChatRuntimeEvent> = {}): ChatRuntimeEvent {
  return {
    eventId: 'e1',
    sequence: 1,
    runId: 'run-1',
    conversationId: 'conv-1',
    sessionRef: { runtimeId: 'claude-code' as const, nativeSessionId: 's1' },
    timestamp: 1000,
    type: 'run.state',
    payload: { state: 'running' },
    ...overrides,
  } as ChatRuntimeEvent
}

describe('ChatRuntimeEventSequencer', () => {
  it('increments sequence and carries identity', () => {
    const sequencer = new ChatRuntimeEventSequencer('run-1', 'conv-1', {
      runtimeId: 'claude-code' as const,
      nativeSessionId: 's1',
    })
    const first = sequencer.next('run.state', { state: 'running' })
    const second = sequencer.next('run.state', { state: 'completed' })
    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(second.runId).toBe('run-1')
    expect(second.conversationId).toBe('conv-1')
    expect(first.eventId).not.toBe(second.eventId)
    expect(first.type).toBe('run.state')
    expect(first.payload).toEqual({ state: 'running' })
  })

  it('keeps sequence monotonic across runs (beginRun does not reset cursor)', () => {
    const sequencer = new ChatRuntimeEventSequencer('run-1', 'conv-1', null)
    sequencer.next('run.state', { state: 'running' })
    sequencer.beginRun('run-2')
    const afterRun = sequencer.next('run.state', { state: 'completed' })
    expect(afterRun.sequence).toBe(2)
    expect(afterRun.runId).toBe('run-2')
  })
})

describe('isChatRuntimeEventStale', () => {
  it('keeps events matching the current identity', () => {
    expect(isChatRuntimeEventStale(event(), identity)).toBe(false)
  })

  it('drops events from an older run', () => {
    expect(isChatRuntimeEventStale(event({ runId: 'run-0' }), identity)).toBe(
      true,
    )
  })

  it('drops events from another conversation', () => {
    expect(
      isChatRuntimeEventStale(event({ conversationId: 'conv-2' }), identity),
    ).toBe(true)
  })

  it('treats provider session binding as mutable metadata, not identity', () => {
    expect(
      isChatRuntimeEventStale(
        event({
          sessionRef: { runtimeId: 'codex' as const, nativeSessionId: 'x' },
        }),
        identity,
      ),
    ).toBe(false)
  })
})

const unsupportedCapabilities: ChatRuntimeCapabilities = {
  transport: 'remote',
  hostHistory: { supported: true, info: { source: 'gateway' } },
  providerSessions: { supported: false, reason: 'remote bridge pending' },
  agentPlanMode: { supported: false },
  approvalFlow: { supported: false },
  subagents: { supported: false },
  skills: { supported: false },
  modelConfig: { supported: false },
  reasoningEffort: { supported: false },
  compaction: { supported: false },
  contextUsage: { supported: false },
  rewrite: { supported: false },
  sessionPin: { supported: false },
  compact: { supported: false },
  mcpSharing: { supported: false },
  moa: { supported: false },
  commands: { supported: false },
  cliSurface: { supported: false },
}

function createFakeRuntime(): ChatRuntime {
  const snapshot: ChatRuntimeSnapshot = {
    replayCursor: 0,
    runId: 'r',
    conversationId: null,
    sessionRef: null,
    messages: [],
    runState: 'idle',
    error: null,
    compactionBoundaries: [],
    configuration: null,
    capabilities: unsupportedCapabilities,
  }
  return {
    runtimeId: 'claude-code',
    capabilities: unsupportedCapabilities,
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    sendTurn: async () => ({
      requestId: 'req-1',
      messageId: 'msg-1',
      getState: () => ({ status: 'received', receivedAt: 0 }),
      acceptance: Promise.resolve({
        status: 'durably_accepted',
        acceptedAt: 1,
      }),
      cancel: async () => chatCommandUnsupported('approvalFlow'),
    }),
    rewriteTurn: async () => chatCommandUnsupported('rewrite'),
    rollbackToTurn: async () => chatCommandUnsupported('rewrite'),
    cancel: async () => chatCommandUnsupported('approvalFlow'),
    respondApproval: async () => chatCommandUnsupported('approvalFlow'),
    respondQuestion: async () => chatCommandUnsupported('approvalFlow'),
    updateConfiguration: async () => chatCommandUnsupported('modelConfig'),
    updatePermissionProfile: async () =>
      chatCommandUnsupported('agentPlanMode'),
    setSessionPinned: async () => chatCommandUnsupported('sessionPin'),
    compact: async () => chatCommandUnsupported('compact'),
    listSessions: async () => ({
      ok: false,
      error: { kind: 'unsupported', capability: 'providerSessions' },
    }),
    openSession: async () => chatCommandUnsupported('providerSessions'),
    renameSession: async () => chatCommandUnsupported('providerSessions'),
    deleteSession: async () => chatCommandUnsupported('providerSessions'),
    setSessionTitle: async () => chatCommandUnsupported('providerSessions'),
    readSubagent: async () => ({
      ok: false,
      error: { kind: 'unsupported', capability: 'subagents' },
    }),
    watchSubagent: async () => ({
      ok: false,
      error: { kind: 'unsupported', capability: 'subagents' },
    }),
    dispose: async () => undefined,
  }
}

describe('ChatRuntime interface', () => {
  it('lets a fake runtime satisfy the contract and answer unsupported', async () => {
    const runtime = createFakeRuntime()
    expect(
      await runtime.respondApproval({ requestId: 'r', decision: 'reject' }),
    ).toEqual(chatCommandUnsupported('approvalFlow'))
    expect(runtime.getSnapshot().capabilities.providerSessions.supported).toBe(
      false,
    )
  })

  it('keeps snapshot identity consistent with stale-event rules', () => {
    const snapshot = createFakeRuntime().getSnapshot()
    const envelope = {
      eventId: 'e',
      sequence: 1,
      runId: 'r',
      conversationId: null,
      sessionRef: null,
      timestamp: 0,
      type: 'message.upsert' as const,
      payload: { message: {} as never },
    }
    expect(
      isChatRuntimeEventStale(envelope, {
        runId: 'r',
        conversationId: snapshot.conversationId,
      }),
    ).toBe(false)
  })

  it('carries moa and slash-command registry capabilities', () => {
    const runtime = createFakeRuntime()
    expect(runtime.capabilities.moa.supported).toBe(false)
    expect(runtime.capabilities.commands.supported).toBe(false)
  })
})

// 规范事件集：satisfies 保证编译期与 ChatRuntimeEventMap 键完全一致；
// 新增事件（含 fork 能力扩展）必须显式更新此字面量与下方 toEqual 列表。
// payload 占位符用 `null as never`（never 可赋值给任何类型）——`{}` 无法
// 满足带必填字段的 payload（如 run.state 要求 state），pre-flight 修正。
const canonicalEventMap = {
  snapshot: null as never,
  'message.upsert': null as never,
  'message.remove': null as never,
  'run.state': null as never,
  'tool.request': null as never,
  'submission.accepted': null as never,
  'submission.rejected': null as never,
  'context.usage': null as never,
  'turn.metrics': null as never,
  'compaction.state': null as never,
  'compaction.boundary': null as never,
  'capability.changed': null as never,
  'session.changed': null as never,
  'subagent.transcript': null as never,
} satisfies ChatRuntimeEventMap

// 规范能力集（18 键，盲审核实自 contract.ts:50-78）。
// 与契约其它能力键不同，transport 是 ChatTransport 字面量（'local' | 'remote'），
// 不是 ChatCapabilityState，故占位用合法字面量 'local' 而非 { supported: false }。
const canonicalCapabilities = {
  transport: 'local',
  hostHistory: { supported: false },
  providerSessions: { supported: false },
  agentPlanMode: { supported: false },
  approvalFlow: { supported: false },
  subagents: { supported: false },
  skills: { supported: false },
  modelConfig: { supported: false },
  reasoningEffort: { supported: false },
  compaction: { supported: false },
  contextUsage: { supported: false },
  rewrite: { supported: false },
  sessionPin: { supported: false },
  compact: { supported: false },
  mcpSharing: { supported: false },
  moa: { supported: false },
  commands: { supported: false },
  cliSurface: { supported: false },
} satisfies ChatRuntimeCapabilities

const canonicalEnvelope = {
  eventId: '',
  sequence: 0,
  runId: '',
  conversationId: null,
  sessionRef: null,
  timestamp: 0,
} satisfies ChatRuntimeEventEnvelope

const canonicalSnapshot = {
  replayCursor: 0,
  runId: '',
  conversationId: null,
  sessionRef: null,
  messages: [],
  runState: 'idle',
  error: null,
  compactionBoundaries: [],
  configuration: null,
  capabilities: canonicalCapabilities,
} satisfies ChatRuntimeSnapshot

// 规范 ChatTurnInput 键集（P1 豁免白名单字段，Task 4）：与 canonicalEventMap
// 等守卫不同，ChatTurnInput 的键集在 Task 1 刻意不守卫（豁免白名单），本
// 任务开始以 satisfies 字面量固化 mode/continuation 扩展。moa 占位用
// `null as never`（MoAInvocation 有必填字段）。reasoningLevel 为 final
// review 显式评审通过的 P1 白名单扩展（Task 13）。
const canonicalTurnInput = {
  requestId: '',
  messageId: '',
  baseRevision: 0,
  messageGeneration: 0,
  conversationId: null,
  sessionRef: null,
  content: '',
  mentionables: [],
  assistantId: '',
  selectedSkills: [],
  mode: 'ask',
  reasoningLevel: 'auto',
  continuation: {
    requestMessages: [],
    branchId: '',
    sourceUserMessageId: '',
    assistantMessageId: '',
    branchLabel: '',
    modelId: '',
    compaction: [],
    moa: null as never,
    reasoningLevel: 'auto',
  },
} satisfies ChatTurnInput

describe('contract shape guard', () => {
  it('freezes the envelope and snapshot shapes', () => {
    expect(Object.keys(canonicalEnvelope).sort()).toEqual([
      'conversationId',
      'eventId',
      'runId',
      'sequence',
      'sessionRef',
      'timestamp',
    ])
    expect(Object.keys(canonicalSnapshot).sort()).toEqual([
      'capabilities',
      'compactionBoundaries',
      'configuration',
      'conversationId',
      'error',
      'messages',
      'replayCursor',
      'runId',
      'runState',
      'sessionRef',
    ])
  })

  it('freezes the event map to the 14 canonical events', () => {
    expect(Object.keys(canonicalEventMap).sort()).toEqual([
      'capability.changed',
      'compaction.boundary',
      'compaction.state',
      'context.usage',
      'message.remove',
      'message.upsert',
      'run.state',
      'session.changed',
      'snapshot',
      'subagent.transcript',
      'submission.accepted',
      'submission.rejected',
      'tool.request',
      'turn.metrics',
    ])
  })

  it('freezes the capabilities to the 18 canonical keys', () => {
    expect(Object.keys(canonicalCapabilities).sort()).toEqual([
      'agentPlanMode',
      'approvalFlow',
      'cliSurface',
      'commands',
      'compact',
      'compaction',
      'contextUsage',
      'hostHistory',
      'mcpSharing',
      'moa',
      'modelConfig',
      'providerSessions',
      'reasoningEffort',
      'rewrite',
      'sessionPin',
      'skills',
      'subagents',
      'transport',
    ])
  })

  it('freezes the turn input to the 13 canonical keys (P1 whitelist, Task 4 + Task 13 reasoningLevel)', () => {
    expect(Object.keys(canonicalTurnInput).sort()).toEqual([
      'assistantId',
      'baseRevision',
      'content',
      'continuation',
      'conversationId',
      'mentionables',
      'messageGeneration',
      'messageId',
      'mode',
      'reasoningLevel',
      'requestId',
      'selectedSkills',
      'sessionRef',
    ])
  })

  it('freezes the continuation block to the 9 canonical keys (Task 13 reasoningLevel)', () => {
    expect(Object.keys(canonicalTurnInput.continuation).sort()).toEqual([
      'assistantMessageId',
      'branchId',
      'branchLabel',
      'compaction',
      'moa',
      'modelId',
      'reasoningLevel',
      'requestMessages',
      'sourceUserMessageId',
    ])
  })
})
