/**
 * Web 端 subagent durable session 控制面（Task 11 web 接线）。
 *
 * 浏览器 UI（SubagentCard / runSubagentSessionAction）经 /api/subagent/*
 * 操作服务端真实 SubagentSessionService（WebSubagentSessionService HTTP
 * facade 的调用端）。路由与其余 web 端点同构：
 * - 会话级鉴权：resolveSubagentAccess 要求有效 web session（resolver.resolve），
 *   且（提供 parentConversationId 时）父会话可被当前 binding 访问
 *   （canUseWebConversation）——防止持有 A 会话 token 的用户用猜测的
 *   sessionId 操作 B 会话的 subagent；
 * - 服务未初始化（宿主持久接线未跑）回 503 subagent_unavailable，不静默。
 */
import type { SubagentSessionService } from '../../agent/subagent/session-service'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { type ApiError, apiError, readJsonBody } from './routeUtils'

export type SubagentRoutesContext = {
  getSessionService: () => SubagentSessionService | null
  resolveSubagentAccess: (
    sessionId: string | null,
    parentConversationId?: string,
  ) =>
    | Promise<
        | { ok: true }
        | { ok: false; statusCode: number; body: ApiError }
      >
    | { ok: true }
    | { ok: false; statusCode: number; body: ApiError }
}

export function registerSubagentRoutes(
  router: WebRouter,
  context: SubagentRoutesContext,
): void {
  router.get('/api/subagent/session', async (req, res) => {
    const sessionId = readQueryParam(req.url, 'sessionId')
    if (!sessionId) {
      writeJson(res, 400, apiError('invalid_request', 'sessionId is required'))
      return
    }
    const service = context.getSessionService()
    if (!service) {
      writeJson(
        res,
        503,
        apiError(
          'subagent_unavailable',
          'The subagent session service is unavailable.',
        ),
      )
      return
    }
    const snapshot = await service.query(sessionId)
    if (!snapshot) {
      writeJson(res, 200, null)
      return
    }
    const access = await context.resolveSubagentAccess(
      getSessionId(req.headers),
      snapshot.session.parentConversationId,
    )
    if (!access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }
    writeJson(res, 200, snapshot)
  })

  router.post('/api/subagent/recover', async (req, res) => {
    const service = context.getSessionService()
    if (!service) {
      writeJson(
        res,
        503,
        apiError(
          'subagent_unavailable',
          'The subagent session service is unavailable.',
        ),
      )
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const { sessionId, expectedSessionRevision, requestId } = body.value
    if (
      typeof sessionId !== 'string' ||
      typeof expectedSessionRevision !== 'number' ||
      typeof requestId !== 'string'
    ) {
      writeJson(
        res,
        400,
        apiError(
          'invalid_request',
          'sessionId, expectedSessionRevision and requestId are required',
        ),
      )
      return
    }
    const snapshot = await service.query(sessionId)
    if (!snapshot) {
      writeJson(
        res,
        404,
        apiError('session_not_found', 'The subagent session was not found.'),
      )
      return
    }
    const access = await context.resolveSubagentAccess(
      getSessionId(req.headers),
      snapshot.session.parentConversationId,
    )
    if (!access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }
    const result = await service.recover({
      sessionId,
      expectedSessionRevision,
      action: 'mark_interrupted_run_aborted',
      requestId,
    })
    writeJson(res, 200, result)
  })

  router.post('/api/subagent/queue-recovery', async (req, res) => {
    const service = context.getSessionService()
    if (!service) {
      writeJson(
        res,
        503,
        apiError(
          'subagent_unavailable',
          'The subagent session service is unavailable.',
        ),
      )
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const { sessionId, messageId, expectedSessionRevision, action, requestId } =
      body.value
    if (
      typeof sessionId !== 'string' ||
      typeof messageId !== 'string' ||
      typeof expectedSessionRevision !== 'number' ||
      (action !== 'resend' && action !== 'drop') ||
      typeof requestId !== 'string'
    ) {
      writeJson(
        res,
        400,
        apiError(
          'invalid_request',
          'sessionId, messageId, expectedSessionRevision, action (resend|drop) and requestId are required',
        ),
      )
      return
    }
    const snapshot = await service.query(sessionId)
    if (!snapshot) {
      writeJson(
        res,
        404,
        apiError('session_not_found', 'The subagent session was not found.'),
      )
      return
    }
    const access = await context.resolveSubagentAccess(
      getSessionId(req.headers),
      snapshot.session.parentConversationId,
    )
    if (!access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }
    const result = await service.queueRecovery({
      sessionId,
      messageId,
      expectedSessionRevision,
      action,
      requestId,
    })
    writeJson(res, 200, result)
  })

  router.post('/api/subagent/deliver-queued-intents', async (req, res) => {
    const service = context.getSessionService()
    if (!service) {
      writeJson(
        res,
        503,
        apiError(
          'subagent_unavailable',
          'The subagent session service is unavailable.',
        ),
      )
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const { sessionId } = body.value
    if (typeof sessionId !== 'string') {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'sessionId is required'),
      )
      return
    }
    const snapshot = await service.query(sessionId)
    if (!snapshot) {
      writeJson(
        res,
        404,
        apiError('session_not_found', 'The subagent session was not found.'),
      )
      return
    }
    const access = await context.resolveSubagentAccess(
      getSessionId(req.headers),
      snapshot.session.parentConversationId,
    )
    if (!access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }
    await service.deliverQueuedIntents(sessionId)
    writeJson(res, 200, { ok: true })
  })
}

function readQueryParam(url: string | undefined, key: string): string | null {
  if (!url) return null
  try {
    return new URL(url, 'http://localhost').searchParams.get(key)
  } catch {
    return null
  }
}

function getSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}
