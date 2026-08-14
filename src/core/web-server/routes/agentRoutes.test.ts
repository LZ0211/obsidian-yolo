/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type { ChatWebBinding } from '../webAgentTypes'
import { WebRouter } from '../WebRouter'
import { WebSseHub } from '../WebSseHub'

import { type AgentRoutesContext, registerAgentRoutes } from './agentRoutes'
import { WEB_SESSION_HEADER } from './authRoutes'

describe('agentRoutes', () => {
  it('requires an authenticated web session to start an agent run', async () => {
    const { router } = createHarness()

    const res = await dispatch(router, 'POST', '/api/agent/run', {
      conversationId: 'conv-1',
      messages: [{ id: 'u1', role: 'user', content: 'hello' }],
    })

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'session_expired',
        message: 'The web session has expired.',
      },
    })
  })

  it('starts an agent run with the current session binding and rejects client selectors', async () => {
    const runAgent = jest.fn().mockResolvedValue({
      conversationId: 'conv-1',
      runId: 'run-1',
    })
    const { router, resolveAgentRouteBinding } = createHarness({
      runAgent,
    })

    const rejected = await dispatch(
      router,
      'POST',
      '/api/agent/run',
      {
        conversationId: 'conv-1',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
        activeAgentId: 'agent-9',
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )
    expect(rejected.statusCode).toBe(400)
    expect(rejected.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'agentId, assistantId, activeAgentId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected agent routes',
      },
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/agent/run',
      {
        conversationId: 'conv-1',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(resolveAgentRouteBinding).toHaveBeenCalledWith('session-1')
    expect(runAgent).toHaveBeenCalledWith({
      binding: {
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
      input: {
        conversationId: 'conv-1',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      conversationId: 'conv-1',
      runId: 'run-1',
    })
  })

  it('rejects assistant and policy selectors on protected agent routes', async () => {
    const { router } = createHarness()

    const res = await dispatch(
      router,
      'POST',
      '/api/agent/run',
      {
        conversationId: 'conv-1',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
        assistantId: 'template-1',
        readAllowlist: ['/secret'],
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'agentId, assistantId, activeAgentId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected agent routes',
      },
    })
  })

  it('fails closed when starting a run for an inaccessible existing conversation', async () => {
    const runAgent = jest.fn()
    const canStartConversation = jest.fn().mockResolvedValue(false)
    const { router } = createHarness({
      runAgent,
      canStartConversation,
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/agent/run',
      {
        conversationId: 'conv-2',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(canStartConversation).toHaveBeenCalledWith('conv-2', {
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
    })
    expect(runAgent).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(404)
  })

  it('compacts a conversation through the backend adapter', async () => {
    const compactConversation = jest.fn().mockResolvedValue({
      anchorMessageId: 'a1',
      summary: 'summary',
      compactedAt: 1,
      compactedMessageCount: 2,
    })
    const { router } = createHarness({
      compactConversation,
    })

    const reqBody = {
      conversationId: 'conv-1',
      messages: [{ id: 'u1', role: 'user', content: 'hello' }],
      modelId: 'model-1',
    }
    const rejected = await dispatch(
      router,
      'POST',
      '/api/agent/compact',
      {
        ...reqBody,
        workspaceRoot: '/tmp',
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )
    expect(rejected.statusCode).toBe(400)

    const res = await dispatch(router, 'POST', '/api/agent/compact', reqBody, {
      [WEB_SESSION_HEADER]: 'session-1',
    })

    expect(compactConversation).toHaveBeenCalledWith({
      binding: {
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
      input: {
        conversationId: 'conv-1',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
        modelId: 'model-1',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      anchorMessageId: 'a1',
      summary: 'summary',
      compactedAt: 1,
      compactedMessageCount: 2,
    })
  })

  it('returns a backend-computed context breakdown payload', async () => {
    const buildContextBreakdown = jest.fn().mockResolvedValue({
      buckets: [{ bucket: 'conversation', tokens: 42 }],
      total: 42,
      max: 100,
      computedAt: 1,
    })
    const { router } = createHarness({
      buildContextBreakdown,
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/agent/context-breakdown',
      {
        conversationId: 'conv-1',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(buildContextBreakdown).toHaveBeenCalledWith({
      binding: {
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
      input: {
        conversationId: 'conv-1',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      buckets: [{ bucket: 'conversation', tokens: 42 }],
      total: 42,
      max: 100,
      computedAt: 1,
    })
  })

  it('prefers cursor query over Last-Event-ID during replay', async () => {
    const getRunEvents = jest.fn().mockResolvedValue([
      {
        sequence: 3,
        eventType: 'text',
        eventJson: { type: 'text', text: 'three' },
        createdAtMs: 3,
      },
    ])
    const sseHub = new WebSseHub()
    const { router, canAccessRun } = createHarness({
      getRun: jest.fn().mockResolvedValue({
        runId: 'run-1',
        conversationId: 'conv-1',
        status: 'running',
      }),
      getRunEvents,
      sseHub,
    })

    const res = await dispatch(
      router,
      'GET',
      '/api/agent/stream/run-1?cursor=2',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
        'last-event-id': '99',
      },
    )

    expect(canAccessRun).toHaveBeenCalledWith('run-1', {
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
    })
    expect(getRunEvents).toHaveBeenCalledWith('run-1', 2)
    expect(res.statusCode).toBe(200)
    expect(res.rawBody).toContain('id: 3')
    expect(res.rawBody).toContain('event: text')
  })

  it('fails closed when streaming a run without conversation binding authorization', async () => {
    const { router, canAccessRun } = createHarness({
      canAccessRun: jest.fn().mockResolvedValue(false),
      getRun: jest.fn().mockResolvedValue({
        runId: 'run-1',
        conversationId: 'legacy-conv',
        status: 'running',
      }),
    })

    const res = await dispatch(
      router,
      'GET',
      '/api/agent/stream/run-1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(canAccessRun).toHaveBeenCalledWith('run-1', {
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects workspace selectors on run stream requests', async () => {
    const { router } = createHarness()

    const res = await dispatch(
      router,
      'GET',
      '/api/agent/stream/run-1?workspaceId=ws-a',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'agentId, assistantId, activeAgentId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected agent routes',
      },
    })
  })

  it('streams live events after replay subscription', async () => {
    const sseHub = new WebSseHub()
    const { router } = createHarness({
      getRun: jest.fn().mockResolvedValue({
        runId: 'run-1',
        conversationId: 'conv-1',
        status: 'running',
      }),
      getRunEvents: jest.fn().mockResolvedValue([]),
      sseHub,
    })

    const resolved = router.resolve('GET', '/api/agent/stream/run-1')
    const req = createRequest({
      method: 'GET',
      url: '/api/agent/stream/run-1',
      headers: {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, { runId: 'run-1' })
    sseHub.publish('run-1', {
      sequence: 1,
      eventType: 'completed',
      eventJson: { type: 'completed', text: 'done' },
      createdAtMs: 1,
    })

    expect(res.rawBody).toContain('event: completed')
    expect(res.rawBody).toContain('"text":"done"')

    req.emit('close')
    expect(res.writableEnded).toBe(true)
  })

  it('does not lose an event published while replay is still loading', async () => {
    const replay = deferred<never[]>()
    const sseHub = new WebSseHub()
    const getRunEvents = jest.fn().mockReturnValue(replay.promise)
    const { router } = createHarness({
      getRun: jest.fn().mockResolvedValue({
        runId: 'run-1',
        conversationId: 'conv-1',
        status: 'running',
      }),
      getRunEvents,
      sseHub,
    })
    const resolved = router.resolve('GET', '/api/agent/stream/run-1')
    if (!resolved) throw new Error('missing stream route')
    const req = createRequest({
      method: 'GET',
      url: '/api/agent/stream/run-1',
      headers: { [WEB_SESSION_HEADER]: 'session-1' },
    })
    const res = createResponse()
    const handler = resolved.handler(req as never, res as never, {
      runId: 'run-1',
    })

    await waitFor(() => getRunEvents.mock.calls.length === 1)
    sseHub.publish('run-1', {
      sequence: 1,
      eventType: 'text',
      eventJson: { type: 'text', text: 'during-replay' },
      createdAtMs: 1,
    })
    replay.resolve([])
    await handler

    expect(res.rawBody).toContain('during-replay')
    req.emit('close')
  })

  it('cleans up the replay heartbeat when loading replay events fails', async () => {
    jest.useFakeTimers()
    try {
      const getRunEvents = jest
        .fn()
        .mockRejectedValue(new Error('replay failed'))
      const { router } = createHarness({
        getRun: jest.fn().mockResolvedValue({
          runId: 'run-1',
          conversationId: 'conv-1',
          status: 'running',
        }),
        getRunEvents,
      })
      const resolved = router.resolve('GET', '/api/agent/stream/run-1')
      if (!resolved) throw new Error('missing stream route')
      const req = createRequest({
        method: 'GET',
        url: '/api/agent/stream/run-1',
        headers: { [WEB_SESSION_HEADER]: 'session-1' },
      })
      const res = createResponse()

      await expect(
        resolved.handler(req as never, res as never, { runId: 'run-1' }),
      ).rejects.toThrow('replay failed')
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('forwards tool approval actions to the backend agent service', async () => {
    const agentState = {
      conversationId: 'conv-1',
      status: 'idle',
      messages: [],
      compaction: [],
      pendingCompactionAnchorMessageId: null,
    }
    const approveToolCall = jest
      .fn()
      .mockResolvedValue({ approved: true, state: agentState })
    const { router, canAccessConversation } = createHarness({
      approveToolCall,
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/agent/tool/approve',
      {
        conversationId: 'conv-1',
        toolCallId: 'tool-1',
        allowForConversation: true,
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(canAccessConversation).toHaveBeenCalledWith('conv-1', {
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
    })
    expect(approveToolCall).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      allowForConversation: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ approved: true, state: agentState })
  })

  it('forwards tool reject and abort actions to the backend agent service', async () => {
    const rejectToolCall = jest.fn().mockReturnValue(true)
    const abortToolCall = jest.fn().mockReturnValue(false)
    const { router, canAccessConversation } = createHarness({
      rejectToolCall,
      abortToolCall,
    })

    const rejectRes = await dispatch(
      router,
      'POST',
      '/api/agent/tool/reject',
      { conversationId: 'conv-1', toolCallId: 'tool-1' },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    const abortRes = await dispatch(
      router,
      'POST',
      '/api/agent/tool/abort',
      { conversationId: 'conv-1', toolCallId: 'tool-2' },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(rejectToolCall).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      allowForConversation: undefined,
    })
    expect(rejectRes.jsonBody).toEqual({ rejected: true })
    expect(abortToolCall).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      toolCallId: 'tool-2',
      allowForConversation: undefined,
    })
    expect(abortRes.jsonBody).toEqual({ aborted: false })
    expect(canAccessConversation).toHaveBeenCalledTimes(2)
  })

  it('forwards pending user message queue operations to the backend agent service', async () => {
    const queuedMessage = { id: 'u1', role: 'user', content: 'queued' }
    const peekPendingUserMessages = jest.fn().mockReturnValue([queuedMessage])
    const enqueueUserMessage = jest.fn().mockReturnValue('enqueued')
    const removePendingUserMessage = jest.fn().mockReturnValue(queuedMessage)
    const { router, canAccessConversation } = createHarness({
      peekPendingUserMessages,
      enqueueUserMessage,
      removePendingUserMessage,
    })

    const peekRes = await dispatch(
      router,
      'GET',
      '/api/agent/queue/peek?conversationId=conv-1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    const enqueueRes = await dispatch(
      router,
      'POST',
      '/api/agent/queue/enqueue',
      { conversationId: 'conv-1', message: queuedMessage },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    const removeRes = await dispatch(
      router,
      'POST',
      '/api/agent/queue/remove',
      { conversationId: 'conv-1', messageId: 'u1' },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(peekPendingUserMessages).toHaveBeenCalledWith('conv-1')
    expect(peekRes.jsonBody).toEqual({ messages: [queuedMessage] })
    expect(enqueueUserMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      message: queuedMessage,
    })
    expect(enqueueRes.jsonBody).toEqual({ result: 'enqueued' })
    expect(removePendingUserMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'u1',
    })
    expect(removeRes.jsonBody).toEqual({ message: queuedMessage })
    expect(canAccessConversation).toHaveBeenCalledTimes(3)
  })

  it('fails closed for conversation-bound routes when the persisted conversation has no web binding', async () => {
    const { router, canAccessConversation } = createHarness({
      canAccessConversation: jest.fn().mockResolvedValue(false),
    })

    const res = await dispatch(
      router,
      'GET',
      '/api/agent/state?conversationId=legacy-conv',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(canAccessConversation).toHaveBeenCalledWith('legacy-conv', {
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
    })
    expect(res.statusCode).toBe(404)
  })

  it('streams queue events for pending background results and aborted queued messages', async () => {
    let pendingSubscriber: ((conversationId: string) => void) | null = null
    let abortedSubscriber:
      | ((conversationId: string, messages: Array<{ id: string }>) => void)
      | null = null
    const unsubscribePending = jest.fn()
    const unsubscribeAborted = jest.fn()
    const { router } = createHarness({
      subscribeToPendingBackgroundTaskResults: (fn) => {
        pendingSubscriber = fn
        return unsubscribePending
      },
      subscribeToAbortedQueuedMessages: (fn) => {
        abortedSubscriber = fn as never
        return unsubscribeAborted
      },
    })

    const route = router.resolve('GET', '/api/agent/queue/events')
    const req = createRequest({
      method: 'GET',
      url: '/api/agent/queue/events',
      headers: {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    })
    const res = createResponse()

    await route?.handler(req as never, res as never, {})
    const emitPending = pendingSubscriber
    const emitAborted = abortedSubscriber
    expect(emitPending).toBeTruthy()
    expect(emitAborted).toBeTruthy()
    ;(emitPending as unknown as (conversationId: string) => void)('conv-1')
    ;(
      emitAborted as unknown as (
        conversationId: string,
        messages: Array<{ id: string }>,
      ) => void
    )('conv-1', [{ id: 'u1' }])
    await Promise.resolve()

    expect(res.rawBody).toContain('event: pending_background_task_results')
    expect(res.rawBody).toContain('"conversationId":"conv-1"')
    expect(res.rawBody).toContain('event: aborted_queued_messages')
    expect(res.rawBody).toContain('"messages":[{"id":"u1"}]')

    req.emit('close')
    expect(unsubscribePending).toHaveBeenCalled()
    expect(unsubscribeAborted).toHaveBeenCalled()
  })

  it('filters queue events to conversations accessible from the current session binding', async () => {
    let pendingSubscriber: ((conversationId: string) => void) | null = null
    let abortedSubscriber:
      | ((conversationId: string, messages: Array<{ id: string }>) => void)
      | null = null
    const { router, canAccessConversation } = createHarness({
      conversationBindings: {
        'conv-1': {
          initialAgentId: 'agent-1',
          activeAgentId: 'agent-1',
          rootHash: 'root-1',
        },
        'conv-2': {
          initialAgentId: 'agent-2',
          activeAgentId: 'agent-2',
          rootHash: 'root-2',
        },
      },
      subscribeToPendingBackgroundTaskResults: (fn) => {
        pendingSubscriber = fn
        return jest.fn()
      },
      subscribeToAbortedQueuedMessages: (fn) => {
        abortedSubscriber = fn as never
        return jest.fn()
      },
    })

    const route = router.resolve('GET', '/api/agent/queue/events')
    const req = createRequest({
      method: 'GET',
      url: '/api/agent/queue/events',
      headers: {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    })
    const res = createResponse()

    await route?.handler(req as never, res as never, {})
    if (!pendingSubscriber || !abortedSubscriber) {
      throw new Error('expected queue event subscribers to be registered')
    }
    const emitPending = pendingSubscriber as (conversationId: string) => void
    const emitAborted = abortedSubscriber as (
      conversationId: string,
      messages: Array<{ id: string }>,
    ) => void
    emitPending('conv-1')
    emitPending('conv-2')
    emitAborted('conv-1', [{ id: 'u1' }])
    emitAborted('conv-2', [{ id: 'u2' }])
    await Promise.resolve()

    expect(canAccessConversation).toHaveBeenCalledWith('conv-1', {
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
    })
    expect(canAccessConversation).toHaveBeenCalledWith('conv-2', {
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
    })
    expect(res.rawBody).toContain('"conversationId":"conv-1"')
    expect(res.rawBody).toContain('"messages":[{"id":"u1"}]')
    expect(res.rawBody).not.toContain('"conversationId":"conv-2"')
    expect(res.rawBody).not.toContain('"messages":[{"id":"u2"}]')
  })

  it('authorizes abort by run conversation binding instead of workspaceId', async () => {
    const abortRun = jest.fn().mockResolvedValue({
      found: true,
      status: 'aborted',
    })
    const { router, canAccessRun } = createHarness({
      abortRun,
      getRun: jest.fn().mockResolvedValue({
        runId: 'run-1',
        conversationId: 'conv-1',
        status: 'running',
      }),
    })

    const rejected = await dispatch(
      router,
      'POST',
      '/api/agent/abort/run-1',
      { workspaceId: 'ws-a' },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )
    expect(rejected.statusCode).toBe(400)

    const res = await dispatch(
      router,
      'POST',
      '/api/agent/abort/run-1',
      {},
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(canAccessRun).toHaveBeenCalledWith('run-1', {
      activeAgentId: 'agent-1',
      rootHash: 'root-1',
    })
    expect(abortRun).toHaveBeenCalledWith('run-1')
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      runId: 'run-1',
      status: 'aborted',
    })
  })
})

function createAgentRoutesContext(): AgentRoutesContext {
  return {
    getRun: jest.fn(),
    getRunEvents: jest.fn(),
    getAgentState: jest.fn(),
    sseHub: new WebSseHub(),
    abortRun: jest.fn(),
    runAgent: jest.fn(),
    compactConversation: jest.fn(),
    buildContextBreakdown: jest.fn(),
    approveToolCall: jest.fn(),
    rejectToolCall: jest.fn(),
    abortToolCall: jest.fn(),
    peekPendingUserMessages: jest.fn(),
    enqueueUserMessage: jest.fn(),
    removePendingUserMessage: jest.fn(),
    subscribeToPendingBackgroundTaskResults: jest.fn(() => jest.fn()),
    subscribeToAbortedQueuedMessages: jest.fn(() => jest.fn()),
    resolveAgentRouteBinding: jest.fn(),
    canAccessConversation: jest.fn(),
    canStartConversation: jest.fn(),
    canAccessRun: jest.fn(),
  }
}

function createHarness(
  overrides: Partial<AgentRoutesContext> & {
    binding?: {
      activeAgentId: string
      rootHash: string
    }
    conversationBindings?: Record<string, ChatWebBinding | null>
  } = {},
) {
  const router = new WebRouter()
  const context = createAgentRoutesContext()
  const resolveAgentRouteBinding = jest
    .fn()
    .mockImplementation((sessionId: string | null) => {
      if (!sessionId) {
        return {
          ok: false as const,
          statusCode: 401,
          body: {
            error: {
              code: 'session_expired',
              message: 'The web session has expired.',
            },
          },
        }
      }

      return {
        ok: true as const,
        binding: overrides.binding ?? {
          activeAgentId: 'agent-1',
          rootHash: 'root-1',
        },
      }
    })
  const canAccessConversation = jest
    .fn()
    .mockImplementation(
      async (
        conversationId: string,
        binding: { activeAgentId: string; rootHash: string },
      ) => {
        if (overrides.conversationBindings) {
          return (
            overrides.conversationBindings[conversationId]?.rootHash ===
            binding.rootHash
          )
        }
        return true
      },
    )
  const canAccessRun = jest
    .fn()
    .mockImplementation(async (runId: string, binding) => {
      const run = await Promise.resolve(
        (overrides.getRun ?? context.getRun)(runId),
      )
      if (!run) {
        return false
      }
      return canAccessConversation(run.conversationId, binding)
    })
  const canStartConversation = jest
    .fn()
    .mockImplementation((conversationId: string, binding) =>
      canAccessConversation(conversationId, binding),
    )

  registerAgentRoutes(router, {
    ...context,
    ...overrides,
    resolveAgentRouteBinding,
    canAccessConversation:
      overrides.canAccessConversation ?? canAccessConversation,
    canStartConversation:
      overrides.canStartConversation ?? canStartConversation,
    canAccessRun: overrides.canAccessRun ?? canAccessRun,
  })

  return {
    router,
    resolveAgentRouteBinding,
    canAccessConversation:
      overrides.canAccessConversation ?? canAccessConversation,
    canAccessRun: overrides.canAccessRun ?? canAccessRun,
  }
}

function createRequest({
  method,
  url,
  headers,
  body,
}: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const stream = Readable.from(chunks) as Readable &
    EventEmitter & {
      method?: string
      url?: string
      headers: Record<string, string>
    }
  stream.method = method
  stream.url = url
  stream.headers = headers ?? {}
  return stream
}

async function dispatch(
  router: WebRouter,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const resolved = router.resolve(method, url)
  if (!resolved) {
    throw new Error(`missing route: ${method} ${url}`)
  }
  const req = createRequest({ method, url, body, headers })
  const res = createResponse()
  await resolved.handler(req as never, res as never, resolved.params)
  return res
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    setHeader: (_name: string, _value: string) => void
    end: (chunk?: string) => void
    write: (chunk: string) => void
    flushHeaders?: () => void
    jsonBody: unknown
    rawBody: string
  }
  response.statusCode = 200
  response.writableEnded = false
  response.setHeader = () => {}
  response.write = (chunk) => {
    rawBody += chunk
  }
  response.end = (chunk) => {
    if (chunk) {
      rawBody += chunk
    }
    response.writableEnded = true
  }
  response.flushHeaders = () => {}
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition not met')
}
