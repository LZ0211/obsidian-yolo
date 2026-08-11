/* eslint-disable @typescript-eslint/no-base-to-string -- fetch mock 用 String(url) 断言请求地址字符串化 */
import type { CliSessionRef } from '../../core/cli-runtime/types'

import { createWebCliRuntimeScope } from './WebCliRuntimeScope'

/**
 * master 的 CliSessionService 是类且无 discoverSessions/setPinned/renameSession
 * （backup 的接口有）；web scope 的 sessionService 对象实际提供这些成员，
 * 测试经局部接口收窄。
 */
type WebScopeSessionService = {
  discoverSessions(): Promise<{
    sessions: Array<{
      ref: CliSessionRef
      title: string
      updatedAt: number
      isPinned: boolean
      hasOverlay: boolean
    }>
    errors: Record<string, unknown>
  }>
  setPinned(ref: CliSessionRef, pinned: boolean): Promise<void>
  renameSession(ref: CliSessionRef, title: string): Promise<void>
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response
}

function createFetchMock() {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch = jest.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/sessions') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          ok: true,
          sessions: [
            {
              ref: { runtimeId: 'codex', nativeSessionId: 'thread-1' },
              title: 'Fix login',
              updatedAt: 5,
              isPinned: true,
            },
          ],
        })
      }
      if (String(url).includes('/sessions/pin')) {
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ ok: true })
    },
  )
  return { fetch, calls }
}

function installEventSourceMock() {
  const instances: Array<{
    url: string
    listeners: Record<string, Array<(event: MessageEvent) => void>>
    close: jest.Mock
  }> = []
  class FakeEventSource {
    listeners: Record<string, Array<(event: MessageEvent) => void>> = {}
    close = jest.fn()
    constructor(public readonly url: string) {
      instances.push(this)
    }
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      ;(this.listeners[type] ??= []).push(listener)
    }
    emit(type: string, data: unknown) {
      for (const listener of this.listeners[type] ?? []) {
        listener({ data: JSON.stringify(data) } as MessageEvent)
      }
    }
  }
  const original = globalThis.EventSource
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  return {
    instances: instances as Array<{
      url: string
      listeners: Record<string, Array<(event: MessageEvent) => void>>
      close: jest.Mock
      emit(type: string, data: unknown): void
    }>,
    restore: () => {
      globalThis.EventSource = original
    },
  }
}

describe('createWebCliRuntimeScope（契约 adapter 背书，Phase B Step 4）', () => {
  let eventSource: ReturnType<typeof installEventSourceMock>

  beforeEach(() => {
    eventSource = installEventSourceMock()
  })

  afterEach(() => {
    eventSource.restore()
    jest.restoreAllMocks()
  })

  it('discovers sessions via the chat-runtime protocol and maps pin state', async () => {
    const { fetch, calls } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
      EventSourceImpl: undefined,
    })
    const sessionService = scope.sessionService as unknown as WebScopeSessionService

    const discovery = await sessionService.discoverSessions()

    expect(
      calls.some(
        (call) =>
          call.url === 'http://localhost/api/chat-runtime/codex/sessions' &&
          (call.init?.method ?? 'GET') === 'GET',
      ),
    ).toBe(true)
    expect(discovery.sessions[0]).toMatchObject({
      ref: { runtimeId: 'codex', nativeSessionId: 'thread-1' },
      title: 'Fix login',
      isPinned: true,
      hasOverlay: false,
    })
  })

  it('forwards pin/rename/delete to the session endpoints', async () => {
    const { fetch, calls } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
      EventSourceImpl: undefined,
    })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    const sessionService = scope.sessionService as unknown as WebScopeSessionService

    await sessionService.setPinned(ref, true)
    await sessionService.renameSession(ref, 'New')
    await scope.sessionService.removeOverlay(ref)

    expect(calls.map((call) => call.url)).toEqual(
      expect.arrayContaining([
        'http://localhost/api/chat-runtime/codex/sessions/pin',
        'http://localhost/api/chat-runtime/codex/sessions/rename',
        'http://localhost/api/chat-runtime/codex/sessions/delete',
      ]),
    )
    const pinCall = calls.find((call) =>
      call.url.includes('/sessions/pin'),
    )
    expect(pinCall?.init?.headers).toMatchObject({
      'x-yolo-web-session-id': 'session-1',
    })
  })

  it('selects a conversation runtime whose snapshot follows adapter SSE events', async () => {
    const { fetch } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
      EventSourceImpl: undefined,
    })
    const controller = scope.selectConversationRuntime('codex')
    expect(controller.getSnapshot().runtimeId).toBe('codex')

    const source = eventSource.instances[0]
    expect(source.url).toContain('/api/chat-runtime/codex/stream')
    source.emit('message', {
      protocolVersion: 1,
      eventId: 'e1',
      sequence: 1,
      runId: 'run-1',
      conversationId: '',
      sessionRef: null,
      timestamp: 1,
      type: 'run.state',
      payload: { state: 'running' },
    })

    expect(controller.getSnapshot().runState).toBe('running')
  })

  it('getChatRuntime returns a ChatRuntime wired to the same transport', async () => {
    const { fetch, calls } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
      EventSourceImpl: undefined,
    })
    const runtime = scope.getChatRuntime('codex')
    await runtime.sendTurn({
      content: 'hello',
      messageId: 'm1',
      baseRevision: 0,
      messageGeneration: 0,
    })
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'http://localhost/api/chat-runtime/codex/turn',
        }),
      ]),
    )
  })
})
