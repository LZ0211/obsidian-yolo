import type { ChatRuntimeRunFailure } from '../contract'

import { RemoteChatRuntimeAdapter } from './RemoteChatRuntimeAdapter'

type Handler = (event: MessageEvent) => void

function createFakeTransport() {
  const handlers: Record<string, Handler[]> = { message: [], error: [] }
  const calls: string[] = []
  const transport = {
    onmessage: null as Handler | null,
    onerror: null as Handler | null,
    addEventListener: (type: string, handler: Handler) => {
      handlers[type]?.push(handler)
      calls.push(`listen:${type}`)
    },
    removeEventListener: (type: string, handler: Handler) => {
      handlers[type] = handlers[type]?.filter((item) => item !== handler) ?? []
    },
    close: () => calls.push('close'),
    emit: (data: unknown) => {
      handlers.message.forEach((handler) =>
        handler({ data: JSON.stringify(data) } as MessageEvent),
      )
    },
  }
  return { transport, calls }
}

const noopTransport = {
  open: () => createFakeTransport().transport,
  post: async () => ({ ok: true, json: async () => ({}) }),
  get: async () => ({ ok: true, json: async () => ({}) }),
}

describe('RemoteChatRuntimeAdapter', () => {
  it('emits a snapshot as the first event after connect', () => {
    const { transport, calls } = createFakeTransport()
    const adapter = new RemoteChatRuntimeAdapter(
      'claude-code',
      {
        open: () => transport,
        post: async () => ({ ok: true, json: async () => ({}) }),
        get: async () => ({ ok: true, json: async () => ({}) }),
      },
      'conv-1',
    )
    const seen: string[] = []
    adapter.subscribe((event) => seen.push(event.type))
    expect(calls).toContain('listen:message')
    adapter.dispose()
  })

  it('forwards snapshot and run.state payloads into contract events', () => {
    const { transport } = createFakeTransport()
    const adapter = new RemoteChatRuntimeAdapter(
      'claude-code',
      {
        open: () => transport,
        post: async () => ({ ok: true, json: async () => ({}) }),
        get: async () => ({ ok: true, json: async () => ({}) }),
      },
      'conv-1',
    )
    const runStates: string[] = []
    adapter.subscribe((event) => {
      if (event.type === 'run.state') runStates.push(event.payload.state)
    })
    transport.emit({
      protocolVersion: 1,
      eventId: 'e1',
      sequence: 1,
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionRef: null,
      timestamp: 1,
      type: 'run.state',
      payload: { state: 'running' },
    })
    expect(runStates).toEqual(['running'])
    adapter.dispose()
  })

  it('clears a sticky snapshot error when run.state completes without error', () => {
    const { transport } = createFakeTransport()
    const adapter = new RemoteChatRuntimeAdapter(
      'claude-code',
      {
        open: () => transport,
        post: async () => ({ ok: true, json: async () => ({}) }),
        get: async () => ({ ok: true, json: async () => ({}) }),
      },
      'conv-1',
    )
    const failureEvents: ChatRuntimeRunFailure[] = []
    adapter.subscribe((event) => {
      if (event.type === 'run.state' && event.payload.failure) {
        failureEvents.push(event.payload.failure)
      }
    })

    transport.emit({
      protocolVersion: 1,
      eventId: 'e1',
      sequence: 1,
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionRef: null,
      timestamp: 1,
      type: 'run.state',
      payload: {
        state: 'error',
        error: 'process exited unexpectedly',
        failure: { reason: 'process-exited', recoverable: true },
      },
    })
    expect(adapter.getSnapshot().runState).toBe('error')
    expect(adapter.getSnapshot().error).toBe('process exited unexpectedly')
    // failure 随事件透传（结构化失效载荷，UI 据此区分死因）。
    expect(failureEvents).toEqual([
      { reason: 'process-exited', recoverable: true },
    ])

    transport.emit({
      protocolVersion: 1,
      eventId: 'e2',
      sequence: 2,
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionRef: null,
      timestamp: 2,
      type: 'run.state',
      payload: { state: 'completed' },
    })
    expect(adapter.getSnapshot().runState).toBe('completed')
    // 非粘滞：completed 未带 error 载荷即清空，不得残留上一个 run 的错误。
    expect(adapter.getSnapshot().error).toBeNull()
    adapter.dispose()
  })

  it('declares providerSessions and sessionPin supported', () => {
    const adapter = new RemoteChatRuntimeAdapter(
      'codex',
      noopTransport,
      'conv-1',
    )
    expect(adapter.capabilities.providerSessions).toEqual({
      supported: true,
      info: { scope: 'provider-native' },
    })
    expect(adapter.capabilities.sessionPin).toEqual({ supported: true })
  })

  it('lists sessions through the sessions endpoint', async () => {
    const sessions = [
      {
        ref: { runtimeId: 'codex', nativeSessionId: 's1' },
        title: 'Session one',
        updatedAt: 10,
      },
    ]
    const adapter = new RemoteChatRuntimeAdapter(
      'codex',
      {
        ...noopTransport,
        get: async () => ({
          ok: true,
          json: async () => ({ ok: true, sessions }),
        }),
      },
      'conv-1',
    )
    const result = await adapter.listSessions()
    expect(result).toEqual({ ok: true, sessions })
  })

  it('routes open/rename/title/delete/pin to their endpoints and returns ok', async () => {
    const posts: Array<{ path: string; body: unknown }> = []
    const adapter = new RemoteChatRuntimeAdapter(
      'codex',
      {
        ...noopTransport,
        post: async (path: string, body: unknown) => {
          posts.push({ path, body })
          return { ok: true, json: async () => ({ ok: true }) }
        },
      },
      'conv-1',
    )
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 's1' }
    expect(await adapter.openSession(ref)).toEqual({ ok: true })
    expect(await adapter.renameSession(ref, 'New')).toEqual({ ok: true })
    expect(await adapter.setSessionTitle(ref, 'Title')).toEqual({ ok: true })
    expect(await adapter.deleteSession(ref)).toEqual({ ok: true })
    expect(await adapter.setSessionPinned(ref, true)).toEqual({ ok: true })
    expect(posts.map((call) => call.path)).toEqual([
      '/api/chat-runtime/codex/sessions/open',
      '/api/chat-runtime/codex/sessions/rename',
      '/api/chat-runtime/codex/sessions/title',
      '/api/chat-runtime/codex/sessions/delete',
      '/api/chat-runtime/codex/sessions/pin',
    ])
    expect(posts[0].body).toMatchObject({ ref, conversationId: 'conv-1' })
    expect(posts[4].body).toMatchObject({ ref, pinned: true })
  })

  it('surfaces an ok:false session command response', async () => {
    const adapter = new RemoteChatRuntimeAdapter(
      'codex',
      {
        ...noopTransport,
        post: async () => ({
          ok: true,
          json: async () => ({
            ok: false,
            error: { kind: 'rejected', reason: 'not found', retryable: false },
          }),
        }),
      },
      'conv-1',
    )
    const result = await adapter.deleteSession({
      runtimeId: 'codex',
      nativeSessionId: 'missing',
    })
    expect(result).toEqual({
      ok: false,
      error: { kind: 'rejected', reason: 'not found', retryable: false },
    })
  })
})
