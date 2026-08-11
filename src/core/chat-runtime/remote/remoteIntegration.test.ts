/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，直接使用 node 内置模块构造本地服务器 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { registerChatRuntimeRoutes } from '../../web-server/routes/chatRuntimeRoutes'
import { WebRouter } from '../../web-server/WebRouter'
import {
  type ChatRuntime,
  type ChatRuntimeCapabilities,
  type ChatRuntimeEvent,
  ChatRuntimeEventSequencer,
  type ChatRuntimeSnapshot,
  chatCommandOk,
  chatCommandUnsupported,
} from '../contract'

const TEST_CAPABILITIES: ChatRuntimeCapabilities = {
  transport: 'local',
  hostHistory: { supported: true, info: { source: 'gateway' } },
  providerSessions: { supported: false },
  agentPlanMode: { supported: true },
  approvalFlow: { supported: true },
  subagents: { supported: false },
  skills: { supported: true },
  modelConfig: { supported: true },
  reasoningEffort: { supported: true },
  compaction: { supported: true },
  contextUsage: { supported: true },
  rewrite: { supported: false },
  sessionPin: { supported: false },
  compact: { supported: false },
  mcpSharing: { supported: false },
  moa: { supported: false },
  commands: { supported: false },
  cliSurface: { supported: false },
}

function createFakeChatRuntime(conversationId: string) {
  const instanceId = `instance-${Math.random().toString(36).slice(2)}`
  const listeners = new Set<(event: ChatRuntimeEvent) => void>()
  const sequencer = new ChatRuntimeEventSequencer(
    `fake:${conversationId}`,
    conversationId,
    null,
  )
  const sentTurns: Array<{ content: string; requestId?: string }> = []
  const cancelled: Array<{ requestId?: string }> = []
  const approved: Array<{ requestId: string }> = []
  const configured: Array<{ modelId?: string | null }> = []
  const runtime: ChatRuntime = {
    runtimeId: 'claude-code',
    capabilities: TEST_CAPABILITIES,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: (): ChatRuntimeSnapshot => ({
      replayCursor: sequencer.getCursor(),
      runId: sequencer.runId,
      conversationId,
      sessionRef: null,
      messages: [],
      runState: 'idle',
      error: null,
      compactionBoundaries: [],
      configuration: null,
      capabilities: TEST_CAPABILITIES,
    }),
    sendTurn: async (input) => {
      sentTurns.push({
        content: typeof input.content === 'string' ? input.content : '',
        requestId: input.requestId,
      })
      const requestId = input.requestId ?? `req-${sentTurns.length}`
      const messageId = input.messageId ?? `msg-${sentTurns.length}`
      return {
        requestId,
        messageId,
        getState: () => ({ status: 'received', receivedAt: 0 }),
        acceptance: Promise.resolve({ status: 'received', receivedAt: 0 }),
        cancel: async () => chatCommandOk(),
      }
    },
    rewriteTurn: async () => chatCommandUnsupported('rewrite'),
    rollbackToTurn: async () => chatCommandUnsupported('rewrite'),
    cancel: async (requestId) => {
      cancelled.push({ requestId })
      return chatCommandOk()
    },
    respondApproval: async (response) => {
      approved.push({ requestId: response.requestId })
      return chatCommandOk()
    },
    respondQuestion: async () => chatCommandOk(),
    updateConfiguration: async (update) => {
      configured.push({ modelId: update.modelId })
      return chatCommandOk()
    },
    updatePermissionProfile: async () => chatCommandOk(),
    setSessionPinned: async () => chatCommandOk(),
    compact: async () => chatCommandOk(),
    listSessions: async () => ({ ok: true, sessions: [] }),
    openSession: async () => chatCommandOk(),
    renameSession: async () => chatCommandOk(),
    deleteSession: async () => chatCommandOk(),
    setSessionTitle: async () => chatCommandOk(),
    readSubagent: async () => ({ ok: true, messages: [] }),
    watchSubagent: async () => ({ ok: true, unsubscribe: () => undefined }),
    dispose: async () => undefined,
  }
  const emit = (type: 'run.state', payload: { state: string }): void => {
    const event = sequencer.next(type, payload as never)
    listeners.forEach((listener) => listener(event))
  }
  const emitSubmissionAccepted = (
    requestId: string,
    messageId: string,
  ): void => {
    const event = sequencer.next('submission.accepted', {
      requestId,
      messageId,
    })
    listeners.forEach((listener) => listener(event))
  }
  return {
    runtime,
    instanceId,
    sentTurns,
    cancelled,
    approved,
    configured,
    emit,
    emitSubmissionAccepted,
    getCursor: () => sequencer.getCursor(),
  }
}

function createRequest({
  method,
  url,
  body,
}: {
  method: string
  url: string
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
  stream.headers = {}
  return stream
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    flushHeaders?: () => void
    setHeader: (name: string, value: string) => void
    end: (chunk?: string) => void
    write: (chunk: string) => boolean
    rawBody: string
  }
  response.statusCode = 200
  response.writableEnded = false
  response.setHeader = () => {}
  response.write = (chunk) => {
    rawBody += chunk
    return true
  }
  response.end = (chunk) => {
    if (chunk) rawBody += chunk
    response.writableEnded = true
  }
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
) {
  const resolved = router.resolve(method, url)
  if (!resolved) throw new Error(`missing route: ${method} ${url}`)
  const req = createRequest({ method, url, body })
  const res = createResponse()
  await resolved.handler(req as never, res as never, resolved.params)
  return { req, res }
}

const sseDataLines = (rawBody: string): string[] =>
  rawBody
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))

describe('chat runtime remote integration', () => {
  it('streams snapshot-first envelopes, forwards events, replays by cursor, and routes commands by conversationId', async () => {
    const router = new WebRouter()
    const createdInstances: string[] = []
    const first = createFakeChatRuntime('conv-1')
    const instanceById = new Map<
      string,
      ReturnType<typeof createFakeChatRuntime>
    >()
    instanceById.set(first.instanceId, first)
    registerChatRuntimeRoutes(router, {
      getChatRuntime: (runtimeId, conversationId) => {
        if (runtimeId !== 'claude-code' || conversationId !== 'conv-1') {
          return null
        }
        createdInstances.push(first.instanceId)
        return first.runtime
      },
    })

    // 1. 首连：心跳建立 + 事件按 envelope 下发。
    const stream1 = await dispatch(
      router,
      'GET',
      '/api/chat-runtime/claude-code/stream?cursor=0&conversationId=conv-1',
    )
    first.emit('run.state', { state: 'running' })
    const firstData = sseDataLines(stream1.res.rawBody)
    expect(firstData.length).toBeGreaterThan(0)
    const firstEnvelope = JSON.parse(firstData[0] ?? '{}') as {
      protocolVersion: number
      type: string
    }
    expect(firstEnvelope.protocolVersion).toBe(1)
    expect(firstEnvelope.type).toBe('run.state')

    // 2. POST /turn → fake 收到提交；服务端订阅到 submission.accepted 并下发。
    const turn = await dispatch(
      router,
      'POST',
      '/api/chat-runtime/claude-code/turn',
      {
        conversationId: 'conv-1',
        content: 'hello',
        requestId: 'req-1',
        messageId: 'msg-1',
      },
    )
    expect(turn.res.statusCode).toBe(202)
    expect(first.sentTurns).toHaveLength(1)
    expect(first.sentTurns[0]?.content).toBe('hello')
    first.emitSubmissionAccepted('req-1', 'native-1')
    const acceptedLines = sseDataLines(stream1.res.rawBody)
    expect(
      acceptedLines.some((line) =>
        line.includes('"type":"submission.accepted"'),
      ),
    ).toBe(true)

    // 3. /cancel /approval /config 带同一 conversationId → 同一实例。
    await dispatch(router, 'POST', '/api/chat-runtime/claude-code/cancel', {
      conversationId: 'conv-1',
      requestId: 'req-1',
    })
    await dispatch(router, 'POST', '/api/chat-runtime/claude-code/approval', {
      conversationId: 'conv-1',
      requestId: 'req-1',
      decision: 'approve_once',
    })
    await dispatch(router, 'POST', '/api/chat-runtime/claude-code/config', {
      conversationId: 'conv-1',
      modelId: 'model-x',
    })
    expect(first.cancelled).toHaveLength(1)
    expect(first.approved).toHaveLength(1)
    expect(first.configured).toHaveLength(1)
    expect(createdInstances.every((id) => id === first.instanceId)).toBe(true)

    // 4. native 不带 conversationId → 404。
    const nativeStream = await dispatch(
      router,
      'GET',
      '/api/chat-runtime/yolo/stream?cursor=0',
    )
    expect(nativeStream.res.statusCode).toBe(404)

    // 5. 断开后用 cursor=1 续传：只重放 seq 2 的 submission.accepted（不新增事件）。
    stream1.req.emit('close')
    const stream2 = await dispatch(
      router,
      'GET',
      '/api/chat-runtime/claude-code/stream?cursor=1&conversationId=conv-1',
    )
    const replayed = sseDataLines(stream2.res.rawBody)
    expect(replayed.length).toBeGreaterThan(0)
    expect(
      replayed.some((line) => line.includes('"type":"submission.accepted"')),
    ).toBe(true)
    stream2.req.emit('close')
  })
})
