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

/**
 * 流式响应的 fetch mock：对 `/stream` URL 返回一个可喂 SSE 帧的 body，
 * 替代旧 EventSource 全局 mock（transport 已改为 fetch 承载 SSE）。
 */
function createFetchMock() {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const feeds: Array<{
    url: string
    feed: (frame: string) => void
    closeStream: () => void
  }> = []
  const fetch = jest.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/stream')) {
        let controller: ReadableStreamDefaultController<Uint8Array> | null =
          null
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController
          },
        })
        const encoder = new TextEncoder()
        feeds.push({
          url: String(url),
          feed: (frame: string) => {
            controller?.enqueue(encoder.encode(frame))
          },
          closeStream: () => controller?.close(),
        })
        return { ok: true, body } as unknown as Response
      }
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
  return { fetch, calls, feeds }
}

const flushMicrotasks = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createWebCliRuntimeScope（契约 adapter 背书，Phase B Step 4）', () => {

  it('rejects session hydration when the remote open command fails', async () => {
    const { fetch } = createFetchMock()
    const originalFetch = fetch.getMockImplementation()
    fetch.mockImplementation(async (url, init) => {
      if (String(url).includes('/sessions/open')) {
        return jsonResponse({
          ok: false,
          error: { kind: 'failed', message: 'provider session missing' },
        })
      }
      if (!originalFetch) throw new Error('missing fetch mock')
      return originalFetch(url, init)
    })
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const controller = scope.selectConversationRuntime('codex')

    await expect(
      controller.hydrateSession({
        runtimeId: 'codex',
        nativeSessionId: 'missing-thread',
      }),
    ).rejects.toThrow('provider session missing')
    await scope.dispose()
  })

  it('returns the provider snapshot after a successful remote open command', async () => {
    const { fetch } = createFetchMock()
    const originalFetch = fetch.getMockImplementation()
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    const message = {
      role: 'assistant' as const,
      id: 'assistant-1',
      content: 'loaded from provider',
    }
    fetch.mockImplementation(async (url, init) => {
      if (String(url).includes('/sessions/open')) {
        return jsonResponse({ ok: true })
      }
      if (String(url).includes('/snapshot')) {
        return jsonResponse({
          snapshot: {
            replayCursor: 2,
            runId: 'remote:conversation-1',
            conversationId: 'conversation-1',
            sessionRef: ref,
            messages: [message],
            runState: 'idle',
            error: null,
            compactionBoundaries: [],
            configuration: null,
            capabilities: {},
          },
          cursor: 2,
        })
      }
      if (!originalFetch) throw new Error('missing fetch mock')
      return originalFetch(url, init)
    })
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const controller = scope.selectConversationRuntime('codex')

    await expect(controller.hydrateSession(ref)).resolves.toMatchObject({
      ref,
      messages: [message],
    })
    await scope.dispose()
  })

  it('rejects immediately when the authoritative open snapshot has no session', async () => {
    const { fetch } = createFetchMock()
    const originalFetch = fetch.getMockImplementation()
    fetch.mockImplementation(async (url, init) => {
      if (String(url).includes('/snapshot')) {
        return jsonResponse({
          snapshot: {
            replayCursor: 0,
            runId: 'remote:conversation-1',
            conversationId: 'conversation-1',
            sessionRef: null,
            messages: [],
            runState: 'idle',
            error: null,
            compactionBoundaries: [],
            configuration: null,
            capabilities: {},
          },
          cursor: 0,
        })
      }
      if (!originalFetch) throw new Error('missing fetch mock')
      return originalFetch(url, init)
    })
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const controller = scope.selectConversationRuntime('codex')
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }

    const result = await Promise.race([
      controller.hydrateSession(ref).then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('still pending'), 0)
      }),
    ])

    expect(result).toBe('CLI session open did not produce an active session.')
    await scope.dispose()
  })

  it('discovers sessions via the chat-runtime protocol and maps pin state', async () => {
    const { fetch, calls } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
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

  it('reports per-runtime HTTP and transport failures during discovery', async () => {
    const fetch = jest.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes('/stream')) {
          return {
            ok: true,
            body: new ReadableStream<Uint8Array>(),
          } as unknown as Response
        }
        if (String(url).includes('/claude-code/sessions')) {
          throw new Error('network down')
        }
        if (String(url).includes('/codex/sessions')) {
          return jsonResponse({
            ok: false,
            error: { kind: 'failed', message: 'host rejected discovery' },
          })
        }
        return jsonResponse({ ok: true })
      },
    )
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const sessionService =
      scope.sessionService as unknown as WebScopeSessionService

    const discovery = await sessionService.discoverSessions()

    expect(discovery.sessions).toEqual([])
    expect(discovery.errors).toEqual({
      'claude-code': 'network down',
      codex: 'host rejected discovery',
    })
  })

  it('forwards pin/rename/delete to the session endpoints', async () => {
    const { fetch, calls } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
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
    const { fetch, feeds } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const controller = scope.selectConversationRuntime('codex')
    expect(controller.getSnapshot().runtimeId).toBe('codex')

    const source = feeds[0]
    expect(source.url).toContain('/api/chat-runtime/codex/stream')
    expect(source.url).toContain('conversationId=')
    source.feed(
      `data: ${JSON.stringify({
        protocolVersion: 1,
        eventId: 'e1',
        sequence: 1,
        runId: 'run-1',
        conversationId: '',
        sessionRef: null,
        timestamp: 1,
        type: 'run.state',
        payload: { state: 'running' },
      })}\n\n`,
    )

    await flushMicrotasks()
    expect(controller.getSnapshot().runState).toBe('running')
  })

  it('forwards approval/question/permission and rejects unsupported commands (E5)', async () => {
    const { fetch, calls } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const controller = scope.selectConversationRuntime(
      'codex',
    ) as unknown as {
      respondApproval: (response: unknown) => Promise<void>
      respondQuestion: (response: unknown) => Promise<void>
      updatePermissionProfile: (update: unknown) => Promise<void>
      rewriteTurn: () => Promise<void>
      rollbackToTurn: () => Promise<void>
      compact: () => Promise<void>
      listSkills: () => Promise<unknown[]>
    }

    await controller.respondApproval({
      requestId: 'req-1',
      decision: 'approve_once',
    })
    await controller.respondQuestion({ requestId: 'req-2', answer: 'yes' })
    await controller.updatePermissionProfile({ mode: 'agent', yoloEnabled: true })

    expect(calls.map((call) => call.url)).toEqual(
      expect.arrayContaining([
        'http://localhost/api/chat-runtime/codex/approval',
        'http://localhost/api/chat-runtime/codex/question',
        'http://localhost/api/chat-runtime/codex/permission',
      ]),
    )

    // Mutating commands without a remote endpoint fail explicitly. Optional
    // discovery returns an empty result so automatic loading stays quiet.
    await expect(controller.rewriteTurn()).rejects.toThrow(/unsupported/)
    await expect(controller.rollbackToTurn()).rejects.toThrow(/unsupported/)
    await expect(controller.compact()).rejects.toThrow(/unsupported/)
    await expect(controller.listSkills()).resolves.toEqual([])
  })

  it('uses default no-op semantics for unavailable MCP status and reload operations', async () => {
    const { fetch } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const controller = scope.selectConversationRuntime('codex')

    expect(controller.stageConfiguration({ modelId: 'gpt-test' })).toBeUndefined()
    const staged = controller.stageTurn({
      id: 'message-a',
      role: 'user',
      content: null,
      promptContent: null,
      mentionables: [],
    })
    expect(controller.getSnapshot().messages).toHaveLength(1)
    controller.rejectStagedTurn(staged, new Error('rejected'))
    expect(controller.getSnapshot()).toMatchObject({
      runState: 'error',
      error: 'rejected',
    })

    await expect(controller.mcpServerStatus()).resolves.toEqual([])
    await expect(controller.reloadPlugins()).resolves.toBeUndefined()
    await expect(controller.toggleMcpServer('github', false)).rejects.toThrow(
      /does not support/,
    )
    await expect(controller.reconnectMcpServer('github')).rejects.toThrow(
      /does not support/,
    )
  })

  it('getChatRuntime returns a ChatRuntime wired to the same transport', async () => {
    const { fetch, calls } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
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

  it('rebinds the CLI controller transport when the presented conversation changes', async () => {
    const { fetch, calls } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const controller = scope.selectConversationRuntime('codex')

    controller.bindConversation('conversation-a')
    await controller.sendTurn({
      userMessage: {
        id: 'message-a',
        role: 'user',
        content: null,
        promptContent: null,
        mentionables: [],
      },
      content: 'first',
    })
    controller.bindConversation('conversation-b')
    await controller.sendTurn({
      userMessage: {
        id: 'message-b',
        role: 'user',
        content: null,
        promptContent: null,
        mentionables: [],
      },
      content: 'second',
    })

    const turnCalls = calls.filter((call) => call.url.endsWith('/codex/turn'))
    expect(turnCalls).toHaveLength(2)
    expect(JSON.parse(String(turnCalls[0].init?.body))).toMatchObject({
      conversationId: 'conversation-a',
    })
    expect(JSON.parse(String(turnCalls[1].init?.body))).toMatchObject({
      conversationId: 'conversation-b',
    })
  })

  it('keeps a newly created conversation controller selected and disposes the replaced controller', async () => {
    const { fetch, feeds } = createFetchMock()
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: fetch,
      sessionId: 'session-1',
    })
    const previous = scope.selectConversationRuntime('codex')

    const created = scope.createConversationRuntime('codex')

    expect(created).not.toBe(previous)
    expect(scope.selectConversationRuntime('codex')).toBe(created)

    feeds[0].feed(
      `data: ${JSON.stringify({
        protocolVersion: 1,
        eventId: 'replacement-event',
        sequence: 1,
        runId: 'run-1',
        conversationId: '',
        sessionRef: null,
        timestamp: 1,
        type: 'run.state',
        payload: { state: 'running' },
      })}\n\n`,
    )
    await flushMicrotasks()

    expect(created.getSnapshot().runState).toBe('running')
    expect(previous.getSnapshot().runState).toBe('idle')
    await scope.dispose()
  })

  it('probes CLI availability from the host via /api/cli/availability', async () => {
    const availabilityFetch = jest.fn(async () =>
      jsonResponse({ 'claude-code': true, codex: false }),
    )
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: availabilityFetch,
      sessionId: 'session-1',
    })
    const availability = await scope.probeAvailability?.()
    expect(availability).toEqual({ 'claude-code': true, codex: false })
    expect(availabilityFetch).toHaveBeenCalledWith(
      'http://localhost/api/cli/availability',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-yolo-web-session-id': 'session-1' }),
      }),
    )
  })

  it('probeAvailability falls back to unavailable when the host request fails', async () => {
    const availabilityFetch = jest.fn(async () => jsonResponse({}, false))
    const scope = createWebCliRuntimeScope({
      baseUrl: 'http://localhost',
      fetchImpl: availabilityFetch,
      sessionId: null,
    })
    const availability = await scope.probeAvailability?.()
    expect(availability).toEqual({ 'claude-code': false, codex: false })
  })
})
