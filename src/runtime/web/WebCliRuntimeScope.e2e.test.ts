/**
 * BS 模式 e2e：真实 HTTP 服务器（chat-runtime 路由 + 状态化 fake runtime）+
 * WebCliRuntimeScope（真实 fetch/SSE）走完整线上协议，验证 scope 的会话
 * 发现/控制器快照/发送往返映射。
 */
/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  type ChatRuntime,
  type ChatRuntimeEvent,
  ChatRuntimeEventSequencer,
  type ChatRuntimeSnapshot,
  chatCommandOk,
} from '../../core/chat-runtime/contract'
import type { CliSessionRef } from '../../core/cli-runtime/types'
import {
  closeChatRuntimeSessionStreams,
  disposeChatRuntimeRouteCaches,
  registerChatRuntimeRoutes,
} from '../../core/web-server/routes/chatRuntimeRoutes'
import { WebRouter } from '../../core/web-server/WebRouter'

import { createWebCliRuntimeScope } from './WebCliRuntimeScope'

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

function createFakeChatRuntime(conversationId: string) {
  const listeners = new Set<(event: ChatRuntimeEvent) => void>()
  const sequencer = new ChatRuntimeEventSequencer(
    `scope-e2e:${conversationId}`,
    conversationId,
    null,
  )
  let messages: ChatRuntimeSnapshot['messages'] = []
  let runState: ChatRuntimeSnapshot['runState'] = 'idle'
  const emit = (event: ChatRuntimeEvent): void => {
    listeners.forEach((listener) => listener(event))
  }
  const buildSnapshot = (): ChatRuntimeSnapshot => ({
    replayCursor: sequencer.getCursor(),
    runId: sequencer.runId,
    conversationId,
    sessionRef: null,
    messages,
    runState,
    error: null,
    compactionBoundaries: [],
    configuration: null,
    capabilities: {
      transport: 'local',
      hostHistory: { supported: true, info: { source: 'gateway' } },
      providerSessions: { supported: true, info: { scope: 'provider-native' } },
      agentPlanMode: { supported: true },
      approvalFlow: { supported: true },
      subagents: { supported: false },
      skills: { supported: true },
      modelConfig: { supported: true },
      reasoningEffort: { supported: true },
      compaction: { supported: true },
      contextUsage: { supported: true },
      rewrite: { supported: true },
      sessionPin: { supported: true },
      compact: { supported: false },
      mcpSharing: { supported: false },
      moa: { supported: false },
      commands: { supported: true, info: { commands: [] } },
      cliSurface: { supported: true },
    },
  })
  const runtime: ChatRuntime = {
    runtimeId: 'claude-code',
    capabilities: buildSnapshot().capabilities,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(sequencer.next('snapshot', buildSnapshot()))
      return () => listeners.delete(listener)
    },
    getSnapshot: buildSnapshot,
    sendTurn: async (input) => {
      runState = 'running'
      emit(sequencer.next('run.state', { state: 'running' }))
      messages = [
        ...messages,
        {
          role: 'assistant',
          id: 'reply-1',
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- e2e fake 中 content 恒为字符串，String() 仅做防御
          content: `Re: ${String(input.content)}`,
        } as ChatRuntimeSnapshot['messages'][number],
      ]
      emit(
        sequencer.next('message.upsert', {
          message: messages[messages.length - 1],
        }),
      )
      runState = 'completed'
      emit(sequencer.next('run.state', { state: 'completed' }))
      emit(
        sequencer.next('submission.accepted', {
          requestId: input.requestId ?? '',
          messageId: input.messageId ?? '',
        }),
      )
      return {
        requestId: input.requestId ?? 'req-1',
        messageId: input.messageId ?? 'msg-1',
        getState: () => ({ status: 'received' as const, receivedAt: 0 }),
        acceptance: new Promise(() => undefined),
        cancel: async () => chatCommandOk(),
      }
    },
    rewriteTurn: async () => chatCommandOk(),
    rollbackToTurn: async () => chatCommandOk(),
    cancel: async () => chatCommandOk(),
    respondApproval: async () => chatCommandOk(),
    respondQuestion: async () => chatCommandOk(),
    updateConfiguration: async () => chatCommandOk(),
    updatePermissionProfile: async () => chatCommandOk(),
    setSessionPinned: async () => chatCommandOk(),
    compact: async () => chatCommandOk(),
    listSessions: async () => ({
      ok: true as const,
      sessions: [
        {
          ref: { runtimeId: 'claude-code', nativeSessionId: 'web-1' },
          title: 'Web session',
          updatedAt: 5,
          isPinned: true,
        },
      ],
    }),
    openSession: async () => chatCommandOk(),
    renameSession: async () => chatCommandOk(),
    deleteSession: async () => chatCommandOk(),
    setSessionTitle: async () => chatCommandOk(),
    readSubagent: async () => ({ ok: true as const, messages: [] }),
    watchSubagent: async () => ({
      ok: true as const,
      unsubscribe: () => undefined,
    }),
    dispose: async () => undefined,
  }
  // streamSubscriberCount 供会话撤销测试观察重连行为：撤销后不得产生新的
  // 流订阅。挂在返回对象上而非 runtime 上（runtime 有 ChatRuntime 类型约束）。
  return { runtime, streamSubscriberCount: () => listeners.size }
}

describe('WebCliRuntimeScope BS-mode e2e（真实 HTTP + SSE）', () => {
  it('discovers sessions and streams a turn reply through the contract protocol', async () => {
    const conversationId = `scope-e2e-${Date.now()}`
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

    let webScope: ReturnType<typeof createWebCliRuntimeScope> | null = null
    try {
      webScope = createWebCliRuntimeScope({
        baseUrl: `http://127.0.0.1:${port}`,
        fetchImpl: (url, init) => globalThis.fetch(url, init),
      })
      // master 的 CliSessionService 类无 discoverSessions/setPinned（backup
      // 接口有）；web scope 的 sessionService 对象实际提供，经局部接口收窄。
      const sessionService = webScope.sessionService as unknown as {
        discoverSessions(): Promise<{
          sessions: Array<{
            ref: CliSessionRef
            title: string
            updatedAt: number
            isPinned: boolean
            hasOverlay: boolean
          }>
        }>
        setPinned(ref: CliSessionRef, pinned: boolean): Promise<void>
      }

      const discovery = await sessionService.discoverSessions()
      expect(discovery.sessions[0]).toMatchObject({
        ref: { runtimeId: 'claude-code', nativeSessionId: 'web-1' },
        title: 'Web session',
        isPinned: true,
        hasOverlay: false,
      })

      const controller = webScope.selectConversationRuntime('claude-code')
      await controller.sendTurn({
        userMessage: {
          role: 'user',
          id: 'wu1',
          content: null,
          promptContent: 'web hello',
          mentionables: [],
        } as never,
        content: 'web hello',
      })

      await waitFor(
        () =>
          controller
            .getSnapshot()
            .messages.some((message) => message.id === 'reply-1'),
        'reply via SSE',
      )
      expect(controller.getSnapshot().runState).toBe('completed')

      await sessionService.setPinned(
        { runtimeId: 'claude-code', nativeSessionId: 'web-1' },
        false,
      )
    } finally {
      await webScope?.dispose()
      await new Promise((resolve) => setTimeout(resolve, 20))
      ;(server as Server & { closeAllConnections?: () => void })
        .closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('terminates the stream on session revoke (session_closed) without reconnecting', async () => {
    // chat-runtime 路由的 runtimeCache 是模块级且按空 conversationId 键控，
    // 上一个用例的 fake runtime 会被本用例的流请求命中——先清缓存隔离。
    await disposeChatRuntimeRouteCaches()
    const conversationId = `scope-revoke-${Date.now()}`
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

    let webScope: ReturnType<typeof createWebCliRuntimeScope> | null = null
    try {
      webScope = createWebCliRuntimeScope({
        baseUrl: `http://127.0.0.1:${port}`,
        sessionId: 'e2e-session-1',
        fetchImpl: (url, init) => globalThis.fetch(url, init),
      })
      const controller = webScope.selectConversationRuntime('claude-code')
      // 连接建立后服务端注册了该会话的流；撤销会话 → 服务端写 session_closed
      // 命名事件并关闭 → 客户端 transport 必须解析该事件并进入终态 error，
      // 而不是把后续断流当成可重连的瞬时错误无限退避重连。
      await waitFor(
        () => fake.streamSubscriberCount() > 0,
        'stream registered',
      )
      closeChatRuntimeSessionStreams('e2e-session-1', 'token_revoked')

      await waitFor(
        () => controller.getSnapshot().runState === 'error',
        'snapshot runState error after session_closed',
      )
      expect(controller.getSnapshot().error).toContain('session has been closed')

      // 撤销后不再重连：等待一个退避窗口，确认没有新的流订阅。
      const subscriptionsAtRevoke = fake.streamSubscriberCount()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(fake.streamSubscriberCount()).toBe(subscriptionsAtRevoke)
    } finally {
      await webScope?.dispose()
      await new Promise((resolve) => setTimeout(resolve, 20))
      ;(server as Server & { closeAllConnections?: () => void })
        .closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
