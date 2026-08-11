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
 * 事件流走 EventSource、命令走 fetch，全部指向 `/api/chat-runtime/*` 端点。
 */
export const createWebRemoteTransport = ({
  baseUrl,
  sessionId = readSessionId(),
  fetchImpl = (...args) => fetch(...args),
  EventSourceImpl = globalThis.EventSource,
}: {
  baseUrl: string
  sessionId?: string | null
  fetchImpl?: typeof fetch
  /** 事件流构造器；Node 测试环境无全局 EventSource 时注入。 */
  EventSourceImpl?: typeof EventSource | undefined
}): RemoteTransport => {
  const origin = baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = sessionId
    ? { [WEB_SESSION_HEADER]: sessionId }
    : {}

  return {
    open: (url) => {
      if (!EventSourceImpl) {
        throw new Error('EventSource is not available in this environment')
      }
      const source = new EventSourceImpl(`${origin}${url}`)
      return {
        addEventListener: (type, handler) =>
          source.addEventListener(type, handler),
        removeEventListener: (type, handler) =>
          source.removeEventListener(type, handler),
        close: () => source.close(),
      }
    },
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
