/* eslint-disable import/no-nodejs-modules -- test harness uses Node streams */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { type App, TFolder } from 'obsidian'

import type { ChatManager } from '../../database/json/chat/ChatManager'
import { CHAT_SCHEMA_VERSION } from '../../database/json/chat/types'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { AgentEventStore } from '../agent/agentEventStore'
import type { AgentService } from '../agent/service'
import { createCliChatRuntime } from '../chat-runtime/cli/createCliChatRuntime'
import type { CliRuntimeScope } from '../cli-runtime/coordinator'

import { registerWebServerRoutes } from './registerWebServerRoutes'
import { WEB_SESSION_HEADER } from './routes/authRoutes'
import { disposeChatRuntimeRouteCaches } from './routes/chatRuntimeRoutes'
import type { WebChatConversation } from './webAgentTypes'
import type { WebHttpServer } from './WebHttpServer'
import { WebRouter } from './WebRouter'
import { WebSseHub } from './WebSseHub'

jest.mock('./shareTokenPepperStore', () => ({
  loadOrCreateShareTokenPepper: jest.fn(() => 'test-pepper'),
}))

jest.mock('./webAgentContextResolver', () => ({
  createWebAgentContextResolver: jest.fn(() => ({
    resolve: ({ sessionId }: { sessionId: string | null }) =>
      sessionId === 'session-current'
        ? {
            ok: true,
            context: {
              sessionId: 'session-current',
              tokenScope: { kind: 'agent', agentId: 'agent-current' },
              activeAgent: {
                id: 'agent-current',
                workspacePolicy: {
                  workspaceRoot: '/',
                  readAllowlist: [],
                  readDenylist: [],
                  writeDenylist: [],
                },
              },
              template: { id: 'template-current' },
              rootHash: 'root-current',
              allowedAgents: [{ id: 'agent-current' }],
            },
          }
        : {
            ok: false,
            code: 'unauthenticated',
            message: 'session expired',
          },
    canSwitch: jest.fn(),
  })),
}))

jest.mock('../chat-runtime/cli/createCliChatRuntime', () => ({
  createCliChatRuntime: jest.fn(),
}))

const mockCreateCliChatRuntime = jest.mocked(createCliChatRuntime)

describe('registerWebServerRoutes CLI runtime binding', () => {
  beforeEach(async () => {
    mockCreateCliChatRuntime.mockReset()
    await disposeChatRuntimeRouteCaches()
  })

  afterEach(async () => {
    await disposeChatRuntimeRouteCaches()
  })

  it('binds a CLI runtime to the persisted conversation working directory', async () => {
    const conversation = makeConversation({
      id: 'cli-cwd-conversation',
      workingDirectory: '/Projects/foo',
      webBinding: {
        initialAgentId: 'agent-current',
        activeAgentId: 'agent-current',
        rootHash: 'root-current',
      },
    })
    const scope = {} as CliRuntimeScope
    mockCreateCliChatRuntime.mockResolvedValueOnce(
      runtimeSnapshot(conversation.id),
    )
    const harness = createHarness([conversation], scope, ['/Projects/foo'])

    try {
      const response = await dispatchGet(
        harness.router,
        `/api/chat-runtime/codex/snapshot?conversationId=${conversation.id}`,
      )

      expect(response.statusCode).toBe(200)
      expect(mockCreateCliChatRuntime).toHaveBeenCalledWith(
        scope,
        'codex',
        expect.objectContaining({ workingDirectory: '/Projects/foo' }),
      )
    } finally {
      await harness.dispose()
    }
  })

  it('does not create a CLI runtime for a missing conversation', async () => {
    const harness = createHarness([], {} as CliRuntimeScope, [])

    try {
      const response = await dispatchGet(
        harness.router,
        '/api/chat-runtime/codex/snapshot?conversationId=missing',
      )

      expect(response.statusCode).toBe(404)
      expect(mockCreateCliChatRuntime).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('creates a bound conversation when chat save targets a new id', async () => {
    const harness = createHarness([], {} as CliRuntimeScope, [])

    try {
      const response = await dispatchPost(harness.router, '/api/chat/save', {
        id: 'new-web-conversation',
        messages: [],
      })

      expect(response.statusCode).toBe(200)
      expect(harness.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'new-web-conversation',
          messages: [],
          origin: 'external-agent',
          webBinding: {
            initialAgentId: 'agent-current',
            activeAgentId: 'agent-current',
            rootHash: 'root-current',
          },
        }),
      )
      expect(harness.updateChat).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it.each([
    {
      label: 'missing web binding',
      webBinding: undefined,
    },
    {
      label: 'foreign web binding',
      webBinding: {
        initialAgentId: 'agent-current',
        activeAgentId: 'agent-current',
        rootHash: 'root-foreign',
      },
    },
    {
      label: 'orphaned web binding',
      webBinding: {
        initialAgentId: 'agent-current',
        activeAgentId: 'agent-current',
        rootHash: 'root-current',
        accessState: 'orphaned' as const,
      },
    },
  ])('rejects a runtime lookup with a $label', async ({ webBinding }) => {
    const conversation = makeConversation({
      id: 'cli-unauthorized-conversation',
      workingDirectory: '/Projects/foo',
      webBinding,
    })
    mockCreateCliChatRuntime.mockResolvedValueOnce(
      runtimeSnapshot(conversation.id),
    )
    const harness = createHarness([conversation], {} as CliRuntimeScope, [
      '/Projects/foo',
    ])

    try {
      const response = await dispatchGet(
        harness.router,
        `/api/chat-runtime/codex/snapshot?conversationId=${conversation.id}`,
      )

      expect(response.statusCode).toBe(404)
      expect(mockCreateCliChatRuntime).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('allows the unbound runtime used for provider session discovery', async () => {
    const scope = {} as CliRuntimeScope
    mockCreateCliChatRuntime.mockResolvedValueOnce({
      listSessions: async () => ({ ok: true, sessions: [] }),
    } as never)
    const harness = createHarness([], scope, [])

    try {
      const response = await dispatchGet(
        harness.router,
        '/api/chat-runtime/codex/sessions',
      )

      expect(response.statusCode).toBe(200)
      expect(mockCreateCliChatRuntime).toHaveBeenCalledWith(
        scope,
        'codex',
        expect.objectContaining({ workingDirectory: '/' }),
      )
    } finally {
      await harness.dispose()
    }
  })

  it('allows host-authorized provider discovery without a web session', async () => {
    mockCreateCliChatRuntime.mockResolvedValueOnce({
      listSessions: async () => ({ ok: true, sessions: [] }),
    } as never)
    const harness = createHarness([], {} as CliRuntimeScope, [])

    try {
      const response = await dispatchGet(
        harness.router,
        '/api/chat-runtime/codex/sessions',
        null,
      )

      expect(response.statusCode).toBe(200)
      expect(mockCreateCliChatRuntime).toHaveBeenCalledTimes(1)
    } finally {
      await harness.dispose()
    }
  })

  it('returns the complete unavailable CLI runtime shape without a scope', async () => {
    const harness = createHarness(
      [],
      null as unknown as CliRuntimeScope,
      [],
    )

    try {
      const response = await dispatchGet(harness.router, '/api/cli/availability')

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.rawBody)).toEqual({
        'claude-code': false,
        codex: false,
        hermes: false,
        pi: false,
      })
    } finally {
      await harness.dispose()
    }
  })

  it('rechecks conversation authorization before returning a cached runtime', async () => {
    const conversation = makeConversation({
      id: 'cli-warm-cache-authorization',
      workingDirectory: '/Projects/foo',
      webBinding: {
        initialAgentId: 'agent-current',
        activeAgentId: 'agent-current',
        rootHash: 'root-current',
      },
    })
    mockCreateCliChatRuntime.mockResolvedValueOnce(
      runtimeSnapshot(conversation.id),
    )
    const harness = createHarness([conversation], {} as CliRuntimeScope, [
      '/Projects/foo',
    ])

    try {
      const url = `/api/chat-runtime/codex/snapshot?conversationId=${conversation.id}`
      expect((await dispatchGet(harness.router, url)).statusCode).toBe(200)

      const denied = await dispatchGet(harness.router, url, 'session-foreign')

      expect(denied.statusCode).toBe(404)
      expect(mockCreateCliChatRuntime).toHaveBeenCalledTimes(1)
    } finally {
      await harness.dispose()
    }
  })

  it('preserves the persisted working directory when save omits it', async () => {
    const conversation = makeConversation({
      id: 'cli-save-conversation',
      origin: 'external-agent',
      workingDirectory: '/Projects/foo',
      webBinding: {
        initialAgentId: 'agent-current',
        activeAgentId: 'agent-current',
        rootHash: 'root-current',
      },
    })
    const harness = createHarness([conversation], {} as CliRuntimeScope, [
      '/Projects/foo',
    ])

    try {
      const response = await dispatchPost(harness.router, '/api/chat/save', {
        id: conversation.id,
        messages: [],
      })

      expect(response.statusCode).toBe(200)
      const patch = harness.updateChat.mock.calls[0]?.[1] as
        | Record<string, unknown>
        | undefined
      expect(patch).toBeDefined()
      expect(patch).not.toHaveProperty('workingDirectory')
    } finally {
      await harness.dispose()
    }
  })

  it.each([
    {
      label: 'metadata patch',
      url: '/api/chat/patch-metadata',
      body: {
        id: 'cli-cwd-update',
        patch: { workingDirectory: '/Projects/bar' },
      },
    },
    {
      label: 'save',
      url: '/api/chat/save',
      body: {
        id: 'cli-cwd-update',
        messages: [],
        workingDirectory: '/Projects/bar',
      },
    },
  ])(
    'invalidates the cached runtime after a $label CWD change',
    async (testCase) => {
      const conversation = makeConversation({
        id: 'cli-cwd-update',
        origin: 'external-agent',
        workingDirectory: '/Projects/foo',
        webBinding: {
          initialAgentId: 'agent-current',
          activeAgentId: 'agent-current',
          rootHash: 'root-current',
        },
      })
      const firstDispose = jest.fn().mockResolvedValue(undefined)
      mockCreateCliChatRuntime
        .mockResolvedValueOnce(runtimeSnapshot(conversation.id, firstDispose))
        .mockResolvedValueOnce(runtimeSnapshot(conversation.id))
      const harness = createHarness([conversation], {} as CliRuntimeScope, [
        '/Projects/foo',
        '/Projects/bar',
      ])

      try {
        expect(
          (
            await dispatchGet(
              harness.router,
              `/api/chat-runtime/codex/snapshot?conversationId=${conversation.id}`,
            )
          ).statusCode,
        ).toBe(200)

        const updateResponse = await dispatchPost(
          harness.router,
          testCase.url,
          testCase.body,
        )

        expect(updateResponse.statusCode).toBe(200)
        expect(firstDispose).toHaveBeenCalledTimes(1)

        expect(
          (
            await dispatchGet(
              harness.router,
              `/api/chat-runtime/codex/snapshot?conversationId=${conversation.id}`,
            )
          ).statusCode,
        ).toBe(200)
        expect(mockCreateCliChatRuntime).toHaveBeenCalledTimes(2)
        expect(mockCreateCliChatRuntime).toHaveBeenLastCalledWith(
          expect.anything(),
          'codex',
          expect.objectContaining({ workingDirectory: '/Projects/bar' }),
        )
      } finally {
        await harness.dispose()
      }
    },
  )

  it('disposes the cached runtime when its conversation is deleted', async () => {
    const conversation = makeConversation({
      id: 'cli-delete-conversation',
      origin: 'external-agent',
      workingDirectory: '/Projects/foo',
      webBinding: {
        initialAgentId: 'agent-current',
        activeAgentId: 'agent-current',
        rootHash: 'root-current',
      },
    })
    const dispose = jest.fn().mockResolvedValue(undefined)
    mockCreateCliChatRuntime.mockResolvedValueOnce(
      runtimeSnapshot(conversation.id, dispose),
    )
    const harness = createHarness([conversation], {} as CliRuntimeScope, [
      '/Projects/foo',
    ])

    try {
      expect(
        (
          await dispatchGet(
            harness.router,
            `/api/chat-runtime/codex/snapshot?conversationId=${conversation.id}`,
          )
        ).statusCode,
      ).toBe(200)

      const deleteResponse = await dispatchPost(
        harness.router,
        '/api/chat/delete',
        { conversationId: conversation.id },
      )

      expect(deleteResponse.statusCode).toBe(200)
      expect(harness.deleteChat).toHaveBeenCalledWith(conversation.id)
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      await harness.dispose()
    }
  })
})

function runtimeSnapshot(
  conversationId: string,
  dispose = jest.fn().mockResolvedValue(undefined),
) {
  return {
    dispose,
    getSnapshot: () => ({
      replayCursor: 0,
      runId: 'run-1',
      conversationId,
      sessionRef: null,
      messages: [],
      runState: 'idle',
      error: null,
      compactionBoundaries: [],
      configuration: null,
      capabilities: {},
    }),
  } as never
}

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

function createHarness(
  seed: readonly WebChatConversation[],
  scope: CliRuntimeScope,
  vaultFolders: readonly string[],
) {
  const conversations = new Map(
    seed.map((conversation) => [conversation.id, conversation]),
  )
  const updateChat = jest.fn(
    async (id: string, patch: Record<string, unknown>) => {
      const current = conversations.get(id)
      if (!current) return null
      const updated = { ...current, ...patch } as WebChatConversation
      conversations.set(id, updated)
      return updated
    },
  )
  const deleteChat = jest.fn(async (id: string) => conversations.delete(id))
  const findById = jest.fn(async (id: string) => {
    return conversations.get(id) ?? null
  })
  const createChat = jest.fn(
    async (initial: Partial<WebChatConversation>) => {
      const created = makeConversation({
        ...initial,
        id: initial.id ?? 'generated-conversation',
      })
      conversations.set(created.id, created)
      return created
    },
  )
  const chatManager = {
    findById,
    listChats: jest.fn(async () => []),
    createChat,
    updateChat,
    deleteChat,
  } as unknown as ChatManager
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getName: () => 'test-vault',
      getRoot: () => Object.assign(new TFolder(), { path: '/', children: [] }),
      getAbstractFileByPath: (vaultPath: string) =>
        vaultFolders.includes(`/${vaultPath}`)
          ? Object.assign(new TFolder(), { path: vaultPath, children: [] })
          : null,
    },
    workspace: {},
    fileManager: {},
  } as unknown as App
  const settings = {
    yolo: { baseDir: 'YOLO' },
    assistants: [],
    workspaceAgents: [],
    webRuntime: { enabled: true, maxConcurrentAgentRuns: 1 },
  } as unknown as YoloSettings
  const router = new WebRouter()
  const registered = registerWebServerRoutes({
    server: { router } as WebHttpServer,
    app,
    plugin: {
      app,
      manifest: {},
      setSettings: jest.fn(async () => true),
      openApplyReview: jest.fn(async () => true),
    },
    chatManager,
    agentEventStore: {
      getRun: jest.fn(() => null),
      getRunEvents: jest.fn(() => []),
      listRunsByAgent: jest.fn(() => []),
      deleteRunsByAgent: jest.fn(),
    } as unknown as AgentEventStore,
    sseHub: new WebSseHub(),
    getSettings: () => settings,
    host: '127.0.0.1',
    port: 18900,
    getAgentService: () =>
      ({ getState: jest.fn(() => null) }) as unknown as AgentService,
    getMcpManager: jest.fn(async () => ({}) as never),
    getCliRuntimeScope: async () => scope,
  })
  return {
    router,
    createChat,
    updateChat,
    deleteChat,
    dispose: registered.dispose,
  }
}

async function dispatchGet(
  router: WebRouter,
  url: string,
  sessionId: string | null = 'session-current',
) {
  const resolved = router.resolve('GET', url)
  if (!resolved) throw new Error(`missing route: GET ${url}`)
  const request = Readable.from([]) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
  }
  request.method = 'GET'
  request.url = url
  request.headers = sessionId ? { [WEB_SESSION_HEADER]: sessionId } : {}
  const response = createResponse()
  await resolved.handler(request as never, response as never, resolved.params)
  return response
}

async function dispatchPost(router: WebRouter, url: string, body: unknown) {
  const resolved = router.resolve('POST', url)
  if (!resolved) throw new Error(`missing route: POST ${url}`)
  const request = Readable.from([
    Buffer.from(JSON.stringify(body), 'utf8'),
  ]) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
  }
  request.method = 'POST'
  request.url = url
  request.headers = {
    'content-type': 'application/json',
    [WEB_SESSION_HEADER]: 'session-current',
  }
  const response = createResponse()
  await resolved.handler(request as never, response as never, resolved.params)
  return response
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    setHeader: (name: string, value: string) => void
    end: (chunk?: string) => void
  }
  response.statusCode = 200
  response.writableEnded = false
  response.setHeader = () => undefined
  response.end = (chunk) => {
    if (chunk) rawBody += chunk
    response.writableEnded = true
  }
  Object.defineProperty(response, 'rawBody', { get: () => rawBody })
  return response
}
