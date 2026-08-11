/**
 * @jest-environment jsdom
 */
/* eslint-disable no-restricted-globals -- jsdom 测试验证浏览器端 localStorage/fetch 行为 */
/* eslint-disable @typescript-eslint/no-base-to-string -- 测试断言 String(url) 的请求地址字符串化 */
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
})
