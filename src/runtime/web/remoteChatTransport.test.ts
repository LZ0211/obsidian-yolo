/**
 * @jest-environment jsdom
 */
/* eslint-disable no-restricted-globals -- jsdom 测试验证浏览器端 localStorage/fetch 行为 */
/* eslint-disable @typescript-eslint/no-base-to-string -- 测试断言 String(url) 的请求地址字符串化 */
/* eslint-disable import/no-nodejs-modules -- jsdom 无 ReadableStream，测试 mock 用 node:stream/web 的 Web Streams 实现 */
import { ReadableStream } from 'node:stream/web'

import { createWebRemoteTransport } from './remoteChatTransport'

describe('createWebRemoteTransport', () => {
  const baseUrl = 'http://127.0.0.1:18900'

  it('posts JSON to the chat-runtime endpoints with the web session header', async () => {
    const fetchImpl = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${baseUrl}/api/chat-runtime/codex/sessions/pin`)
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>)['x-yolo-web-session-id']).toBe(
        'session-1',
      )
      expect(init?.body).toContain('"pinned":true')
      return { ok: true, json: async () => ({ ok: true }) }
    })

    const transport = createWebRemoteTransport({
      baseUrl,
      sessionId: 'session-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await transport.post(
      '/api/chat-runtime/codex/sessions/pin',
      { ref: { runtimeId: 'codex', nativeSessionId: 's1' }, pinned: true },
    )
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('sends GETs without a body and omits the header when no session exists', async () => {
    const fetchImpl = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${baseUrl}/api/chat-runtime/codex/sessions`)
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.headers).toEqual({})
      return { ok: true, json: async () => ({ ok: true, sessions: [] }) }
    })

    const transport = createWebRemoteTransport({
      baseUrl,
      sessionId: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await transport.get('/api/chat-runtime/codex/sessions')
    expect(result.ok).toBe(true)
  })

  it('reads the session id from localStorage when not provided', () => {
    localStorage.setItem('yolo-web-session-id', 'stored-session')
    const fetchImpl = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({}),
    }))
    const transport = createWebRemoteTransport({
      baseUrl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    void transport.post('/api/chat-runtime/codex/turn', {})
    expect(
      (fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>)[
        'x-yolo-web-session-id'
      ],
    ).toBe('stored-session')
    localStorage.removeItem('yolo-web-session-id')
  })

  it('opens the event stream over fetch with the session header and dispatches SSE frames (E1)', async () => {
    type StreamController = {
      enqueue: (chunk: Uint8Array) => void
      close: () => void
    }
    let controller: StreamController | null = null
    const body = new ReadableStream<Uint8Array>({
      start: (streamController: StreamController) => {
        controller = streamController
      },
    })
    const fetchImpl = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://127.0.0.1:18900/api/chat-runtime/codex/stream?cursor=0&conversationId=conv-1',
      )
      expect(init?.method ?? 'GET').toBe('GET')
      expect((init?.headers as Record<string, string>)['x-yolo-web-session-id']).toBe(
        'session-1',
      )
      expect((init?.headers as Record<string, string>)['Accept']).toBe(
        'text/event-stream',
      )
      return { ok: true, body } as unknown as Response
    })

    const transport = createWebRemoteTransport({
      baseUrl,
      sessionId: 'session-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const source = transport.open(
      '/api/chat-runtime/codex/stream?cursor=0&conversationId=conv-1',
    )
    const messages: string[] = []
    source.addEventListener('message', (event) => {
      messages.push(String(event.data))
    })
    ;(controller as StreamController | null)?.enqueue(
      new TextEncoder().encode(
        `event: run.state\nid: 1\ndata: {"type":"run.state"}\n\n: heartbeat\n\ndata: {"type":"run.completed"}\n\n`,
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(messages).toEqual([
      '{"type":"run.state"}',
      '{"type":"run.completed"}',
    ])
    source.close()
  })

  it('dispatches an error event when the SSE stream fails (fetch rejects) (E1)', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('network down')
    })
    const transport = createWebRemoteTransport({
      baseUrl,
      sessionId: 'session-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const errors: Event[] = []
    const source = transport.open('/api/chat-runtime/codex/stream')
    source.addEventListener('error', (event) => {
      errors.push(event)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errors).toHaveLength(1)
  })
})
