// eslint-disable-next-line import/no-nodejs-modules -- type-only import，编译后消失，无运行时 node 依赖
import type { ServerResponse } from 'node:http'

import type {
  ChatCommandResult,
  ChatRuntime,
  ChatRuntimeEvent,
  ChatRuntimeSnapshot,
  ChatSessionRef,
} from '../../chat-runtime/contract'
import {
  type WireEventEnvelope,
  eventToWire,
} from '../../chat-runtime/remote/remoteProtocol'
import { SseResponseWriter } from '../SseResponseWriter'
import { writeJson } from '../WebHttpServer'
import type { WebRouter } from '../WebRouter'

import { apiError, readJsonBody } from './routeUtils'

export type ChatRuntimeRoutesContext = {
  /**
   * 按 runtimeId（含 'yolo'）返回服务端 ChatRuntime；
   * 桌面会话内组装：CLI -> createCliChatRuntime(scope)，native -> createNativeChatRuntime(agentService)。
   */
  getChatRuntime: (
    runtimeId: 'yolo' | 'claude-code' | 'codex',
    conversationId: string | null,
  ) => Promise<ChatRuntime | null> | ChatRuntime | null
}

const RUNTIME_IDS = ['yolo', 'claude-code', 'codex'] as const

function resolveRuntimeId(
  value: string,
): 'yolo' | 'claude-code' | 'codex' | null {
  return RUNTIME_IDS.includes(value as 'yolo') ? (value as 'yolo') : null
}

/** 每个 runtime 的重放缓冲：snapshot + 最近事件（含 cursor）。 */
const REPLAY_LIMIT = 200
/** 稳定 runtime 实例缓存：按 runtimeId + conversationId 键控，避免每个 HTTP 请求新建实例、也避免会话切换串台。 */
const runtimeCache = new Map<string, ChatRuntime>()
const replayByRuntime = new Map<
  string,
  {
    snapshot: ChatRuntimeSnapshot
    events: WireEventEnvelope[]
    cursor: number
  }
>()

type ChatRuntimeStreamCloser = (code: string) => void
const streamsBySession = new Map<string, Set<ChatRuntimeStreamCloser>>()
const activeStreams = new Set<ChatRuntimeStreamCloser>()

/**
 * 释放缓存的 runtime 实例与重放缓冲（E3）。server 停止/重启时调用——旧
 * runtime 的订阅若驻留，会在新 server 上继续推送已死会话的事件。
 */
export async function disposeChatRuntimeRouteCaches(): Promise<void> {
  closeAllChatRuntimeStreams('agent_unavailable')
  const runtimes = [...runtimeCache.values()]
  runtimeCache.clear()
  replayByRuntime.clear()
  await Promise.all(
    runtimes
      .filter((runtime) => typeof runtime.dispose === 'function')
      .map((runtime) => runtime.dispose().catch(() => undefined)),
  )
}

export function closeChatRuntimeSessionStreams(
  sessionId: string,
  code: string,
): void {
  for (const close of [...(streamsBySession.get(sessionId) ?? [])]) {
    close(code)
  }
}

function closeAllChatRuntimeStreams(code: string): void {
  for (const close of [...activeStreams]) {
    close(code)
  }
}

export function registerChatRuntimeStream(
  sessionId: string | null,
  close: ChatRuntimeStreamCloser,
): () => void {
  activeStreams.add(close)
  if (sessionId) {
    const streams = streamsBySession.get(sessionId) ?? new Set()
    streams.add(close)
    streamsBySession.set(sessionId, streams)
  }
  return () => {
    activeStreams.delete(close)
    if (!sessionId) return
    const streams = streamsBySession.get(sessionId)
    streams?.delete(close)
    if (streams?.size === 0) streamsBySession.delete(sessionId)
  }
}

function runtimeCacheKey(
  runtimeId: 'yolo' | 'claude-code' | 'codex',
  conversationId: string | null,
): string {
  return `${runtimeId}:${conversationId ?? ''}`
}

async function resolveCachedRuntime(
  runtimeId: 'yolo' | 'claude-code' | 'codex',
  conversationId: string | null,
  context: ChatRuntimeRoutesContext,
): Promise<ChatRuntime | null> {
  const key = runtimeCacheKey(runtimeId, conversationId)
  const cached = runtimeCache.get(key)
  if (cached) return cached
  const runtime = await context.getChatRuntime(runtimeId, conversationId)
  if (runtime) runtimeCache.set(key, runtime)
  return runtime
}

function recordEvent(key: string, wire: WireEventEnvelope): void {
  const entry = replayByRuntime.get(key)
  if (!entry) return
  entry.events.push(wire)
  entry.cursor = wire.sequence
  if (entry.events.length > REPLAY_LIMIT) {
    entry.events.splice(0, entry.events.length - REPLAY_LIMIT)
  }
}

const queryValue = (req: { url?: string }, key: string): string | null => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const value = url.searchParams.get(key)
  return typeof value === 'string' ? value : null
}

const writeCommandResult = (
  res: ServerResponse,
  result: ChatCommandResult,
): void => {
  // 契约命令返回结构化结果而非 HTTP 错误：unsupported/failed 也是合法
  // 200 响应体，客户端按 ChatCommandResult 判别联合解析。
  writeJson(res, 200, result)
}

export function registerChatRuntimeRoutes(
  router: WebRouter,
  context: ChatRuntimeRoutesContext,
): void {
  const requireRuntime = async (
    runtimeId: 'yolo' | 'claude-code' | 'codex',
    conversationId: string | null,
  ): Promise<ChatRuntime | null> =>
    resolveCachedRuntime(runtimeId, conversationId, context)

  router.get(
    '/api/chat-runtime/:runtimeId/stream',
    async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const conversationId = queryValue(req, 'conversationId')
        const runtime = await requireRuntime(runtimeId, conversationId)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream; charset=utf-8')
        res.setHeader('cache-control', 'no-cache, no-transform')
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders()
        }
        const writer = new SseResponseWriter(res, { maxPendingBytes: 65536 })
        const replayKey = runtimeCacheKey(runtimeId, conversationId)
        const sessionId = getHeader(req.headers['x-yolo-web-session-id'])
        let closed = false
        let unsubscribe: (() => void) | null = null
        let unregisterStream: (() => void) | null = null
        const close = (code?: string) => {
          if (closed) return
          closed = true
          if (code) {
            writer.write(
              `event: session_closed\ndata: ${JSON.stringify({ code })}\n\n`,
            )
          }
          unsubscribe?.()
          unsubscribe = null
          unregisterStream?.()
          unregisterStream = null
          writer.close()
        }
        const entry = replayByRuntime.get(replayKey) ?? {
          snapshot: runtime.getSnapshot(),
          events: [],
          cursor: 0,
        }
        replayByRuntime.set(replayKey, entry)
        const cursor = Number(queryValue(req, 'cursor') ?? 0)
        unregisterStream = registerChatRuntimeStream(sessionId, close)
        // 断线续传：先重放缓冲内 cursor 之后的事件；有 gap 时客户端会调用 /snapshot 重建。
        // 重放期间连接可能已被 req close 关闭——必须在循环内检查 closed，
        // 否则 writer.close() 之后仍继续写（close 后再触发 slow-consumer
        // 分支或 res.end() 竞态）。
        for (const wire of entry.events) {
          if (closed) return
          if (wire.sequence > cursor) {
            writer.write(`data: ${JSON.stringify(wire)}\n\n`)
          }
        }
        if (closed) return
        const runtimeUnsubscribe = runtime.subscribe(
          (event: ChatRuntimeEvent) => {
            if (closed) return
            const wire = eventToWire(event)
            recordEvent(replayKey, wire)
            writer.write(`data: ${JSON.stringify(wire)}\n\n`)
          },
        )
        if (closed) {
          runtimeUnsubscribe()
        } else {
          unsubscribe = runtimeUnsubscribe
        }
        writer.write(': heartbeat\n\n')
        req.on('close', () => close())
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_stream_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
  )

  router.get(
    '/api/chat-runtime/:runtimeId/snapshot',
    async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const conversationId = queryValue(req, 'conversationId')
        const runtime = await requireRuntime(runtimeId, conversationId)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        const snapshot = runtime.getSnapshot()
        const entry = replayByRuntime.get(
          runtimeCacheKey(runtimeId, conversationId),
        )
        writeJson(res, 200, {
          snapshot,
          cursor: entry?.cursor ?? snapshot.replayCursor,
        })
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_snapshot_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
  )

  router.post('/api/chat-runtime/:runtimeId/turn', async (req, res, params) => {
    try {
      const runtimeId = resolveRuntimeId(params.runtimeId)
      if (!runtimeId) {
        return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        writeJson(res, body.statusCode, body.body)
        return
      }
      const {
        requestId,
        messageId,
        baseRevision,
        messageGeneration,
        content,
        conversationId,
      } = body.value as {
        requestId?: string
        messageId?: string
        baseRevision?: number
        messageGeneration?: number
        content?: string
        conversationId?: string
      }
      const runtime = await requireRuntime(runtimeId, conversationId ?? null)
      if (!runtime) {
        return writeJson(
          res,
          404,
          apiError('runtime_unavailable', 'runtime unavailable'),
        )
      }
      if (!content) {
        return writeJson(res, 400, apiError('bad_request', 'content required'))
      }
      await runtime.sendTurn({
        requestId: requestId ?? `remote-${Date.now()}`,
        messageId: messageId ?? `remote-msg-${Date.now()}`,
        baseRevision,
        messageGeneration,
        content,
        conversationId,
      })
      writeJson(res, 202, {
        requestId: requestId ?? `remote-${Date.now()}`,
        messageId: messageId ?? `remote-msg-${Date.now()}`,
      })
    } catch (error) {
      writeJson(
        res,
        500,
        apiError(
          'chat_runtime_turn_failed',
          error instanceof Error ? error.message : String(error),
        ),
      )
    }
  })

  router.post(
    '/api/chat-runtime/:runtimeId/cancel',
    async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          writeJson(res, body.statusCode, body.body)
          return
        }
        const { requestId, conversationId } = body.value as {
          requestId?: string
          conversationId?: string
        }
        const runtime = await requireRuntime(runtimeId, conversationId ?? null)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        await runtime.cancel(requestId)
        writeJson(res, 200, { ok: true })
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_cancel_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
  )

  router.post(
    '/api/chat-runtime/:runtimeId/approval',
    async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          writeJson(res, body.statusCode, body.body)
          return
        }
        const { requestId, decision, conversationId } = body.value as {
          requestId: string
          decision: string
          conversationId?: string
        }
        const runtime = await requireRuntime(runtimeId, conversationId ?? null)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        await runtime.respondApproval({
          requestId,
          decision: decision as
            | 'approve_once'
            | 'approve_for_session'
            | 'reject',
        })
        writeJson(res, 200, { ok: true })
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_approval_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
  )

  router.post(
    '/api/chat-runtime/:runtimeId/question',
    async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          writeJson(res, body.statusCode, body.body)
          return
        }
        const { requestId, answer, conversationId } = body.value as {
          requestId: string
          answer: unknown
          conversationId?: string
        }
        const runtime = await requireRuntime(runtimeId, conversationId ?? null)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        await runtime.respondQuestion({ requestId, answer })
        writeJson(res, 200, { ok: true })
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_question_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
  )

  router.post(
    '/api/chat-runtime/:runtimeId/config',
    async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          writeJson(res, body.statusCode, body.body)
          return
        }
        const { modelId, reasoningEffort, conversationId } = body.value as {
          modelId?: string | null
          reasoningEffort?: string | null
          conversationId?: string
        }
        const runtime = await requireRuntime(runtimeId, conversationId ?? null)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        await runtime.updateConfiguration({ modelId, reasoningEffort })
        writeJson(res, 200, { ok: true })
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_config_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
  )

  router.post(
    '/api/chat-runtime/:runtimeId/permission',
    async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          writeJson(res, body.statusCode, body.body)
          return
        }
        const { mode, yoloEnabled, conversationId } = body.value as {
          mode: string
          yoloEnabled: boolean
          conversationId?: string
        }
        const runtime = await requireRuntime(runtimeId, conversationId ?? null)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        await runtime.updatePermissionProfile({
          mode: mode as 'ask' | 'agent' | 'plan',
          yoloEnabled,
        })
        writeJson(res, 200, { ok: true })
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_permission_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
  )

  // ---- provider-native 会话管理（契约 providerSessions / sessionPin 能力） ----

  router.get(
    '/api/chat-runtime/:runtimeId/sessions',
    async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const conversationId = queryValue(req, 'conversationId')
        const runtime = await requireRuntime(runtimeId, conversationId)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        const result = await runtime.listSessions()
        writeCommandResult(res, result)
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_sessions_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    },
  )

  const sessionCommand = (
    endpoint: string,
    handler: (
      runtime: ChatRuntime,
      body: { ref?: unknown; title?: string; pinned?: boolean },
    ) => Promise<ChatCommandResult>,
  ) =>
    router.post(endpoint, async (req, res, params) => {
      try {
        const runtimeId = resolveRuntimeId(params.runtimeId)
        if (!runtimeId) {
          return writeJson(res, 400, apiError('bad_runtime', 'unknown runtime'))
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          writeJson(res, body.statusCode, body.body)
          return
        }
        const { ref, conversationId } = body.value as {
          ref?: unknown
          conversationId?: string
        }
        const runtime = await requireRuntime(runtimeId, conversationId ?? null)
        if (!runtime) {
          return writeJson(
            res,
            404,
            apiError('runtime_unavailable', 'runtime unavailable'),
          )
        }
        if (!ref || typeof ref !== 'object') {
          return writeJson(
            res,
            400,
            apiError('bad_request', 'session ref required'),
          )
        }
        const result = await handler(
          runtime,
          body.value as { ref?: unknown; title?: string; pinned?: boolean },
        )
        writeCommandResult(res, result)
      } catch (error) {
        writeJson(
          res,
          500,
          apiError(
            'chat_runtime_session_command_failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    })

  sessionCommand(
    '/api/chat-runtime/:runtimeId/sessions/open',
    (runtime, body) => runtime.openSession(body.ref as ChatSessionRef),
  )
  sessionCommand(
    '/api/chat-runtime/:runtimeId/sessions/rename',
    (runtime, body) =>
      runtime.renameSession(
        body.ref as ChatSessionRef,
        typeof body.title === 'string' ? body.title : '',
      ),
  )
  sessionCommand(
    '/api/chat-runtime/:runtimeId/sessions/title',
    (runtime, body) =>
      runtime.setSessionTitle(
        body.ref as ChatSessionRef,
        typeof body.title === 'string' ? body.title : '',
      ),
  )
  sessionCommand(
    '/api/chat-runtime/:runtimeId/sessions/delete',
    (runtime, body) => runtime.deleteSession(body.ref as ChatSessionRef),
  )
  sessionCommand('/api/chat-runtime/:runtimeId/sessions/pin', (runtime, body) =>
    runtime.setSessionPinned(body.ref as ChatSessionRef, body.pinned === true),
  )
}

function getHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}
