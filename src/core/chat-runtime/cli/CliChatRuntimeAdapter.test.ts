import { CliChatRuntimeAdapter } from './CliChatRuntimeAdapter'
import type {
  CliBackend,
  CliBackendEvent,
  CliBackendSnapshot,
} from './CliRuntimeBackend'

export function createFakeCliBackend(initial?: CliBackendSnapshot) {
  const events: CliBackendEvent[] = []
  const listeners = new Set<(event: CliBackendEvent) => void>()
  let snapshot: CliBackendSnapshot = initial ?? {
    surfaceId: 'surface-1',
    conversationEpoch: 0,
    messages: [],
    sessionRef: null,
    runState: 'idle',
    error: null,
    configuration: null,
  }
  const backend: CliBackend = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    sendTurn: async () => undefined,
    rewriteTurn: async () => undefined,
    rollbackToTurn: async () => undefined,
    cancel: async () => undefined,
    respondApproval: async () => undefined,
    respondQuestion: async () => undefined,
    updateConfiguration: async () => undefined,
    updatePermissionProfile: async () => undefined,
    listSessions: async () => [],
    openSession: async () => undefined,
    renameSession: async () => undefined,
    deleteSession: async () => undefined,
    setSessionTitle: async () => undefined,
    setSessionPinned: async () => undefined,
    compact: async () => undefined,
    readSubagent: async () => [],
    dispose: async () => undefined,
  }
  const emit = (event: CliBackendEvent) => {
    events.push(event)
    listeners.forEach((listener) => listener(event))
  }
  return {
    backend,
    events,
    emit,
    setSnapshot: (next: CliBackendSnapshot) => (snapshot = next),
  }
}

describe('CliRuntimeBackend port', () => {
  it('satisfies the port shape and fans out events', () => {
    const { backend, emit } = createFakeCliBackend()
    const seen: string[] = []
    backend.subscribe((event) => seen.push(event.type))
    emit({ type: 'run_state', state: 'running' })
    expect(seen).toEqual(['run_state'])
  })
})

describe('CliChatRuntimeAdapter', () => {
  it('keeps the surface runtimeId stable regardless of session binding', () => {
    const { backend, setSnapshot } = createFakeCliBackend()
    // 未绑定会话（snapshot.sessionRef === null）时，构造传入的 runtimeId
    // 仍是权威——此前从快照派生会错误回落为 claude-code。
    const adapter = new CliChatRuntimeAdapter(backend, 'codex')
    expect(adapter.runtimeId).toBe('codex')
    setSnapshot({
      surfaceId: 'surface-1',
      conversationEpoch: 0,
      messages: [],
      sessionRef: { runtimeId: 'codex', nativeSessionId: 's1' },
      runState: 'idle',
      error: null,
      configuration: null,
    })
    expect(adapter.runtimeId).toBe('codex')
  })

  it('maps backend session pin state into contract summaries', async () => {
    const { backend } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(
      {
        ...backend,
        listSessions: async () => [
          {
            ref: { runtimeId: 'codex' as const, nativeSessionId: 's1' },
            title: 'Fix login',
            updatedAt: 5,
            isPinned: true,
          },
        ],
      },
      'codex',
    )
    const result = await adapter.listSessions()
    expect(result).toEqual({
      ok: true,
      sessions: [
        {
          ref: { runtimeId: 'codex', nativeSessionId: 's1' },
          title: 'Fix login',
          updatedAt: 5,
          isPinned: true,
        },
      ],
    })
  })

  it('emits snapshot before incremental events on subscribe', () => {
    const { backend } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(backend)
    const seen: string[] = []
    adapter.subscribe((event) => seen.push(event.type))
    expect(seen[0]).toBe('snapshot')
    adapter.dispose()
  })

  it('translates cli events into contract events with stable identity', () => {
    const { backend, emit } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(backend)
    const runStates: string[] = []
    adapter.subscribe((event) => {
      if (event.type === 'run.state') runStates.push(event.payload.state)
    })
    emit({ type: 'run_state', state: 'waiting_for_approval' })
    emit({ type: 'run_state', state: 'running' })
    expect(runStates).toEqual(['waiting_for_approval', 'running'])
    adapter.dispose()
  })

  it('maps cli session binding into session.changed events', () => {
    const { backend, emit } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(backend)
    const sessions: Array<{
      runtimeId: string
      nativeSessionId: string
    } | null> = []
    adapter.subscribe((event) => {
      if (event.type === 'session.changed') {
        sessions.push(event.payload.sessionRef)
      }
    })
    emit({
      type: 'session_bound',
      ref: { runtimeId: 'claude-code', nativeSessionId: 's1' },
    })
    expect(sessions).toEqual([
      { runtimeId: 'claude-code', nativeSessionId: 's1' },
    ])
    adapter.dispose()
  })
})

describe('cli adapter contract behavior', () => {
  it('advertises providerSessions and hostHistory capabilities', () => {
    const { backend } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(backend)
    expect(adapter.capabilities.providerSessions.supported).toBe(true)
    expect(adapter.capabilities.hostHistory.supported).toBe(true)
    adapter.dispose()
  })

  it('derives provider-specific defaults when capabilities are omitted', () => {
    const { backend: codexBackend } = createFakeCliBackend()
    const codex = new CliChatRuntimeAdapter(codexBackend, 'codex')
    expect(codex.capabilities.compact.supported).toBe(false)

    const { backend: claudeBackend } = createFakeCliBackend()
    const claude = new CliChatRuntimeAdapter(claudeBackend, 'claude-code')
    expect(claude.capabilities.compact.supported).toBe(true)

    codex.dispose()
    claude.dispose()
  })

  it('snapshot surfaces the backend messages and run state', () => {
    const message = { role: 'assistant', id: 'a1', content: 'hi' }
    const { backend, setSnapshot } = createFakeCliBackend()
    setSnapshot({
      surfaceId: 'surface-1',
      conversationEpoch: 0,
      messages: [message as never],
      sessionRef: null,
      runState: 'running',
      error: null,
      configuration: null,
    })
    const adapter = new CliChatRuntimeAdapter(backend)
    expect(adapter.getSnapshot().runState).toBe('running')
    expect(adapter.getSnapshot().messages).toEqual([message])
    adapter.dispose()
  })
})

describe('cli accepted-draft semantics', () => {
  it('emits submission.accepted when the optimistic message is reconciled', () => {
    const { backend, emit } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(backend)
    const types: string[] = []
    adapter.subscribe((event) => {
      if (event.type.startsWith('submission.')) types.push(event.type)
    })
    // sendTurn 后 controller 快照对账：乐观 ID -> 原生 ID
    void adapter.sendTurn({ content: 'hello', messageId: 'msg-1' })
    emit({
      type: 'submission.accepted',
      optimisticMessageId: 'msg-1',
      nativeMessageId: 'native-1',
    })
    expect(types).toEqual(['submission.accepted'])
    adapter.dispose()
  })

  it('rejects concurrent sendTurn with a busy error', async () => {
    const { backend } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(backend)
    await adapter.sendTurn({ content: 'one', messageId: 'm1' })
    await expect(
      adapter.sendTurn({ content: 'two', messageId: 'm2' }),
    ).rejects.toMatchObject({
      kind: 'busy',
    })
    adapter.dispose()
  })

  it('rejects continuation inputs explicitly (provider-native retry/continue)', async () => {
    const { backend } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(backend)
    await expect(
      adapter.sendTurn({
        content: 'retry',
        continuation: { sourceUserMessageId: 'user-1' },
      }),
    ).rejects.toThrow('CLI runtime does not support continuation inputs')
    adapter.dispose()
  })

  it('ignores the contract mode (CLI holds its own via updatePermissionProfile)', async () => {
    const { backend } = createFakeCliBackend()
    const adapter = new CliChatRuntimeAdapter(backend)
    // mode 提交不抛错、不进入 backend 请求（backend.sendTurn 无 mode 形参）。
    await expect(
      adapter.sendTurn({ content: 'hi', mode: 'agent' }),
    ).resolves.toBeDefined()
    adapter.dispose()
  })
})
