/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'

import type { App } from 'obsidian'

import { ChatManager } from '../../database/json/chat/ChatManager'
import { CHAT_SCHEMA_VERSION } from '../../database/json/chat/types'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { AgentEventStore } from '../agent/agentEventStore'
import type { AgentService } from '../agent/service'

import { registerWebServerRoutes } from './registerWebServerRoutes'
import { WEB_SESSION_HEADER } from './routes/authRoutes'
import type { WebChatConversation } from './webAgentTypes'
import type { WebHttpServer } from './WebHttpServer'
import { WebRouter } from './WebRouter'
import { WebSseHub } from './WebSseHub'

const mockResolveAgentContext = jest.fn()

jest.mock('./shareTokenPepperStore', () => ({
  loadOrCreateShareTokenPepper: jest.fn(() => 'test-pepper'),
}))

jest.mock('./webAgentContextResolver', () => ({
  createWebAgentContextResolver: jest.fn(() => ({
    resolve: (input: unknown) => mockResolveAgentContext(input),
    canSwitch: jest.fn(),
  })),
}))

describe('registerWebServerRoutes runtime boundary', () => {
  it('defers Node path loading until desktop route registration runs', () => {
    const source = readFileSync(
      path.join(__dirname, 'registerWebServerRoutes.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:path'/)
    expect(source).toContain('loadDesktopNodeModuleSync')
  })
})

describe('registerWebServerRoutes legacy external-agent web binding repair', () => {
  beforeEach(() => {
    mockResolveAgentContext.mockReset()
  })

  it('repairs a missing binding on an external-agent conversation and grants access', async () => {
    const conversation = makeConversation({
      id: 'legacy-web-conversation',
      origin: 'external-agent',
      agentInstanceId: 'agent-current',
    })
    const harness = createHarness([conversation])

    try {
      const response = await dispatchAgentState(harness.router, conversation.id)

      expect(response.statusCode).toBe(200)
      expect(harness.getState).toHaveBeenCalledWith(conversation.id)
      expect(harness.updateChat).toHaveBeenCalledWith(
        conversation.id,
        {
          webBinding: {
            initialAgentId: 'agent-current',
            activeAgentId: 'agent-current',
            rootHash: 'root-current',
            accessState: 'active',
            updatedAt: expect.any(Number),
          },
        },
        { touchUpdatedAt: false },
      )
      expect(
        harness.getConversation(conversation.id)?.webBinding,
      ).toMatchObject({
        initialAgentId: 'agent-current',
        activeAgentId: 'agent-current',
        rootHash: 'root-current',
        accessState: 'active',
      })
    } finally {
      await harness.dispose()
    }
  })

  it('rejects a desktop conversation without a binding', async () => {
    const conversation = makeConversation({
      id: 'desktop-conversation',
      origin: 'user',
    })
    const harness = createHarness([conversation])

    try {
      const response = await dispatchAgentState(harness.router, conversation.id)

      expect(response.statusCode).toBe(404)
      expect(harness.updateChat).not.toHaveBeenCalled()
      expect(harness.getState).not.toHaveBeenCalled()
      expect(
        harness.getConversation(conversation.id)?.webBinding,
      ).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('rejects an unbound external-agent conversation without web ownership', async () => {
    const conversation = makeConversation({
      id: 'external-task-conversation',
      origin: 'external-agent',
      assistantId: 'assistant-current',
    })
    const harness = createHarness([conversation])

    try {
      const response = await dispatchAgentState(harness.router, conversation.id)

      expect(response.statusCode).toBe(404)
      expect(harness.updateChat).not.toHaveBeenCalled()
      expect(harness.getState).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('does not lock an already-bound conversation during access checks', async () => {
    const conversation = makeConversation({
      id: 'bound-current-conversation',
      origin: 'external-agent',
      agentInstanceId: 'agent-current',
      webBinding: {
        initialAgentId: 'agent-current',
        activeAgentId: 'agent-current',
        rootHash: 'root-current',
        accessState: 'active',
        updatedAt: 123,
      },
    })
    const lock = jest.spyOn(ChatManager, 'withConversationLock')
    const harness = createHarness([conversation])

    try {
      const response = await dispatchAgentState(harness.router, conversation.id)

      expect(response.statusCode).toBe(200)
      expect(lock).not.toHaveBeenCalled()
    } finally {
      lock.mockRestore()
      await harness.dispose()
    }
  })

  it('does not take over an external-agent conversation with a different binding', async () => {
    const existingBinding = {
      initialAgentId: 'agent-original',
      activeAgentId: 'agent-original',
      rootHash: 'root-original',
      accessState: 'active' as const,
      updatedAt: 123,
    }
    const conversation = makeConversation({
      id: 'bound-web-conversation',
      origin: 'external-agent',
      webBinding: existingBinding,
    })
    const harness = createHarness([conversation])

    try {
      const response = await dispatchAgentState(harness.router, conversation.id)

      expect(response.statusCode).toBe(404)
      expect(harness.updateChat).not.toHaveBeenCalled()
      expect(harness.getState).not.toHaveBeenCalled()
      expect(harness.getConversation(conversation.id)?.webBinding).toEqual(
        existingBinding,
      )
    } finally {
      await harness.dispose()
    }
  })

  it('allows only one web agent to claim an unbound legacy conversation', async () => {
    const conversation = makeConversation({
      id: 'concurrent-legacy-web-conversation',
      origin: 'external-agent',
      agentInstanceId: 'agent-shared',
    })
    const harness = createHarness([conversation])
    const bindingsBySession = new Map([
      ['session-a', { agentId: 'agent-shared', rootHash: 'root-a' }],
      ['session-b', { agentId: 'agent-shared', rootHash: 'root-b' }],
    ])
    mockResolveAgentContext.mockImplementation((input: unknown) => {
      const sessionId = (input as { sessionId?: string }).sessionId ?? ''
      const binding = bindingsBySession.get(sessionId)
      if (!binding) {
        return {
          ok: false,
          code: 'unauthenticated',
          message: 'No active web session.',
        }
      }
      return resolvedAgentContext(sessionId, binding.agentId, binding.rootHash)
    })

    try {
      const [responseA, responseB] = await Promise.all([
        dispatchAgentState(harness.router, conversation.id, 'session-a'),
        dispatchAgentState(harness.router, conversation.id, 'session-b'),
      ])

      expect([responseA.statusCode, responseB.statusCode].sort()).toEqual([
        200, 404,
      ])
      expect(harness.updateChat).toHaveBeenCalledTimes(1)
      expect(harness.getState).toHaveBeenCalledTimes(1)
      const winner = responseA.statusCode === 200 ? 'a' : 'b'
      expect(
        harness.getConversation(conversation.id)?.webBinding,
      ).toMatchObject({
        initialAgentId: 'agent-shared',
        activeAgentId: 'agent-shared',
        rootHash: `root-${winner}`,
        accessState: 'active',
      })
    } finally {
      await harness.dispose()
    }
  })
})

function makeConversation(
  overrides: Partial<WebChatConversation>,
): WebChatConversation {
  return {
    id: 'conversation',
    title: 'Conversation',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: CHAT_SCHEMA_VERSION,
    ...overrides,
  }
}

function createHarness(seed: WebChatConversation[]) {
  const conversations = new Map(
    seed.map((conversation) => [conversation.id, { ...conversation }]),
  )
  const findById = jest.fn(async (conversationId: string) =>
    conversations.get(conversationId),
  )
  const updateChat = jest.fn(
    async (conversationId: string, patch: Record<string, unknown>) => {
      const current = conversations.get(conversationId)
      if (!current) return null
      const updated = { ...current, ...patch }
      conversations.set(conversationId, updated)
      return updated
    },
  )
  const chatManager = {
    findById,
    updateChat,
    listChats: jest.fn(async () => []),
    createChat: jest.fn(),
    deleteChat: jest.fn(),
  } as unknown as ChatManager
  const getState = jest.fn((conversationId: string) => ({
    conversationId,
    status: 'idle',
    messages: [],
  }))
  const agentService = {
    getState,
  } as unknown as AgentService
  const agentEventStore = {
    getRun: jest.fn(() => null),
    getRunEvents: jest.fn(() => []),
    listRunsByAgent: jest.fn(() => []),
    deleteRunsByAgent: jest.fn(),
  } as unknown as AgentEventStore
  const settings = {
    yolo: { baseDir: 'YOLO' },
    assistants: [],
    workspaceAgents: [],
    webRuntime: {
      enabled: true,
      maxConcurrentAgentRuns: 1,
    },
  } as unknown as YoloSettings
  const router = new WebRouter()
  const server = { router } as WebHttpServer
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getName: () => 'test-vault',
    },
    workspace: {},
    fileManager: {},
  } as unknown as App

  mockResolveAgentContext.mockReturnValue(
    resolvedAgentContext('session-current', 'agent-current', 'root-current'),
  )

  const registered = registerWebServerRoutes({
    server,
    app,
    plugin: {
      app,
      manifest: {},
      setSettings: jest.fn(async () => true),
      openApplyReview: jest.fn(async () => true),
    },
    chatManager,
    agentEventStore,
    sseHub: new WebSseHub(),
    getSettings: () => settings,
    host: '127.0.0.1',
    port: 18900,
    getAgentService: () => agentService,
    getMcpManager: jest.fn(async () => ({}) as never),
  })

  return {
    router,
    updateChat,
    getState,
    getConversation: (conversationId: string) =>
      conversations.get(conversationId),
    dispose: registered.dispose,
  }
}

function resolvedAgentContext(
  sessionId: string,
  agentId: string,
  rootHash: string,
) {
  return {
    ok: true,
    context: {
      sessionId,
      tokenScope: { kind: 'agent', agentId },
      activeAgent: {
        id: agentId,
        workspacePolicy: {
          workspaceRoot: '/',
          readAllowlist: [],
          readDenylist: [],
          writeDenylist: [],
        },
      },
      template: { id: 'template-current' },
      rootHash,
      allowedAgents: [
        {
          id: agentId,
          name: 'Current agent',
          agentModeAllowed: true,
        },
      ],
    },
  }
}

async function dispatchAgentState(
  router: WebRouter,
  conversationId: string,
  sessionId = 'session-current',
) {
  const url = `/api/agent/state?conversationId=${encodeURIComponent(conversationId)}`
  const resolved = router.resolve('GET', url)
  if (!resolved) throw new Error(`missing route: GET ${url}`)
  const request = Readable.from([]) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
  }
  request.method = 'GET'
  request.url = url
  request.headers = { [WEB_SESSION_HEADER]: sessionId }
  const response = createResponse()
  await resolved.handler(request as never, response as never, resolved.params)
  return response
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    setHeader: (_name: string, _value: string) => void
    end: (chunk?: string) => void
  }
  response.statusCode = 200
  response.writableEnded = false
  response.setHeader = () => {}
  response.end = (chunk) => {
    if (chunk) rawBody += chunk
    response.writableEnded = true
  }
  Object.defineProperty(response, 'rawBody', {
    get: () => rawBody,
  })
  return response
}
