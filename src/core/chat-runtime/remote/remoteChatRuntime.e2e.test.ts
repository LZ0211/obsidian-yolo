/**
 * BS 模式真实 e2e：不经 Obsidian，直接起本地 HTTP 服务器（chat-runtime 路由 +
 * 状态化 fake runtime），Web 端用 createWebRemoteTransport（真实 fetch/SSE）
 * + RemoteChatRuntimeAdapter 走完整线上协议。
 */
/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，直接使用 node 内置模块构造本地服务器 */
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createWebRemoteTransport } from '../../../runtime/web/remoteChatTransport'
import { registerChatRuntimeRoutes } from '../../web-server/routes/chatRuntimeRoutes'
import { WebRouter } from '../../web-server/WebRouter'
import {
  type ChatRuntime,
  type ChatRuntimeEvent,
  ChatRuntimeEventSequencer,
  type ChatRuntimeSnapshot,
  type ChatSessionRef,
  chatCommandOk,
} from '../contract'

import { RemoteChatRuntimeAdapter } from './RemoteChatRuntimeAdapter'

// ── 服务器侧状态化 fake runtime ──────────────────────────────────────────────

function createFakeChatRuntime(conversationId: string) {
  const listeners = new Set<(event: ChatRuntimeEvent) => void>()
  const sequencer = new ChatRuntimeEventSequencer(
    `e2e:${conversationId}`,
    conversationId,
    null,
  )
  const sessions = [
    {
      ref: { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' },
      title: 'Fix login',
      updatedAt: 5,
      isPinned: true,
    },
  ]
  const calls: string[] = []
  let sessionRef: ChatSessionRef | null = null
  let messages: ChatRuntimeSnapshot['messages'] = []

  const capabilities = {
    transport: 'local' as const,
    hostHistory: {
      supported: true as const,
      info: { source: 'gateway' as const },
    },
    providerSessions: {
      supported: true as const,
      info: { scope: 'provider-native' as const },
    },
    agentPlanMode: { supported: true as const },
    approvalFlow: { supported: true as const },
    subagents: { supported: false as const },
    skills: { supported: true as const },
    modelConfig: { supported: true as const },
    reasoningEffort: { supported: true as const },
    compaction: { supported: true as const },
    contextUsage: { supported: true as const },
    rewrite: { supported: true as const },
    sessionPin: { supported: true as const },
    compact: { supported: false as const },
    mcpSharing: { supported: false as const },
    moa: { supported: false as const },
    commands: { supported: true as const, info: { commands: [] } },
    cliSurface: { supported: true as const },
  }
  const buildSnapshot = (): ChatRuntimeSnapshot => ({
    replayCursor: sequencer.getCursor(),
    runId: sequencer.runId,
    conversationId,
    sessionRef,
    messages,
    runState: 'idle',
    error: null,
    compactionBoundaries: [],
    configuration: null,
    capabilities,
  })

  const emit = (event: ChatRuntimeEvent): void => {
    listeners.forEach((listener) => listener(event))
  }

  const runtime: ChatRuntime = {
    runtimeId: 'codex',
    capabilities,
    subscribe: (listener) => {
      listeners.add(listener)
      // 与真实 adapter 一致：订阅即先发 snapshot 帧。
      listener(sequencer.next('snapshot', buildSnapshot()))
      return () => listeners.delete(listener)
    },
    getSnapshot: buildSnapshot,
    sendTurn: async (input) => {
      calls.push(`turn:${input.requestId}`)
      messages = [
        ...messages,
        {
          role: 'user',
          id: input.messageId ?? 'msg',
          content: null,
          promptContent:
            typeof input.content === 'string'
              ? input.content
              : JSON.stringify(input.content),
          mentionables: [],
        },
      ]
      emit(sequencer.next('run.state', { state: 'running' }))
      emit(
        sequencer.next('submission.accepted', {
          requestId: input.requestId ?? '',
          messageId: input.messageId ?? '',
        }),
      )
      emit(sequencer.next('run.state', { state: 'completed' }))
      return {
        requestId: input.requestId ?? `req-${calls.length}`,
        messageId: input.messageId ?? `msg-${calls.length}`,
        getState: () => ({ status: 'received' as const, receivedAt: 0 }),
        acceptance: new Promise(() => undefined),
        cancel: async () => chatCommandOk(),
      }
    },
    rewriteTurn: async () => chatCommandOk(),
    rollbackToTurn: async () => chatCommandOk(),
    cancel: async (requestId) => {
      calls.push(`cancel:${requestId ?? ''}`)
      return chatCommandOk()
    },
    respondApproval: async () => chatCommandOk(),
    respondQuestion: async () => chatCommandOk(),
    updateConfiguration: async () => chatCommandOk(),
    updatePermissionProfile: async () => chatCommandOk(),
    setSessionPinned: async (ref, pinned) => {
      calls.push(`pin:${ref.nativeSessionId}:${pinned}`)
      return chatCommandOk()
    },
    compact: async () => chatCommandOk(),
    listSessions: async () => ({ ok: true as const, sessions }),
    openSession: async (ref) => {
      calls.push(`open:${ref.nativeSessionId}`)
      sessionRef = ref
      emit(sequencer.next('session.changed', { sessionRef: ref }))
      return chatCommandOk()
    },
    renameSession: async (ref, title) => {
      calls.push(`rename:${ref.nativeSessionId}:${title}`)
      return chatCommandOk()
    },
    deleteSession: async (ref) => {
      calls.push(`delete:${ref.nativeSessionId}`)
      return chatCommandOk()
    },
    setSessionTitle: async (ref, title) => {
      calls.push(`title:${ref.nativeSessionId}:${title}`)
      return chatCommandOk()
    },
    readSubagent: async () => ({ ok: true as const, messages: [] }),
    watchSubagent: async () => ({
      ok: true as const,
      unsubscribe: () => undefined,
    }),
    dispose: async () => undefined,
  }
  return { runtime, calls, sessions }
}

async function createE2eHarness() {
  const conversationId = `e2e-conv-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  const fake = createFakeChatRuntime(conversationId)
  const router = new WebRouter()
  registerChatRuntimeRoutes(router, {
    getChatRuntime: () => fake.runtime,
  })
  const server: Server = createServer((req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'
    const resolved = router.resolve(method, url)
    if (!resolved) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    void resolved.handler(req, res, resolved.params)
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
  return { server, fake, port, conversationId }
}

const waitFor = async (
  predicate: () => boolean,
  description: string,
  timeoutMs = 3000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`e2e condition timeout: ${description}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('chat runtime BS-mode e2e（真实 HTTP + Web RemoteTransport）', () => {
  it('drives a full CLI turn over the wire and resolves acceptance via SSE', async () => {
    const { server, fake, port, conversationId } = await createE2eHarness()
    let adapter: RemoteChatRuntimeAdapter | null = null
    try {
      const transport = createWebRemoteTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        // eslint-disable-next-line no-restricted-globals -- Node 测试环境的全局 fetch（Obsidian 内 requestUrl 禁令不适用）
        fetchImpl: fetch,
      })
      adapter = new RemoteChatRuntimeAdapter('codex', transport, conversationId)
      const seen: string[] = []
      adapter.subscribe((event) => seen.push(event.type))
      await waitFor(
        () => seen.includes('snapshot'),
        'initial stream connection',
      )

      const handle = await adapter.sendTurn({
        content: 'hello bs mode',
        baseRevision: 0,
        messageGeneration: 0,
        conversationId,
      })
      const acceptance = await handle.acceptance
      expect(acceptance.status).toBe('durably_accepted')
      await waitFor(
        () => seen.includes('submission.accepted'),
        'submission.accepted over SSE',
      )
      expect(seen).toEqual(
        expect.arrayContaining([
          'snapshot',
          'run.state',
          'submission.accepted',
        ]),
      )
      expect(fake.calls).toEqual(
        expect.arrayContaining([expect.stringMatching(/^turn:/)]),
      )

      const listResult = await adapter.listSessions()
      expect(listResult).toEqual({
        ok: true,
        sessions: [
          {
            ref: { runtimeId: 'codex', nativeSessionId: 'thread-1' },
            title: 'Fix login',
            updatedAt: 5,
            isPinned: true,
          },
        ],
      })

      const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
      expect(await adapter.openSession(ref)).toEqual({ ok: true })
      expect(await adapter.renameSession(ref, 'New title')).toEqual({
        ok: true,
      })
      expect(await adapter.deleteSession(ref)).toEqual({ ok: true })
      expect(await adapter.setSessionPinned(ref, false)).toEqual({ ok: true })
      expect(fake.calls).toEqual(
        expect.arrayContaining([
          'open:thread-1',
          'rename:thread-1:New title',
          'delete:thread-1',
          'pin:thread-1:false',
        ]),
      )

      await adapter.dispose()
    } finally {
      adapter?.dispose()
      // 给服务端一点时间感知客户端断开，再强制回收残留连接，避免句柄挂起。
      await new Promise((resolve) => setTimeout(resolve, 20))
      ;(
        server as Server & { closeAllConnections?: () => void }
      ).closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
