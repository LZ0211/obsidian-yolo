/* eslint-disable no-restricted-globals -- 浏览器运行时使用 Web 平台 API（localStorage 会话 id / fetch 传输），Obsidian 桌面端禁令不适用 */
import type { RemoteTransport } from '../../core/chat-runtime/remote/RemoteChatRuntimeAdapter'

const WEB_SESSION_HEADER = 'x-yolo-web-session-id'
const SESSION_STORAGE_KEY = 'yolo-web-session-id'

const readSessionId = (): string | null => {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * Web 端契约 ChatRuntime 的 RemoteTransport（Phase B Step 4 地基）。
 *
 * 与 WebApiClient 共用同一个 localStorage 会话 id（x-yolo-web-session-id），
 * 事件流与命令都走 fetch（可携带 header），全部指向 `/api/chat-runtime/*`。
 *
 * E1：事件流不再用 EventSource——EventSource 无法设置请求头，非回环 host 下
 * WebHttpServer.isAuthorizedRequest 要求 Bearer/session header，EventSource
 * 打开的事件流必然 401 且无限重连。fetch + ReadableStream 逐帧解析 SSE，
 * 断线/流结束派发 error 事件，由 RemoteChatRuntimeAdapter 以退避重连。
 */
export const createWebRemoteTransport = ({
  baseUrl,
  sessionId = readSessionId(),
  fetchImpl = (...args) => fetch(...args),
}: {
  baseUrl: string
  sessionId?: string | null
  fetchImpl?: typeof fetch
}): RemoteTransport => {
  const origin = baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = sessionId
    ? { [WEB_SESSION_HEADER]: sessionId }
    : {}

  return {
    open: (url) => createFetchSseSource({ url: `${origin}${url}`, headers, fetchImpl }),
    post: async (path, body) => {
      const response = await fetchImpl(`${origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      })
      return { ok: response.ok, json: () => response.json() }
    },
    get: async (path) => {
      const response = await fetchImpl(`${origin}${path}`, { headers })
      return { ok: response.ok, json: () => response.json() }
    },
  }
}

type SseSource = ReturnType<RemoteTransport['open']>

type ParsedSseFrame = {
  /** Named SSE event (`event:` line); undefined for default `message` frames. */
  eventName?: string
  data: string | null
}

const parseSseFrame = (frame: string): ParsedSseFrame => {
  let eventName: string | undefined
  const dataLines: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trimStart()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  return {
    ...(eventName !== undefined ? { eventName } : {}),
    data: dataLines.length > 0 ? dataLines.join('\n') : null,
  }
}

/**
 * EventSource-compatible SSE client built on fetch so the session header
 * reaches the stream endpoint. Dispatches `message` events with the parsed
 * `data:` payload and an `error` event on fetch failure or stream end — the
 * adapter treats `error` as "reconnect with backoff".
 */
function createFetchSseSource({
  url,
  headers,
  fetchImpl,
}: {
  url: string
  headers: Record<string, string>
  fetchImpl: typeof fetch
}): SseSource {
  const messageListeners = new Set<(event: MessageEvent) => void>()
  const errorListeners = new Set<(event: Event) => void>()
  const sessionClosedListeners = new Set<(event: MessageEvent) => void>()
  const abortController = new AbortController()
  let closed = false

  const dispatchError = (): void => {
    for (const listener of [...errorListeners]) {
      listener(new Event('error'))
    }
  }

  const run = async (): Promise<void> => {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...headers },
        signal: abortController.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`SSE stream failed with ${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const { eventName, data } = parseSseFrame(frame)
          if (eventName === 'session_closed') {
            // 会话撤销是终态：通知监听方后关闭流，不派发 error（error 会让
            // 适配器按退避无限重连已撤销的会话）。
            const event = new MessageEvent('session_closed', {
              data: data ?? '',
            })
            for (const listener of [...sessionClosedListeners]) {
              listener(event)
            }
            closed = true
            abortController.abort()
            return
          }
          if (data !== null) {
            for (const listener of [...messageListeners]) {
              listener(new MessageEvent('message', { data }))
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
      if (!closed) dispatchError()
    } catch {
      if (!closed) dispatchError()
    }
  }

  void run()

  return {
    addEventListener: (type, handler) => {
      if (type === 'message') {
        messageListeners.add(handler as (event: MessageEvent) => void)
      } else if (type === 'error') {
        errorListeners.add(handler as (event: Event) => void)
      } else if (type === 'session_closed') {
        sessionClosedListeners.add(handler as (event: MessageEvent) => void)
      }
    },
    removeEventListener: (type, handler) => {
      if (type === 'message') {
        messageListeners.delete(handler as (event: MessageEvent) => void)
      } else if (type === 'error') {
        errorListeners.delete(handler as (event: Event) => void)
      } else if (type === 'session_closed') {
        sessionClosedListeners.delete(handler as (event: MessageEvent) => void)
      }
    },
    close: () => {
      closed = true
      abortController.abort()
    },
  }
}
