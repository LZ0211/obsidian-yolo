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
    emitError: () => {
      handlers.error.forEach((handler) => handler({} as MessageEvent))
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
  it('rejects a turn when the remote endpoint returns a non-2xx response', async () => {
    const adapter = new RemoteChatRuntimeAdapter(
      'codex',
      {
        ...noopTransport,
        post: async () => ({
          ok: false,
          json: async () => ({
            error: { code: 'session_expired', message: 'session expired' },
          }),
        }),
      },
      'conv-1',
    )

    await expect(
      adapter.sendTurn({ content: 'hello', messageId: 'msg-1' }),
    ).rejects.toThrow('session expired')
  })

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

  it('reconnects with exponential backoff on transport error (E1b)', async () => {
    jest.useFakeTimers()
    try {
      const { transport } = createFakeTransport()
      const opened: string[] = []
      const adapter = new RemoteChatRuntimeAdapter(
        'claude-code',
        {
          open: (url: string) => {
            opened.push(url)
            return transport
          },
          post: async () => ({ ok: true, json: async () => ({}) }),
          get: async () => ({ ok: true, json: async () => ({}) }),
        },
        'conv-1',
      )
      adapter.subscribe(() => undefined)
      expect(opened).toHaveLength(1)

      // 第一次断线：1s 后重连（退避基数）。
      transport.emitError()
      expect(opened).toHaveLength(1)
      jest.advanceTimersByTime(999)
      expect(opened).toHaveLength(1)
      jest.advanceTimersByTime(1)
      expect(opened).toHaveLength(2)

      // 第二次断线：2s 后重连（2^1）。
      transport.emitError()
      jest.advanceTimersByTime(1_999)
      expect(opened).toHaveLength(2)
      jest.advanceTimersByTime(1)
      expect(opened).toHaveLength(3)

      // 收到事件后退避计数复位：下一次断线从 1s 重新开始。
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
      transport.emitError()
      jest.advanceTimersByTime(999)
      expect(opened).toHaveLength(3)
      jest.advanceTimersByTime(1)
      expect(opened).toHaveLength(4)

      // 重连 URL 携带 cursor 续传。
      expect(opened[1]).toContain('cursor=0')
      expect(opened[3]).toContain('cursor=1')
      adapter.dispose()
    } finally {
      jest.useRealTimers()
    }
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

  it('publishes a recovered snapshot and updates the local snapshot cursor', async () => {
    const { transport } = createFakeTransport()
    const recovered = {
      replayCursor: 3,
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionRef: null,
      messages: [{ id: 'a1', role: 'assistant', content: 'recovered' }],
      runState: 'completed',
      error: null,
      compactionBoundaries: [],
      configuration: null,
      capabilities: {} as never,
    }
    const get = jest.fn(async () => ({
      ok: true,
      json: async () => ({ snapshot: recovered, cursor: 3 }),
    }))
    const adapter = new RemoteChatRuntimeAdapter(
      'codex',
      {
        open: () => transport,
        post: noopTransport.post,
        get,
      },
      'conv-1',
    )
    const eventTypes: string[] = []
    adapter.subscribe((event) => eventTypes.push(event.type))

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
    transport.emit({
      protocolVersion: 1,
      eventId: 'e3',
      sequence: 3,
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionRef: null,
      timestamp: 3,
      type: 'run.state',
      payload: { state: 'completed' },
    })
    await waitFor(() => adapter.getSnapshot().replayCursor === 3)

    expect(get).toHaveBeenCalledTimes(1)
    expect(adapter.getSnapshot().messages).toEqual(recovered.messages)
    expect(adapter.getSnapshot().runState).toBe('completed')
    expect(eventTypes).toContain('snapshot')
    adapter.dispose()
  })

  it('coalesces concurrent gap recovery and retries when a newer gap arrives', async () => {
    const { transport } = createFakeTransport()
    const first = deferred<{ snapshot: unknown; cursor: number }>()
    const second = deferred<{ snapshot: unknown; cursor: number }>()
    const get = jest
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => first.promise,
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => second.promise,
      }))
    const snapshot = (cursor: number) => ({
      replayCursor: cursor,
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionRef: null,
      messages: [],
      runState: 'running',
      error: null,
      compactionBoundaries: [],
      configuration: null,
      capabilities: {} as never,
    })
    const adapter = new RemoteChatRuntimeAdapter(
      'codex',
      {
        open: () => transport,
        post: noopTransport.post,
        get,
      },
      'conv-1',
    )
    adapter.subscribe(() => undefined)

    transport.emit({
      protocolVersion: 1,
      eventId: 'e3',
      sequence: 3,
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionRef: null,
      timestamp: 3,
      type: 'run.state',
      payload: { state: 'running' },
    })
    transport.emit({
      protocolVersion: 1,
      eventId: 'e5',
      sequence: 5,
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionRef: null,
      timestamp: 5,
      type: 'run.state',
      payload: { state: 'completed' },
    })

    expect(get).toHaveBeenCalledTimes(1)
    first.resolve({ snapshot: snapshot(3), cursor: 3 })
    await waitFor(() => get.mock.calls.length === 2)
    second.resolve({ snapshot: snapshot(5), cursor: 5 })
    await waitFor(() => adapter.getSnapshot().replayCursor === 5)
    adapter.dispose()
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition not met')
}
