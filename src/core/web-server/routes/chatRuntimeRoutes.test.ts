/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type {
  ChatCommandResult,
  ChatRuntime,
  ChatSessionRef,
} from '../../chat-runtime/contract'
import { WebRouter } from '../WebRouter'

import {
  closeChatRuntimeSessionStreams,
  disposeChatRuntimeRouteCaches,
  invalidateChatRuntimeConversation,
  registerChatRuntimeRoutes,
} from './chatRuntimeRoutes'

function createRequest({
  method,
  url,
  body,
  headers,
}: {
  method: string
  url: string
  body?: unknown
  headers?: Record<string, string>
}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const stream = Readable.from(chunks) as Readable & {
    method?: string
    url?: string
    headers: Record<string, string>
  }
  stream.method = method
  stream.url = url
  stream.headers = headers ?? {}
  return stream
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    setHeader: (name: string, value: string) => void
    end: (chunk?: string) => void
    write: (chunk: string) => void
    jsonBody: unknown
    rawBody: string
  }
  response.statusCode = 200
  response.setHeader = () => {}
  response.write = (chunk) => {
    rawBody += chunk
  }
  response.end = (chunk) => {
    if (chunk) rawBody += chunk
  }
  Object.defineProperty(response, 'jsonBody', {
    get() {
      return rawBody ? (JSON.parse(rawBody) as unknown) : null
    },
  })
  Object.defineProperty(response, 'rawBody', {
    get() {
      return rawBody
    },
  })
  return response
}

async function dispatch(
  router: WebRouter,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const resolved = router.resolve(method, url)
  if (!resolved) throw new Error(`missing route: ${method} ${url}`)
  const req = createRequest({ method, url, body, headers })
  const res = createResponse()
  await resolved.handler(req as never, res as never, resolved.params)
  return res
}

const ref: ChatSessionRef = { runtimeId: 'codex', nativeSessionId: 'thread-1' }

function makeRuntime(
  overrides: Partial<ChatRuntime> = {},
): ChatRuntime & { getSessionCalls: () => string[] } {
  const sessionCalls: string[] = []
  const base = {
    runtimeId: 'codex',
    capabilities: {
      providerSessions: { supported: true, info: { scope: 'provider-native' } },
    },
    listSessions: async () => ({
      ok: true as const,
      sessions: [{ ref, title: 'Fix login', updatedAt: 5 }],
    }),
    openSession: async (
      sessionRef: ChatSessionRef,
    ): Promise<ChatCommandResult> => {
      sessionCalls.push(`open:${sessionRef.nativeSessionId}`)
      return { ok: true }
    },
    renameSession: async (
      sessionRef: ChatSessionRef,
      title: string,
    ): Promise<ChatCommandResult> => {
      sessionCalls.push(`rename:${sessionRef.nativeSessionId}:${title}`)
      return { ok: true }
    },
    setSessionTitle: async (
      sessionRef: ChatSessionRef,
      title: string,
    ): Promise<ChatCommandResult> => {
      sessionCalls.push(`title:${sessionRef.nativeSessionId}:${title}`)
      return { ok: true }
    },
    deleteSession: async (
      sessionRef: ChatSessionRef,
    ): Promise<ChatCommandResult> => {
      sessionCalls.push(`delete:${sessionRef.nativeSessionId}`)
      return { ok: true }
    },
    setSessionPinned: async (
      sessionRef: ChatSessionRef,
      pinned: boolean,
    ): Promise<ChatCommandResult> => {
      sessionCalls.push(`pin:${sessionRef.nativeSessionId}:${pinned}`)
      return { ok: true }
    },
    ...overrides,
  }
  return {
    ...base,
    getSessionCalls: () => sessionCalls,
  } as unknown as ChatRuntime & { getSessionCalls: () => string[] }
}

function createRouter(runtime: ChatRuntime): WebRouter {
  const router = new WebRouter()
  registerChatRuntimeRoutes(router, {
    getChatRuntime: () => runtime,
  })
  return router
}

describe('chatRuntimeRoutes session endpoints', () => {
  it('closes a runtime stream when its web session is revoked', async () => {
    const unsubscribe = jest.fn()
    const subscribe = jest.fn(() => unsubscribe)
    const runtime = makeRuntime({
      subscribe,
      getSnapshot: () => ({
        replayCursor: 0,
        runId: 'run-1',
        conversationId: 'conv-stream',
        sessionRef: null,
        messages: [],
        runState: 'idle',
        error: null,
        compactionBoundaries: [],
        configuration: null,
        capabilities: {} as never,
      }),
    })
    const router = createRouter(runtime)
    const resolved = router.resolve(
      'GET',
      '/api/chat-runtime/codex/stream?conversationId=conv-stream',
    )
    if (!resolved) throw new Error('missing stream route')
    const req = createRequest({
      method: 'GET',
      url: '/api/chat-runtime/codex/stream?conversationId=conv-stream',
      headers: { 'x-yolo-web-session-id': 'session-1' },
    })
    const res = createResponse()

    await resolved.handler(req as never, res as never, {
      runtimeId: 'codex',
    })
    closeChatRuntimeSessionStreams('session-1', 'token_revoked')

    expect(res.rawBody).toContain('event: session_closed')
    expect(res.rawBody).toContain('token_revoked')
    expect(subscribe).toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalled()
    await disposeChatRuntimeRouteCaches()
  })

  it('lists sessions', async () => {
    const runtime = makeRuntime()
    const res = await dispatch(
      createRouter(runtime),
      'GET',
      '/api/chat-runtime/codex/sessions?conversationId=conv-list',
    )
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toMatchObject({
      ok: true,
      sessions: [{ ref, title: 'Fix login' }],
    })
  })

  it('open/rename/title/delete/pin forward to the runtime', async () => {
    const runtime = makeRuntime()
    const router = createRouter(runtime)
    await dispatch(router, 'POST', '/api/chat-runtime/codex/sessions/open', {
      ref,
      conversationId: 'conv-ops',
    })
    await dispatch(router, 'POST', '/api/chat-runtime/codex/sessions/rename', {
      ref,
      title: 'New title',
      conversationId: 'conv-ops',
    })
    await dispatch(router, 'POST', '/api/chat-runtime/codex/sessions/title', {
      ref,
      title: 'Set title',
      conversationId: 'conv-ops',
    })
    await dispatch(router, 'POST', '/api/chat-runtime/codex/sessions/delete', {
      ref,
      conversationId: 'conv-ops',
    })
    await dispatch(router, 'POST', '/api/chat-runtime/codex/sessions/pin', {
      ref,
      pinned: true,
      conversationId: 'conv-ops',
    })
    expect(runtime.getSessionCalls()).toEqual([
      'open:thread-1',
      'rename:thread-1:New title',
      'title:thread-1:Set title',
      'delete:thread-1',
      'pin:thread-1:true',
    ])
  })

  it('propagates an ok:false session command result as a 200 payload', async () => {
    const runtime = makeRuntime({
      deleteSession: async () => ({
        ok: false as const,
        error: {
          kind: 'rejected' as const,
          reason: 'not found',
          retryable: false,
        },
      }),
    })
    const res = await dispatch(
      createRouter(runtime),
      'POST',
      '/api/chat-runtime/codex/sessions/delete',
      {
        ref,
        conversationId: 'conv-fail',
      },
    )
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      ok: false,
      error: { kind: 'rejected', reason: 'not found', retryable: false },
    })
  })

  it('rejects a missing session ref', async () => {
    const runtime = makeRuntime()
    const res = await dispatch(
      createRouter(runtime),
      'POST',
      '/api/chat-runtime/codex/sessions/open',
      {
        conversationId: 'conv-1',
      },
    )
    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toMatchObject({
      error: { code: 'bad_request' },
    })
  })

  it('disposes cached runtimes and clears replay buffers on disposeChatRuntimeRouteCaches (E3)', async () => {
    const disposedA: string[] = []
    const subscribedA: string[] = []
    const subscribedB: string[] = []
    const runtimeA = {
      runtimeId: 'codex',
      capabilities: {},
      getSnapshot: jest.fn(() => ({
        messages: [],
        runState: 'idle',
        replayCursor: 0,
      })),
      subscribe: jest.fn((_listener: (event: unknown) => void) => {
        subscribedA.push('sub')
        return () => undefined
      }),
      dispose: jest.fn(async () => {
        disposedA.push('disposed')
      }),
    } as unknown as ChatRuntime
    const runtimeB = {
      runtimeId: 'codex',
      capabilities: {},
      getSnapshot: jest.fn(() => ({
        messages: [],
        runState: 'idle',
        replayCursor: 0,
      })),
      subscribe: jest.fn((_listener: (event: unknown) => void) => {
        subscribedB.push('sub')
        return () => undefined
      }),
      dispose: jest.fn(async () => undefined),
    } as unknown as ChatRuntime

    let current: ChatRuntime = runtimeA
    const router = new WebRouter()
    registerChatRuntimeRoutes(router, {
      getChatRuntime: () => current,
    })

    // 第一次请求填充缓存（runtimeA）。
    await dispatch(
      router,
      'GET',
      '/api/chat-runtime/codex/stream?conversationId=conv-e3&cursor=0',
    )
    expect(subscribedA).toHaveLength(1)

    // 服务端重启：释放缓存 —— runtimeA 被 dispose，重放缓冲清空。
    await disposeChatRuntimeRouteCaches()
    expect(disposedA).toEqual(['disposed'])

    // 新 server 的请求必须重新解析 runtime（runtimeB），而不是复用旧实例。
    current = runtimeB
    await dispatch(
      router,
      'GET',
      '/api/chat-runtime/codex/stream?conversationId=conv-e3&cursor=0',
    )
    expect(subscribedB).toHaveLength(1)
    expect(subscribedA).toHaveLength(1)
  })

  it('coalesces concurrent runtime creation for the same conversation', async () => {
    await disposeChatRuntimeRouteCaches()
    let releaseRuntime!: () => void
    const runtimeReady = new Promise<void>((resolve) => {
      releaseRuntime = resolve
    })
    const runtime = makeRuntime({
      getSnapshot: () => ({
        replayCursor: 0,
        runId: 'run-coalesced',
        conversationId: 'conv-coalesced',
        sessionRef: null,
        messages: [],
        runState: 'idle',
        error: null,
        compactionBoundaries: [],
        configuration: null,
        capabilities: {} as never,
      }),
    })
    const getChatRuntime = jest.fn(async () => {
      await runtimeReady
      return runtime
    })
    const router = new WebRouter()
    registerChatRuntimeRoutes(router, { getChatRuntime })

    const first = dispatch(
      router,
      'GET',
      '/api/chat-runtime/codex/snapshot?conversationId=conv-coalesced',
    )
    const second = dispatch(
      router,
      'GET',
      '/api/chat-runtime/codex/snapshot?conversationId=conv-coalesced',
    )
    releaseRuntime()
    await Promise.all([first, second])

    expect(getChatRuntime).toHaveBeenCalledTimes(1)
    await disposeChatRuntimeRouteCaches()
  })

  it('retries runtime creation after a rejected attempt without leaking a rejection', async () => {
    await disposeChatRuntimeRouteCaches()
    const runtime = makeRuntime({
      getSnapshot: () => ({
        replayCursor: 0,
        runId: 'run-retry',
        conversationId: 'conv-retry',
        sessionRef: null,
        messages: [],
        runState: 'idle',
        error: null,
        compactionBoundaries: [],
        configuration: null,
        capabilities: {} as never,
      }),
    })
    const getChatRuntime = jest
      .fn<Promise<ChatRuntime>, []>()
      .mockRejectedValueOnce(new Error('runtime creation failed'))
      .mockResolvedValueOnce(runtime)
    const router = new WebRouter()
    registerChatRuntimeRoutes(router, { getChatRuntime })

    const failed = await dispatch(
      router,
      'GET',
      '/api/chat-runtime/codex/snapshot?conversationId=conv-retry',
    )
    await Promise.resolve()
    const retried = await dispatch(
      router,
      'GET',
      '/api/chat-runtime/codex/snapshot?conversationId=conv-retry',
    )

    expect(failed.statusCode).toBe(500)
    expect(retried.statusCode).toBe(200)
    expect(getChatRuntime).toHaveBeenCalledTimes(2)
    await disposeChatRuntimeRouteCaches()
  })

  it('invalidates only the cached runtimes for the changed conversation', async () => {
    await disposeChatRuntimeRouteCaches()
    const disposeFirst = jest.fn(async () => undefined)
    const first = makeRuntime({ dispose: disposeFirst })
    const second = makeRuntime()
    const getChatRuntime = jest
      .fn<Promise<ChatRuntime>, []>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const router = new WebRouter()
    registerChatRuntimeRoutes(router, { getChatRuntime })

    await dispatch(
      router,
      'GET',
      '/api/chat-runtime/codex/snapshot?conversationId=conv-cwd',
    )
    await invalidateChatRuntimeConversation('conv-cwd')
    await dispatch(
      router,
      'GET',
      '/api/chat-runtime/codex/snapshot?conversationId=conv-cwd',
    )

    expect(disposeFirst).toHaveBeenCalledTimes(1)
    expect(getChatRuntime).toHaveBeenCalledTimes(2)
    await disposeChatRuntimeRouteCaches()
  })

})
