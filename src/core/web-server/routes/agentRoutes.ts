import type { AgentRunTerminalStatus } from '../../../types/agentRun'
import type {
  ChatConversationCompaction,
  ChatUserMessage,
} from '../../../types/chat'
import type { ContextBreakdown } from '../../agent/contextBreakdown'
import type {
  AgentConversationState,
  AgentService,
  EnqueueUserMessageResult,
} from '../../agent/service'
import { SseResponseWriter } from '../SseResponseWriter'
import type { ChatWebBinding, EffectiveWorkspaceAgent } from '../webAgentTypes'
import type {
  CompactConversationInput,
  ContextBreakdownRouteInput,
  WebRunInput,
} from '../WebChatRuntimeAdapter'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'
import type { BufferedRunEvent, WebSseHub } from '../WebSseHub'

import { WEB_SESSION_HEADER } from './authRoutes'
import { type ApiError, apiError, readJsonBody } from './routeUtils'

export type AgentRouteRunStatus = AgentRunTerminalStatus | 'queued'

export type AgentRouteRunRecord = {
  runId: string
  conversationId: string
  status: AgentRouteRunStatus
}

export type AgentRouteBinding = Pick<
  ChatWebBinding,
  'activeAgentId' | 'rootHash'
> & {
  activeAgent: EffectiveWorkspaceAgent
}

export type AgentRoutesContext = {
  getRun: (
    runId: string,
  ) => Promise<AgentRouteRunRecord | null> | AgentRouteRunRecord | null
  getRunEvents: (
    runId: string,
    afterSequence: number,
  ) => Promise<BufferedRunEvent[]> | BufferedRunEvent[]
  getAgentState: (
    conversationId: string,
  ) => Promise<AgentConversationState> | AgentConversationState
  sseHub: Pick<WebSseHub, 'subscribe'>
  abortRun: (
    runId: string,
  ) =>
    | Promise<{ found: boolean; status: AgentRouteRunStatus }>
    | { found: boolean; status: AgentRouteRunStatus }
  runAgent: (request: {
    input: WebRunInput
    binding: AgentRouteBinding
  }) => Promise<{ conversationId: string; runId: string }>
  compactConversation: (request: {
    input: CompactConversationInput
    binding: AgentRouteBinding
  }) => Promise<ChatConversationCompaction | null>
  buildContextBreakdown: (request: {
    input: ContextBreakdownRouteInput
    binding: AgentRouteBinding
  }) => Promise<ContextBreakdown>
  approveToolCall: (
    input: Parameters<AgentService['approveToolCall']>[0],
  ) => Promise<{ approved: boolean; state: AgentConversationState }>
  rejectToolCall: AgentService['rejectToolCall']
  abortToolCall: AgentService['abortToolCall']
  peekPendingUserMessages: (
    conversationId: string,
  ) => Promise<ChatUserMessage[]> | ChatUserMessage[]
  enqueueUserMessage: (input: {
    conversationId: string
    message: ChatUserMessage
  }) => Promise<EnqueueUserMessageResult> | EnqueueUserMessageResult
  removePendingUserMessage: (input: {
    conversationId: string
    messageId: string
  }) => Promise<ChatUserMessage | null> | ChatUserMessage | null
  subscribeToPendingBackgroundTaskResults: (
    fn: (conversationId: string) => void,
  ) => () => void
  subscribeToAbortedQueuedMessages: (
    fn: (conversationId: string, messages: ChatUserMessage[]) => void,
  ) => () => void
  subscribeToPendingUserMessagesChanged?: (
    fn: (conversationId: string) => void,
  ) => () => void
  resolveAgentRouteBinding: (
    sessionId: string | null,
  ) =>
    | { ok: true; binding: AgentRouteBinding }
    | { ok: false; statusCode: number; body: ApiError }
  canAccessConversation: (
    conversationId: string,
    binding: AgentRouteBinding,
  ) => Promise<boolean> | boolean
  canStartConversation: (
    conversationId: string,
    binding: AgentRouteBinding,
  ) => Promise<boolean> | boolean
  canAccessRun: (
    runId: string,
    binding: AgentRouteBinding,
  ) => Promise<boolean> | boolean
}

const PROTECTED_SELECTOR_FIELDS = [
  'workspaceId',
  'agentInstanceId',
  'assistantId',
  'agentId',
  'activeAgentId',
  'rootHash',
  'workspaceRoot',
  'policy',
  'workspacePolicy',
  'readAllowlist',
  'readDenylist',
  'writeDenylist',
] as const

const PROTECTED_SELECTOR_MESSAGE =
  'agentId, assistantId, activeAgentId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected agent routes'

const MAX_SSE_PENDING_BYTES = 1024 * 1024
const SSE_HEARTBEAT_MS = 20_000

const unrefHeartbeat = (heartbeat: ReturnType<typeof setInterval>): void => {
  ;(heartbeat as unknown as { unref?: () => void }).unref?.()
}

export function registerAgentRoutes(
  router: WebRouter,
  context: AgentRoutesContext,
): void {
  router.post('/api/agent/run', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    const conversationId = body.value.conversationId
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'conversationId is required'),
      )
      return
    }
    if (
      !(await context.canStartConversation(conversationId, binding.binding))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(
      res,
      200,
      await context.runAgent({
        input: body.value as unknown as WebRunInput,
        binding: binding.binding,
      }),
    )
  })

  router.post('/api/agent/compact', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    const authorization = await requireConversationAccess(
      body.value,
      binding.binding,
      context,
    )
    if (!authorization.ok) {
      writeJson(res, authorization.statusCode, authorization.body)
      return
    }

    writeJson(
      res,
      200,
      await context.compactConversation({
        input: body.value as CompactConversationInput,
        binding: binding.binding,
      }),
    )
  })

  router.post('/api/agent/context-breakdown', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    const authorization = await requireConversationAccess(
      body.value,
      binding.binding,
      context,
    )
    if (!authorization.ok) {
      writeJson(res, authorization.statusCode, authorization.body)
      return
    }

    writeJson(
      res,
      200,
      await context.buildContextBreakdown({
        input: body.value as ContextBreakdownRouteInput,
        binding: binding.binding,
      }),
    )
  })

  router.get('/api/agent/state', async (req, res) => {
    const binding = requireAgentBinding(req.headers, req.url, context)
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    const parsed = parseConversationIdFromUrl(req.url)
    if (!parsed.ok) {
      writeJson(res, parsed.statusCode, parsed.body)
      return
    }
    if (
      !(await context.canAccessConversation(
        parsed.conversationId,
        binding.binding,
      ))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, await context.getAgentState(parsed.conversationId))
  })

  router.post('/api/agent/tool/approve', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const parsed = parseToolCallRequest(body.value, {
      allowForConversation: true,
    })
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    if (
      !(await context.canAccessConversation(
        parsed.value.conversationId,
        binding.binding,
      ))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    const result = await context.approveToolCall(parsed.value)
    writeJson(res, 200, result)
  })

  router.post('/api/agent/tool/reject', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const parsed = parseToolCallRequest(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    if (
      !(await context.canAccessConversation(
        parsed.value.conversationId,
        binding.binding,
      ))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, {
      rejected: context.rejectToolCall(parsed.value),
    })
  })

  router.post('/api/agent/tool/abort', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const parsed = parseToolCallRequest(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    if (
      !(await context.canAccessConversation(
        parsed.value.conversationId,
        binding.binding,
      ))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, {
      aborted: context.abortToolCall(parsed.value),
    })
  })

  router.get('/api/agent/queue/peek', async (req, res) => {
    const binding = requireAgentBinding(req.headers, req.url, context)
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    const parsed = parseConversationIdFromUrl(req.url)
    if (!parsed.ok) {
      writeJson(res, parsed.statusCode, parsed.body)
      return
    }
    // Peek 对"会话尚未创建"返回空队列（与桌面 AgentService 语义一致）：
    // 新建标签页的会话 id 在首条消息前并不存在于 journal 中，却仍需要
    // 展示空的中途消息队列。canStartConversation 恰好把缺失会话视为可访问。
    if (
      !(await context.canStartConversation(
        parsed.conversationId,
        binding.binding,
      ))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, {
      messages: await context.peekPendingUserMessages(parsed.conversationId),
    })
  })

  router.post('/api/agent/queue/enqueue', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    const parsed = parseQueuedMessageRequest(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    if (
      !(await context.canAccessConversation(
        parsed.value.conversationId,
        binding.binding,
      ))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, {
      result: await context.enqueueUserMessage(parsed.value),
    })
  })

  router.post('/api/agent/queue/remove', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    const parsed = parseRemoveQueuedMessageRequest(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    if (
      !(await context.canAccessConversation(
        parsed.value.conversationId,
        binding.binding,
      ))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, {
      message: await context.removePendingUserMessage(parsed.value),
    })
  })

  router.get('/api/agent/queue/events', async (req, res) => {
    const binding = requireAgentBinding(req.headers, req.url, context)
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-cache, no-transform')
    res.setHeader('connection', 'keep-alive')
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }

    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const unsubscriptions: Array<() => void> = []
    const cleanup = () => {
      if (closed) return
      closed = true
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
      for (const unsubscribe of unsubscriptions.splice(0)) {
        unsubscribe()
      }
    }
    const close = () => {
      cleanup()
      if (!res.writableEnded) {
        res.end()
      }
    }
    const writer = new SseResponseWriter(res, {
      maxPendingBytes: MAX_SSE_PENDING_BYTES,
      onClose: cleanup,
    })
    heartbeat = setInterval(
      () => writer.write(': heartbeat\n\n'),
      SSE_HEARTBEAT_MS,
    )
    unrefHeartbeat(heartbeat)

    unsubscriptions.push(
      context.subscribeToPendingBackgroundTaskResults((conversationId) => {
        void Promise.resolve(
          context.canAccessConversation(conversationId, binding.binding),
        ).then((allowed) => {
          if (!allowed || res.writableEnded) {
            return
          }
          writeSimpleSseEvent(writer, {
            type: 'pending_background_task_results',
            conversationId,
          })
        })
      }),
    )
    unsubscriptions.push(
      context.subscribeToAbortedQueuedMessages((conversationId, messages) => {
        void Promise.resolve(
          context.canAccessConversation(conversationId, binding.binding),
        ).then((allowed) => {
          if (!allowed || res.writableEnded) {
            return
          }
          writeSimpleSseEvent(writer, {
            type: 'aborted_queued_messages',
            conversationId,
            messages,
          })
        })
      }),
    )
    if (context.subscribeToPendingUserMessagesChanged) {
      unsubscriptions.push(
        context.subscribeToPendingUserMessagesChanged((conversationId) => {
          void Promise.resolve(
            context.canAccessConversation(conversationId, binding.binding),
          ).then((allowed) => {
            if (!allowed || res.writableEnded) {
              return
            }
            writeSimpleSseEvent(writer, {
              type: 'user_message_enqueued',
              conversationId,
            })
          })
        }),
      )
    }
    req.on('close', close)
    res.on('close', cleanup)
  })

  router.get('/api/agent/stream/:runId', async (req, res, params) => {
    const sessionId = getSessionId(req.headers)
    const binding = requireAgentBinding(req.headers, req.url, context)
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    if (!(await context.canAccessRun(params.runId, binding.binding))) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }
    const run = await context.getRun(params.runId)
    if (!run) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    const cursor = resolveCursor(req.url, req.headers['last-event-id'])
    if (!cursor.ok) {
      writeJson(res, cursor.statusCode, cursor.body)
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-cache, no-transform')
    res.setHeader('connection', 'keep-alive')
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }

    let unsubscribe: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const close = () => {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
      unsubscribe?.()
      unsubscribe = null
      if (!res.writableEnded) {
        res.end()
      }
    }
    const writer = new SseResponseWriter(res, {
      maxPendingBytes: MAX_SSE_PENDING_BYTES,
      onClose: close,
    })
    heartbeat = setInterval(
      () => writer.write(': heartbeat\n\n'),
      SSE_HEARTBEAT_MS,
    )
    unrefHeartbeat(heartbeat)

    try {
      const replayEvents = await context.getRunEvents(
        params.runId,
        cursor.cursorExclusive,
      )
      for (const event of replayEvents) {
        writeSseEvent(writer, event)
      }
      if (writer.isClosed) {
        close()
        return
      }

      // Run 可能在 replay 完成前就已终态（桥在 finally 里 clearRun 关闭了
      // 早前订阅者）。此时直接关闭本次连接，客户端会收到 done 并走
      // refreshAgentState 拉全量状态，避免一条永不结束的空 SSE。
      const latestRun = await context.getRun(params.runId)
      if (latestRun && isTerminalRunStatus(latestRun.status)) {
        writeSimpleSseEvent(writer, { type: 'run_closed' })
        close()
        return
      }

      unsubscribe = context.sseHub.subscribe(
        params.runId,
        (event) => {
          writeSseEvent(writer, event)
        },
        {
          sessionId: sessionId ?? undefined,
          onClose: (code) => {
            writeSimpleSseEvent(writer, {
              type: code,
            })
            close()
          },
        },
      )
      req.on('close', close)
      res.on('close', close)
    } catch (error) {
      close()
      throw error
    }
  })

  router.post('/api/agent/abort/:runId', async (req, res, params) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireAgentBinding(
      req.headers,
      req.url,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    if (!(await context.canAccessRun(params.runId, binding.binding))) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }
    const run = await context.getRun(params.runId)
    if (!run) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    const result = await context.abortRun(params.runId)
    if (!result.found) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, {
      runId: params.runId,
      status: result.status,
    })
  })
}

function parseConversationIdFromUrl(
  requestUrl: string | undefined,
):
  | { ok: true; conversationId: string }
  | { ok: false; statusCode: number; body: ApiError } {
  const url = new URL(requestUrl ?? '/', 'http://localhost')
  const conversationId = url.searchParams.get('conversationId')
  if (!conversationId) {
    return {
      ok: false,
      statusCode: 400,
      body: apiError('invalid_request', 'conversationId is required'),
    }
  }
  return { ok: true, conversationId }
}

function getSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) {
    return value[0] ?? null
  }
  return typeof value === 'string' && value.length > 0 ? value : null
}

function requireAgentBinding(
  headers: Record<string, string | string[] | undefined>,
  requestUrl: string | undefined,
  context: AgentRoutesContext,
  body?: Record<string, unknown>,
):
  | { ok: true; binding: AgentRouteBinding }
  | { ok: false; statusCode: number; body: ApiError } {
  const selectorError = findProtectedSelectorError(requestUrl, body)
  if (selectorError) {
    return selectorError
  }
  return context.resolveAgentRouteBinding(getSessionId(headers))
}

function findProtectedSelectorError(
  requestUrl: string | undefined,
  body?: Record<string, unknown>,
): { ok: false; statusCode: number; body: ApiError } | null {
  const url = new URL(requestUrl ?? '/', 'http://localhost')
  for (const field of PROTECTED_SELECTOR_FIELDS) {
    if (url.searchParams.has(field)) {
      return {
        ok: false,
        statusCode: 400,
        body: apiError('invalid_request', PROTECTED_SELECTOR_MESSAGE),
      }
    }
  }
  if (body) {
    for (const field of PROTECTED_SELECTOR_FIELDS) {
      if (field in body) {
        return {
          ok: false,
          statusCode: 400,
          body: apiError('invalid_request', PROTECTED_SELECTOR_MESSAGE),
        }
      }
    }
  }
  return null
}

async function requireConversationAccess(
  value: Record<string, unknown>,
  binding: AgentRouteBinding,
  context: AgentRoutesContext,
): Promise<{ ok: true } | { ok: false; statusCode: number; body: ApiError }> {
  if (
    typeof value.conversationId !== 'string' ||
    value.conversationId.length === 0
  ) {
    return {
      ok: false,
      statusCode: 400,
      body: apiError('invalid_request', 'conversationId is required'),
    }
  }
  if (!(await context.canAccessConversation(value.conversationId, binding))) {
    return {
      ok: false,
      statusCode: 404,
      body: apiError('not_found', 'Not found'),
    }
  }
  return { ok: true }
}

function parseQueuedMessageRequest(value: Record<string, unknown>):
  | {
      ok: true
      value: { conversationId: string; message: ChatUserMessage }
    }
  | { ok: false; message: string } {
  if (
    typeof value.conversationId !== 'string' ||
    value.conversationId.length === 0
  ) {
    return { ok: false, message: 'conversationId is required' }
  }
  if (!value.message || typeof value.message !== 'object') {
    return { ok: false, message: 'message is required' }
  }
  const message = value.message as Partial<ChatUserMessage>
  if (message.role !== 'user' || typeof message.id !== 'string') {
    return { ok: false, message: 'message must be a user chat message' }
  }
  return {
    ok: true,
    value: {
      conversationId: value.conversationId,
      message: value.message as ChatUserMessage,
    },
  }
}

function parseRemoveQueuedMessageRequest(
  value: Record<string, unknown>,
):
  | { ok: true; value: { conversationId: string; messageId: string } }
  | { ok: false; message: string } {
  if (
    typeof value.conversationId !== 'string' ||
    value.conversationId.length === 0
  ) {
    return { ok: false, message: 'conversationId is required' }
  }
  if (typeof value.messageId !== 'string' || value.messageId.length === 0) {
    return { ok: false, message: 'messageId is required' }
  }
  return {
    ok: true,
    value: {
      conversationId: value.conversationId,
      messageId: value.messageId,
    },
  }
}

function parseToolCallRequest(
  value: Record<string, unknown>,
  options?: { allowForConversation?: boolean },
):
  | {
      ok: true
      value: {
        conversationId: string
        toolCallId: string
        allowForConversation?: boolean
      }
    }
  | { ok: false; message: string } {
  if (
    typeof value.conversationId !== 'string' ||
    value.conversationId.length === 0
  ) {
    return { ok: false, message: 'conversationId is required' }
  }
  if (typeof value.toolCallId !== 'string' || value.toolCallId.length === 0) {
    return { ok: false, message: 'toolCallId is required' }
  }
  if (
    value.allowForConversation !== undefined &&
    typeof value.allowForConversation !== 'boolean'
  ) {
    return { ok: false, message: 'allowForConversation is invalid' }
  }
  return {
    ok: true,
    value: {
      conversationId: value.conversationId,
      toolCallId: value.toolCallId,
      allowForConversation:
        options?.allowForConversation === true
          ? value.allowForConversation
          : undefined,
    },
  }
}

function writeSseEvent(
  res: {
    write: (chunk: string) => unknown
  },
  event: BufferedRunEvent,
): void {
  const eventName =
    typeof (event.eventJson as { type?: unknown })?.type === 'string'
      ? (event.eventJson as { type: string }).type
      : event.eventType
  res.write(
    `event: ${eventName}\nid: ${event.sequence}\ndata: ${JSON.stringify(
      event.eventJson,
    )}\n\n`,
  )
}

function writeSimpleSseEvent(
  res: {
    write: (chunk: string) => unknown
  },
  event: unknown,
): void {
  const eventName =
    typeof (event as { type?: unknown })?.type === 'string'
      ? (event as { type: string }).type
      : 'message'
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`)
}

function isTerminalRunStatus(
  status: AgentRouteRunStatus,
): status is Extract<AgentRouteRunStatus, 'completed' | 'error' | 'aborted'> {
  return status === 'completed' || status === 'error' || status === 'aborted'
}

function resolveCursor(
  requestUrl: string | undefined,
  lastEventIdHeader: string | string[] | undefined,
):
  | { ok: true; cursorExclusive: number }
  | { ok: false; statusCode: number; body: ApiError } {
  const url = new URL(requestUrl ?? '/', 'http://localhost')
  const cursorValue = url.searchParams.get('cursor')
  const raw = cursorValue ?? normalizeHeader(lastEventIdHeader)
  if (raw == null || raw.length === 0) {
    return { ok: true, cursorExclusive: 0 }
  }
  const cursorExclusive = Number.parseInt(raw, 10)
  if (!Number.isFinite(cursorExclusive) || cursorExclusive < 0) {
    return {
      ok: false,
      statusCode: 400,
      body: apiError('invalid_cursor', 'cursor must be a non-negative integer'),
    }
  }
  return { ok: true, cursorExclusive }
}

function normalizeHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null
  }
  return value ?? null
}
