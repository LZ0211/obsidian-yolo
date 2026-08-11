/**
 * Integration tests for the full web API flow.
 *
 * Unlike the per-route unit tests (chatRoutes.test.ts, agentRoutes.test.ts, …)
 * these tests register ALL routes on a single WebRouter backed by a REAL
 * WebSessionStore + createWebAgentContextResolver, so the session ID from
 * /api/web/auth/login flows through every subsequent request exactly as it
 * does in production.
 */

/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { SETTINGS_SCHEMA_VERSION } from '../../../settings/schema/migrations'
import { parseYoloSettings } from '../../../settings/schema/settings'
import { hashShareToken, hashWorkspaceRoot } from '../shareTokenCrypto'
import { createWebAgentContextResolver } from '../webAgentContextResolver'
import type {
  WebChatConversation,
  WebChatConversationMetadata,
} from '../webAgentTypes'
import { WebRouter } from '../WebRouter'
import { WebSessionStore } from '../webSessionStore'
import { WebSseHub } from '../WebSseHub'

import { registerAgentRoutes } from './agentRoutes'
import {
  WEB_SESSION_HEADER,
  __resetFailedLoginBucketsForTests,
  registerAuthRoutes,
} from './authRoutes'
import { registerChatRoutes } from './chatRoutes'
import { apiError } from './routeUtils'
import { registerSettingsRoutes } from './settingsRoutes'

// ─── shared test fixtures ─────────────────────────────────────────────────────

const PEPPER = Buffer.alloc(32, 7).toString('base64url')
const VALID_TOKEN =
  'yolo_share_v1_token-public_0123456789abcdef0123456789abcdef'
const VAULT_IDENTITY = 'vault-a'
const ROOT_HASH = hashWorkspaceRoot('/', VAULT_IDENTITY)

function createSettings() {
  return parseYoloSettings({
    version: SETTINGS_SCHEMA_VERSION,
    assistants: [
      {
        id: 'template-1',
        name: 'Template One',
        agentModeAllowed: true,
      },
    ],
    workspaceAgents: [
      {
        id: 'agent-1',
        name: 'Agent One',
        templateId: 'template-1',
        workspacePolicy: {
          workspaceRoot: '/',
          readAllowlist: [],
          readDenylist: [],
          writeDenylist: [],
        },
        shareTokens: [
          {
            id: 'token-public',
            tokenHash: hashShareToken(VALID_TOKEN, PEPPER),
            tokenHashVersion: 'hmac-sha256-v1' as const,
            scope: {
              kind: 'workspaceRoot' as const,
              rootHash: ROOT_HASH,
              issuedForAgentId: 'agent-1',
            },
            createdAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'agent-2',
        name: 'Agent Two',
        templateId: 'template-1',
        workspacePolicy: {
          workspaceRoot: '/',
          readAllowlist: [],
          readDenylist: [],
          writeDenylist: [],
        },
        shareTokens: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'agent-3',
        name: 'Agent Three',
        templateId: 'template-1',
        workspacePolicy: {
          workspaceRoot: '/other',
          readAllowlist: [],
          readDenylist: [],
          writeDenylist: [],
        },
        shareTokens: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    currentWorkspaceAgentId: 'agent-1',
  })
}

function makeConversation(
  id: string,
  agentId = 'agent-1',
  extraRootHash = ROOT_HASH,
): WebChatConversation {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    webBinding: {
      initialAgentId: agentId,
      activeAgentId: agentId,
      rootHash: extraRootHash,
    },
  }
}

function makeAgentState(conversationId: string, status = 'idle') {
  return {
    conversationId,
    status,
    messages: [],
    compaction: [] as never[],
    pendingCompactionAnchorMessageId: null,
  }
}

// ─── harness ──────────────────────────────────────────────────────────────────

function createFlowHarness() {
  const settings = createSettings()
  const conversationStore = new Map<string, WebChatConversation>()

  const sessionStore = new WebSessionStore({ now: () => 1_000 })
  const resolver = createWebAgentContextResolver({
    getSettings: () => settings,
    getSession: (sessionId) => {
      const session = sessionId ? sessionStore.resolve(sessionId) : null
      if (!session) return null
      return {
        id: session.id,
        tokenRecordId: session.tokenRecordId,
        tokenScope: session.tokenScope,
        activeAgentId: session.activeAgentId,
        rootHash: session.rootHash,
        createdAt: session.createdAt,
        lastUsedAt: session.lastSeenAt,
        expiresAt: session.absoluteExpiresAt,
      }
    },
    vaultIdentity: VAULT_IDENTITY,
  })

  const canAccessConversation = async (
    conversationId: string,
    binding: { activeAgentId: string; rootHash: string },
  ): Promise<boolean> => {
    const conv = conversationStore.get(conversationId)
    if (!conv?.webBinding) return false
    return (
      conv.webBinding.rootHash === binding.rootHash &&
      conv.webBinding.activeAgentId === binding.activeAgentId &&
      conv.webBinding.accessState !== 'orphaned'
    )
  }

  const resolveChatBinding = (sessionId: string | null) => {
    const resolved = resolver.resolve({ sessionId })
    if (!resolved.ok) {
      return {
        ok: false as const,
        statusCode: 401,
        body: apiError('session_expired', 'The web session has expired.'),
      }
    }
    const workspacePolicy = resolved.context.activeAgent.workspacePolicy
    return {
      ok: true as const,
      binding: {
        activeAgentId: resolved.context.activeAgent.id,
        rootHash: resolved.context.rootHash,
        allowedAgentIds: resolved.context.allowedAgents.map((a) => a.id),
        workspaceAccessPolicy: {
          enabled: true,
          workspaceRoot: workspacePolicy.workspaceRoot,
          readExtraIncludes: workspacePolicy.readAllowlist,
          readExcludes: workspacePolicy.readDenylist,
          writeExcludes: workspacePolicy.writeDenylist,
        },
      },
    }
  }

  const resolveAgentRouteBinding = (sessionId: string | null) => {
    const resolved = resolver.resolve({ sessionId })
    if (!resolved.ok) {
      return {
        ok: false as const,
        statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
        body:
          resolved.code === 'unauthenticated'
            ? apiError('session_expired', 'The web session has expired.')
            : apiError(resolved.code, resolved.message),
      }
    }
    return {
      ok: true as const,
      binding: {
        activeAgentId: resolved.context.activeAgent.id,
        rootHash: resolved.context.rootHash,
        activeAgent: resolved.context.activeAgent,
      },
    }
  }

  // ── agent mocks ─────────────────────────────────────────────────────────────

  const agentRunResult = { conversationId: 'conv-1', runId: 'run-1' }
  const runAgent = jest
    .fn()
    .mockImplementation(
      async ({ input }: { input: { conversationId?: string } }) => {
        const conversationId =
          input.conversationId ?? agentRunResult.conversationId
        conversationStore.set(conversationId, makeConversation(conversationId))
        return { conversationId, runId: agentRunResult.runId }
      },
    )

  const approveToolCall = jest.fn().mockResolvedValue({
    approved: true,
    state: makeAgentState('conv-1'),
  })
  const rejectToolCall = jest.fn().mockReturnValue(true)
  const abortToolCall = jest.fn().mockReturnValue(false)
  const peekPendingUserMessages = jest.fn().mockReturnValue([])
  const enqueueUserMessage = jest.fn().mockReturnValue('enqueued')
  const removePendingUserMessage = jest.fn().mockReturnValue(null)
  const getRun = jest.fn().mockResolvedValue(null)
  const getRunEvents = jest.fn().mockResolvedValue([])
  const getAgentState = jest
    .fn()
    .mockImplementation((conversationId: string) =>
      makeAgentState(conversationId),
    )
  const abortRun = jest
    .fn()
    .mockResolvedValue({ found: true, status: 'aborted' })
  const compactConversation = jest.fn().mockResolvedValue(null)
  const buildContextBreakdown = jest
    .fn()
    .mockResolvedValue({ buckets: [], total: 0, max: 0, computedAt: 1 })
  const subscribeToPendingBackgroundTaskResults = jest.fn(() => jest.fn())
  const subscribeToAbortedQueuedMessages = jest.fn(() => jest.fn())

  // ── chat mocks ───────────────────────────────────────────────────────────────

  const listChats = jest
    .fn()
    .mockImplementation(
      () => [...conversationStore.values()] as WebChatConversationMetadata[],
    )
  const findById = jest
    .fn()
    .mockImplementation((id: string) =>
      Promise.resolve(conversationStore.get(id) ?? null),
    )
  const getChat = jest
    .fn()
    .mockImplementation((id: string) =>
      Promise.resolve(conversationStore.get(id) ?? null),
    )
  const saveChat = jest
    .fn()
    .mockImplementation(
      async (request: {
        id: string
        messages: WebChatConversation['messages']
        webBinding: WebChatConversation['webBinding']
        [k: string]: unknown
      }) => {
        const conv: WebChatConversation = {
          id: request.id,
          title: 'New Chat',
          messages: request.messages ?? [],
          createdAt: 1,
          updatedAt: 1,
          schemaVersion: 1,
          webBinding: request.webBinding,
        }
        conversationStore.set(conv.id, conv)
        return conv
      },
    )
  const generateTitle = jest.fn().mockResolvedValue(undefined)
  const updateChat = jest
    .fn()
    .mockImplementation(
      async (id: string, updates: Partial<WebChatConversation>) => {
        const conv = conversationStore.get(id)
        if (!conv) return null
        const updated = { ...conv, ...updates }
        conversationStore.set(id, updated)
        return updated
      },
    )
  const deleteChat = jest.fn().mockResolvedValue(true)
  const createChat = jest.fn()
  const appendMessages = jest.fn().mockResolvedValue({ ok: true, updatedAt: 1 })
  const exportToVault = jest
    .fn()
    .mockResolvedValue({ path: 'Exports/chat-1.md' })

  // ── router wiring ────────────────────────────────────────────────────────────

  const sseHub = new WebSseHub()
  const router = new WebRouter()

  registerAuthRoutes(router, {
    getSettings: () => settings,
    pepper: PEPPER,
    sessionStore,
    resolver,
    vaultIdentity: VAULT_IDENTITY,
    now: () => 1_000,
  })

  registerChatRoutes(router, {
    listChats,
    getChat,
    findById,
    createChat,
    updateChat,
    deleteChat,
    saveChat,
    generateTitle,
    exportToVault,
    appendMessages,
    resolveChatBinding,
    isVaultFolder: () => true,
  })

  registerAgentRoutes(router, {
    getRun,
    getRunEvents,
    getAgentState,
    sseHub,
    abortRun,
    runAgent,
    compactConversation,
    buildContextBreakdown,
    approveToolCall,
    rejectToolCall,
    abortToolCall,
    peekPendingUserMessages,
    enqueueUserMessage,
    removePendingUserMessage,
    subscribeToPendingBackgroundTaskResults,
    subscribeToAbortedQueuedMessages,
    resolveAgentRouteBinding,
    canAccessConversation,
    canStartConversation: async (conversationId, binding) => {
      const conv = conversationStore.get(conversationId)
      if (!conv) return true
      return canAccessConversation(conversationId, binding)
    },
    canAccessRun: async (runId, binding) => {
      const run = await Promise.resolve(getRun(runId))
      if (!run) return false
      return canAccessConversation(
        (run as { conversationId: string }).conversationId,
        binding,
      )
    },
  })

  registerSettingsRoutes(router, {
    getSettings: () => settings,
    getSessionContext: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      return resolved.ok ? resolved.context : null
    },
    resolveSettingsAccess: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: 401,
          body: apiError('session_expired', 'The web session has expired.'),
        }
      }
      return { ok: true as const }
    },
  })

  const login = async () => {
    const res = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })
    const sessionId = res.headers['x-yolo-web-session-id']
    if (!sessionId) throw new Error(`Login failed (status ${res.statusCode})`)
    return sessionId
  }

  return {
    router,
    sessionStore,
    conversationStore,
    login,
    mocks: {
      runAgent,
      approveToolCall,
      rejectToolCall,
      abortToolCall,
      peekPendingUserMessages,
      enqueueUserMessage,
      removePendingUserMessage,
      getRun,
      getRunEvents,
      getAgentState,
      abortRun,
      compactConversation,
      buildContextBreakdown,
      listChats,
      findById,
      getChat,
      saveChat,
      generateTitle,
      updateChat,
      deleteChat,
      appendMessages,
      exportToVault,
    },
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('web API flow (integration)', () => {
  beforeEach(() => {
    __resetFailedLoginBucketsForTests()
  })

  // ── authentication ─────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('login → session check → logout → session expired', async () => {
      const { router } = createFlowHarness()

      const loginRes = await dispatch(router, 'POST', '/api/web/auth/login', {
        token: VALID_TOKEN,
      })
      expect(loginRes.statusCode).toBe(200)
      const sessionId = loginRes.headers['x-yolo-web-session-id']
      expect(sessionId).toBeTruthy()
      expect(loginRes.jsonBody).toMatchObject({
        session: { agentId: 'agent-1' },
        allowedAgents: expect.arrayContaining([
          expect.objectContaining({ id: 'agent-1' }),
          expect.objectContaining({ id: 'agent-2' }),
        ]),
      })

      const sessionRes = await dispatch(
        router,
        'GET',
        '/api/web/auth/session',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(sessionRes.statusCode).toBe(200)
      expect(sessionRes.jsonBody).toMatchObject({
        session: { agentId: 'agent-1' },
      })

      await dispatch(
        router,
        'POST',
        '/api/web/auth/logout',
        {},
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )

      const expiredRes = await dispatch(
        router,
        'GET',
        '/api/web/auth/session',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(expiredRes.statusCode).toBe(401)
      expect(expiredRes.jsonBody).toMatchObject({
        error: { code: 'session_expired' },
      })
    })

    it('rejects unauthenticated requests on all protected routes', async () => {
      const { router } = createFlowHarness()

      const responses = await Promise.all([
        dispatch(router, 'GET', '/api/chat/list'),
        dispatch(router, 'GET', '/api/settings'),
        dispatch(router, 'GET', '/api/agents'),
        dispatch(router, 'POST', '/api/agent/run', {
          conversationId: 'c',
          messages: [],
        }),
        dispatch(router, 'GET', '/api/agent/queue/peek?conversationId=c'),
      ])

      for (const res of responses) {
        expect(res.statusCode).toBe(401)
      }
    })

    it('rejects an invalid share token with 401', async () => {
      const { router } = createFlowHarness()

      const res = await dispatch(router, 'POST', '/api/web/auth/login', {
        token: 'yolo_share_v1_bad_token',
      })
      expect(res.statusCode).toBe(401)
      expect(res.jsonBody).toMatchObject({ error: { code: 'unauthenticated' } })
    })
  })

  // ── settings and agent discovery ───────────────────────────────────────────

  describe('settings and agent discovery', () => {
    it('returns settings scoped to the token (agents + templates on same root only)', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const res = await dispatch(router, 'GET', '/api/settings', undefined, {
        [WEB_SESSION_HEADER]: sessionId,
      })

      expect(res.statusCode).toBe(200)
      const body = res.jsonBody as {
        assistants?: { id: string }[]
        workspaceAgents?: { id: string }[]
      }
      // template-1 is needed by both agent-1 and agent-2, so it appears once
      expect(body.assistants).toHaveLength(1)
      expect(body.assistants?.[0].id).toBe('template-1')
      // agent-1 and agent-2 share workspaceRoot '/', agent-3 ('/other') is excluded
      expect(body.workspaceAgents?.map((a) => a.id)).toEqual(
        expect.arrayContaining(['agent-1', 'agent-2']),
      )
      expect(body.workspaceAgents?.map((a) => a.id)).not.toContain('agent-3')
    })

    it('returns the agent list filtered to the session token scope', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const res = await dispatch(router, 'GET', '/api/agents', undefined, {
        [WEB_SESSION_HEADER]: sessionId,
      })

      expect(res.statusCode).toBe(200)
      const ids = (res.jsonBody as { id: string }[]).map((a) => a.id)
      expect(ids).toContain('agent-1')
      expect(ids).toContain('agent-2')
      expect(ids).not.toContain('agent-3')
    })
  })

  // ── agent run and conversation state ───────────────────────────────────────

  describe('agent run', () => {
    it('starts a run and returns conversationId + runId', async () => {
      const { router, login, mocks } = createFlowHarness()
      const sessionId = await login()

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/run',
        {
          conversationId: 'conv-1',
          messages: [{ id: 'u1', role: 'user', content: 'hello' }],
        },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toMatchObject({
        conversationId: 'conv-1',
        runId: 'run-1',
      })
      expect(mocks.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          binding: expect.objectContaining({
            activeAgentId: 'agent-1',
            rootHash: ROOT_HASH,
          }),
          input: expect.objectContaining({ conversationId: 'conv-1' }),
        }),
      )
    })

    it('rejects client-supplied selector fields on agent run', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/run',
        {
          conversationId: 'conv-1',
          messages: [],
          activeAgentId: 'agent-9',
        },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(400)
      expect(res.jsonBody).toMatchObject({ error: { code: 'invalid_request' } })
    })

    it('returns agent state for an accessible conversation', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))
      mocks.getAgentState.mockReturnValue(makeAgentState('conv-1', 'running'))

      const res = await dispatch(
        router,
        'GET',
        '/api/agent/state?conversationId=conv-1',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toMatchObject({
        conversationId: 'conv-1',
        status: 'running',
      })
    })

    it('returns 404 for agent state on an inaccessible conversation', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'conv-other',
        makeConversation('conv-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'GET',
        '/api/agent/state?conversationId=conv-other',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })
  })

  // ── pending user message queue ─────────────────────────────────────────────

  describe('user message queue', () => {
    it('peek → enqueue → remove round-trip', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))

      const queuedMsg = { id: 'u1', role: 'user', content: 'queued' }
      mocks.peekPendingUserMessages.mockReturnValue([queuedMsg])

      const peekRes = await dispatch(
        router,
        'GET',
        '/api/agent/queue/peek?conversationId=conv-1',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(peekRes.statusCode).toBe(200)
      expect(peekRes.jsonBody).toEqual({ messages: [queuedMsg] })

      mocks.enqueueUserMessage.mockReturnValue('enqueued')
      const enqueueRes = await dispatch(
        router,
        'POST',
        '/api/agent/queue/enqueue',
        { conversationId: 'conv-1', message: queuedMsg },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(enqueueRes.statusCode).toBe(200)
      expect(enqueueRes.jsonBody).toEqual({ result: 'enqueued' })

      mocks.removePendingUserMessage.mockReturnValue(queuedMsg)
      const removeRes = await dispatch(
        router,
        'POST',
        '/api/agent/queue/remove',
        { conversationId: 'conv-1', messageId: 'u1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(removeRes.statusCode).toBe(200)
      expect(removeRes.jsonBody).toEqual({ message: queuedMsg })
    })
  })

  // ── tool call approval ────────────────────────────────────────────────────

  describe('tool call approval', () => {
    it('approves a tool call and returns the updated conversation state', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))

      const agentState = makeAgentState('conv-1', 'idle')
      mocks.approveToolCall.mockResolvedValue({
        approved: true,
        state: agentState,
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
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toEqual({ approved: true, state: agentState })
      expect(mocks.approveToolCall).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        toolCallId: 'tool-1',
        allowForConversation: true,
      })
    })

    it('rejects a tool call', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))
      mocks.rejectToolCall.mockReturnValue(true)

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/tool/reject',
        { conversationId: 'conv-1', toolCallId: 'tool-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toEqual({ rejected: true })
    })

    it('denies tool operations on conversations outside the session root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'conv-other',
        makeConversation('conv-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/tool/approve',
        { conversationId: 'conv-other', toolCallId: 'tool-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })
  })

  // ── chat CRUD ─────────────────────────────────────────────────────────────

  describe('chat operations', () => {
    it('saves a new chat, lists it, then retrieves it', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const saveRes = await dispatch(
        router,
        'POST',
        '/api/chat/save',
        {
          id: 'chat-1',
          messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(saveRes.statusCode).toBe(200)
      const saved = saveRes.jsonBody as {
        id: string
        webBinding: { activeAgentId: string; rootHash: string }
      }
      expect(saved.id).toBe('chat-1')
      expect(saved.webBinding.activeAgentId).toBe('agent-1')
      expect(saved.webBinding.rootHash).toBe(ROOT_HASH)

      const listRes = await dispatch(
        router,
        'GET',
        '/api/chat/list',
        undefined,
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )
      expect(listRes.statusCode).toBe(200)
      const chats = listRes.jsonBody as { id: string }[]
      expect(chats).toHaveLength(1)
      expect(chats[0].id).toBe('chat-1')

      const getRes = await dispatch(
        router,
        'GET',
        '/api/chat/get/chat-1',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(getRes.statusCode).toBe(200)
      expect((getRes.jsonBody as { id: string }).id).toBe('chat-1')
    })

    it('hides conversations that belong to a different root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'chat-other',
        makeConversation('chat-other', 'agent-x', 'different-root'),
      )

      const listRes = await dispatch(
        router,
        'GET',
        '/api/chat/list',
        undefined,
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )
      expect(listRes.statusCode).toBe(200)
      expect(listRes.jsonBody).toEqual([])

      const getRes = await dispatch(
        router,
        'GET',
        '/api/chat/get/chat-other',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(getRes.statusCode).toBe(404)
    })

    it('generates a title for a saved chat', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('chat-1', makeConversation('chat-1'))
      mocks.generateTitle.mockImplementation(async () => {
        const conv = conversationStore.get('chat-1')!
        conversationStore.set('chat-1', { ...conv, title: 'Generated Title' })
      })

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/generate-title',
        {
          conversationId: 'chat-1',
          messages: [{ id: 'm1', role: 'user', content: 'hi' }],
          force: true,
        },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toEqual({ title: 'Generated Title' })
      expect(mocks.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'chat-1', force: true }),
      )
    })

    it('updates the title of an accessible chat', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('chat-1', makeConversation('chat-1'))

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/update-title',
        { id: 'chat-1', title: 'Renamed', touchUpdatedAt: false },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect((res.jsonBody as { title: string }).title).toBe('Renamed')
      expect(conversationStore.get('chat-1')?.title).toBe('Renamed')
    })

    it('rejects save for an existing chat bound to a different root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'chat-other',
        makeConversation('chat-other', 'agent-x', 'different-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/save',
        { id: 'chat-other', messages: [] },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })

    it('generate-title returns 404 for a conversation outside the session root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'chat-other',
        makeConversation('chat-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/generate-title',
        { conversationId: 'chat-other', messages: [], force: false },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })
  })

  // ── agent switching ────────────────────────────────────────────────────────

  describe('agent switching', () => {
    it('switches to agent-2 (same workspace root) and subsequent requests use new agent', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const switchRes = await dispatch(
        router,
        'POST',
        '/api/web/auth/switch-agent',
        { agentId: 'agent-2' },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(switchRes.statusCode).toBe(200)
      expect(switchRes.jsonBody).toMatchObject({
        session: { agentId: 'agent-2' },
      })

      // Subsequent session check reflects the new agent
      const sessionRes = await dispatch(
        router,
        'GET',
        '/api/web/auth/session',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(sessionRes.statusCode).toBe(200)
      expect(
        (sessionRes.jsonBody as { session: { agentId: string } }).session
          .agentId,
      ).toBe('agent-2')

      // Agent routes now use agent-2 binding
      const agentsRes = await dispatch(
        router,
        'GET',
        '/api/agents',
        undefined,
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )
      expect(agentsRes.statusCode).toBe(200)
      const ids = (agentsRes.jsonBody as { id: string }[]).map((a) => a.id)
      expect(ids).toContain('agent-2')
    })

    it('blocks switching to agent-3 which has a different workspace root', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const res = await dispatch(
        router,
        'POST',
        '/api/web/auth/switch-agent',
        { agentId: 'agent-3' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(403)
      expect(res.jsonBody).toMatchObject({ error: { code: 'forbidden' } })
    })

    it('chats from agent-1 remain visible after switching to agent-2 (same workspace root)', async () => {
      // Both agent-1 and agent-2 share workspaceRoot '/' so the session's
      // allowedAgentIds = ['agent-1', 'agent-2'].  The chat route's
      // canAccessConversation checks allowedAgentIds.includes(activeAgentId)
      // — a chat created under agent-1 stays visible from agent-2 sessions.
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('chat-a1', makeConversation('chat-a1', 'agent-1'))

      // Visible before switch
      const beforeList = await dispatch(
        router,
        'GET',
        '/api/chat/list',
        undefined,
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )
      expect(
        (beforeList.jsonBody as { id: string }[]).map((c) => c.id),
      ).toContain('chat-a1')

      await dispatch(
        router,
        'POST',
        '/api/web/auth/switch-agent',
        { agentId: 'agent-2' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      // Still visible after switch — agent-1 is still in allowedAgentIds
      const afterList = await dispatch(
        router,
        'GET',
        '/api/chat/list',
        undefined,
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )
      expect(
        (afterList.jsonBody as { id: string }[]).map((c) => c.id),
      ).toContain('chat-a1')
    })

    it('tool operations on agent-1 conversations are denied after switching to agent-2', async () => {
      // Agent routes use a strict binding check (activeAgentId must match),
      // so a conversation bound to agent-1 is inaccessible from agent-2.
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-a1', makeConversation('conv-a1', 'agent-1'))

      await dispatch(
        router,
        'POST',
        '/api/web/auth/switch-agent',
        { agentId: 'agent-2' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/tool/approve',
        { conversationId: 'conv-a1', toolCallId: 'tool-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      // conv-a1.webBinding.activeAgentId = 'agent-1', session binding.activeAgentId = 'agent-2'
      expect(res.statusCode).toBe(404)
    })
  })

  // ── settings security regressions ─────────────────────────────────────────
  // Regression: provider API keys and share-token hashes must never leak to
  // the web client — they were previously returned in plaintext.

  describe('settings security', () => {
    it('redacts provider API keys in /api/settings', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const res = await dispatch(router, 'GET', '/api/settings', undefined, {
        [WEB_SESSION_HEADER]: sessionId,
      })

      expect(res.statusCode).toBe(200)
      const body = res.jsonBody as { providers?: { apiKey: string }[] }
      for (const provider of body.providers ?? []) {
        expect(provider.apiKey).toBe('')
      }
    })

    it('redacts share-token hashes in /api/settings workspace agents', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const res = await dispatch(router, 'GET', '/api/settings', undefined, {
        [WEB_SESSION_HEADER]: sessionId,
      })

      expect(res.statusCode).toBe(200)
      const body = res.jsonBody as {
        workspaceAgents?: { shareTokens?: { tokenHash: string }[] }[]
      }
      for (const agent of body.workspaceAgents ?? []) {
        for (const token of agent.shareTokens ?? []) {
          expect(token.tokenHash).toBe('')
        }
      }
    })

    it('excludes agents outside the session workspace root from /api/settings', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      const res = await dispatch(router, 'GET', '/api/settings', undefined, {
        [WEB_SESSION_HEADER]: sessionId,
      })

      expect(res.statusCode).toBe(200)
      const body = res.jsonBody as { workspaceAgents?: { id: string }[] }
      const agentIds = (body.workspaceAgents ?? []).map((a) => a.id)
      expect(agentIds).not.toContain('agent-3')
    })

    it('/api/settings returns 401 without a valid session', async () => {
      const { router } = createFlowHarness()

      const res = await dispatch(router, 'GET', '/api/settings')
      expect(res.statusCode).toBe(401)
    })

    it('/api/agents returns 401 without a valid session', async () => {
      const { router } = createFlowHarness()

      const res = await dispatch(router, 'GET', '/api/agents')
      expect(res.statusCode).toBe(401)
    })
  })

  // ── agent run operations (remaining endpoints) ─────────────────────────────

  describe('agent run operations', () => {
    it('aborts a running agent run', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      mocks.getRun.mockResolvedValue({
        runId: 'run-1',
        conversationId: 'conv-1',
        status: 'running',
      })
      mocks.abortRun.mockResolvedValue({ found: true, status: 'aborted' })
      conversationStore.set('conv-1', makeConversation('conv-1'))

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/abort/run-1',
        {},
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toMatchObject({ status: 'aborted' })
    })

    it('compacts a conversation through the agent service', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))
      mocks.compactConversation.mockResolvedValue({
        anchorMessageId: 'msg-1',
        summary: 'summary text',
        compactedAt: 1,
        compactedMessageCount: 5,
      })

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/compact',
        {
          conversationId: 'conv-1',
          messages: [{ id: 'u1', role: 'user', content: 'hello' }],
          modelId: 'model-1',
        },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toMatchObject({
        anchorMessageId: 'msg-1',
        summary: 'summary text',
      })
      expect(mocks.compactConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          binding: expect.objectContaining({
            activeAgentId: 'agent-1',
            rootHash: ROOT_HASH,
          }),
          input: expect.objectContaining({ conversationId: 'conv-1' }),
        }),
      )
    })

    it('builds a context breakdown for the current conversation', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))
      mocks.buildContextBreakdown.mockResolvedValue({
        buckets: [{ bucket: 'conversation', tokens: 100 }],
        total: 100,
        max: 200_000,
        computedAt: 1,
      })

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/context-breakdown',
        {
          conversationId: 'conv-1',
          messages: [{ id: 'u1', role: 'user', content: 'hello' }],
        },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toMatchObject({
        buckets: [{ bucket: 'conversation', tokens: 100 }],
        total: 100,
      })
    })

    it('denies compact for conversations outside the session root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'conv-other',
        makeConversation('conv-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/compact',
        { conversationId: 'conv-other', messages: [] },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })

    it('denies context-breakdown for conversations outside the session root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'conv-other',
        makeConversation('conv-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/context-breakdown',
        { conversationId: 'conv-other', messages: [] },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })

    it('fails starting a run for an existing conversation that is out-of-scope', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'conv-other',
        makeConversation('conv-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/run',
        { conversationId: 'conv-other', messages: [] },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })
  })

  // ── chat routes — remaining endpoints ─────────────────────────────────────

  describe('chat operations — additional routes', () => {
    it('appends messages to an existing chat with optimistic concurrency', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('chat-1', makeConversation('chat-1'))

      const newMessages = [{ id: 'a1', role: 'assistant', content: 'response' }]
      mocks.appendMessages.mockResolvedValue({ ok: true, updatedAt: 42 })

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/append-messages',
        { id: 'chat-1', baseCount: 0, newMessages },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toEqual({ updatedAt: 42 })
    })

    it('returns 409 when append-messages detects a count mismatch', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('chat-1', makeConversation('chat-1'))
      mocks.appendMessages.mockResolvedValue({ ok: false, conflict: true })

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/append-messages',
        { id: 'chat-1', baseCount: 99, newMessages: [] },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(409)
      expect(res.jsonBody).toMatchObject({ error: { code: 'conflict' } })
    })

    it('deletes a chat within the session root', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('chat-1', makeConversation('chat-1'))
      mocks.deleteChat.mockResolvedValue(true)

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/delete',
        { conversationId: 'chat-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toEqual({ deleted: true })
    })

    it('refuses to delete a chat outside the session root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'chat-other',
        makeConversation('chat-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/delete',
        { conversationId: 'chat-other' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })

    it('toggles the pinned state of a chat', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      const chat = { ...makeConversation('chat-1'), isPinned: false }
      conversationStore.set('chat-1', chat)

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/toggle-pinned',
        { id: 'chat-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect((res.jsonBody as { isPinned: boolean }).isPinned).toBe(true)
    })

    it('exports a chat to the vault', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('chat-1', makeConversation('chat-1'))
      mocks.exportToVault.mockResolvedValue({ path: 'Exports/Chat.md' })

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/export',
        { conversationId: 'chat-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toEqual({ path: 'Exports/Chat.md' })
    })

    it('toggle-pinned returns 404 for a chat outside the session root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'chat-other',
        makeConversation('chat-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/toggle-pinned',
        { id: 'chat-other' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })

    it('export returns 404 for a chat outside the session root', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'chat-other',
        makeConversation('chat-other', 'agent-x', 'wrong-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/export',
        { conversationId: 'chat-other' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })
  })

  // ── tool-call approval regression tests ────────────────────────────────────
  // Regression: the original implementation wrapped the approveToolCall result
  // in `{ approved: bool }` and discarded the continuation state. After the
  // fix, the full `{ approved, state }` object is written to the response so
  // the client can resync without waiting for another SSE event.

  describe('tool call approval regression', () => {
    it('returns the full { approved, state } object — not just the boolean', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))

      const fullState = {
        conversationId: 'conv-1',
        status: 'idle',
        messages: [{ id: 'm1', role: 'assistant', content: 'done' }],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      }
      mocks.approveToolCall.mockResolvedValue({
        approved: true,
        state: fullState,
      })

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/tool/approve',
        { conversationId: 'conv-1', toolCallId: 'tool-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      // Must have BOTH approved AND state — not just the boolean wrapper
      expect(res.jsonBody).toEqual({ approved: true, state: fullState })
    })

    it('second-click scenario: approved=false still returns state for resync', async () => {
      // Before the fix: second click returned `{ approved: false }` (old
      // code), which the client could not distinguish from a permanent reject.
      // After the fix: `{ approved: false, state }` lets the client resync
      // to the current server state regardless of the approval outcome.
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))

      const alreadyResolvedState = makeAgentState('conv-1', 'idle')
      mocks.approveToolCall.mockResolvedValue({
        approved: false,
        state: alreadyResolvedState,
      })

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/tool/approve',
        { conversationId: 'conv-1', toolCallId: 'tool-already-resolved' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      // state must be present even when approved=false so the client can
      // resync its conversation view to the real server state
      expect(res.jsonBody).toMatchObject({
        approved: false,
        state: expect.objectContaining({ conversationId: 'conv-1' }),
      })
    })

    it('aborts a pending tool call', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-1', makeConversation('conv-1'))
      mocks.abortToolCall.mockReturnValue(true)

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/tool/abort',
        { conversationId: 'conv-1', toolCallId: 'tool-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(res.jsonBody).toEqual({ aborted: true })
    })
  })

  // ── conversation access-control regressions ────────────────────────────────

  describe('conversation access control', () => {
    it('allows starting a brand-new conversation (no prior webBinding)', async () => {
      // canStartConversation must return true for conversations that don't
      // exist yet in the chat store — otherwise the first ever chat save fails.
      const { router, login, mocks } = createFlowHarness()
      const sessionId = await login()
      // runAgent will attempt to create conv-new; conversationStore is empty

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/run',
        { conversationId: 'conv-new', messages: [] },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(200)
      expect(mocks.runAgent).toHaveBeenCalled()
    })

    it('blocks starting a run on an existing out-of-scope conversation', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set(
        'conv-x',
        makeConversation('conv-x', 'agent-x', 'foreign-root'),
      )

      const res = await dispatch(
        router,
        'POST',
        '/api/agent/run',
        { conversationId: 'conv-x', messages: [] },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      expect(res.statusCode).toBe(404)
    })

    it('hides orphaned web conversations from chat list', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()
      conversationStore.set('conv-orphaned', {
        ...makeConversation('conv-orphaned', 'agent-1'),
        webBinding: {
          initialAgentId: 'agent-1',
          activeAgentId: 'agent-1',
          rootHash: ROOT_HASH,
          accessState: 'orphaned' as const,
          orphanedReason: 'agent_deleted' as const,
        },
      })

      const listRes = await dispatch(
        router,
        'GET',
        '/api/chat/list',
        undefined,
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )
      expect(listRes.statusCode).toBe(200)
      expect(
        (listRes.jsonBody as { id: string }[]).map((c) => c.id),
      ).not.toContain('conv-orphaned')

      const getRes = await dispatch(
        router,
        'GET',
        '/api/chat/get/conv-orphaned',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(getRes.statusCode).toBe(404)
    })

    it('peer session cannot access conversations created by another session', async () => {
      // Two browsers logging in with different tokens should not see each
      // other's data. Simulate by creating two harnesses (different stores)
      // and verifying the route enforces rootHash binding.
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()

      // Seed a conversation belonging to a different workspace root
      conversationStore.set(
        'conv-peer',
        makeConversation('conv-peer', 'agent-1', 'peer-root-hash'),
      )

      const res = await dispatch(
        router,
        'GET',
        '/api/chat/get/conv-peer',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(res.statusCode).toBe(404)
    })

    it('stale session ID (deleted after logout) is rejected on all protected routes', async () => {
      const { router, login } = createFlowHarness()
      const sessionId = await login()

      await dispatch(
        router,
        'POST',
        '/api/web/auth/logout',
        {},
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )

      const routes = await Promise.all([
        dispatch(router, 'GET', '/api/chat/list', undefined, {
          [WEB_SESSION_HEADER]: sessionId,
        }),
        dispatch(router, 'GET', '/api/settings', undefined, {
          [WEB_SESSION_HEADER]: sessionId,
        }),
        dispatch(router, 'GET', '/api/agents', undefined, {
          [WEB_SESSION_HEADER]: sessionId,
        }),
        dispatch(
          router,
          'POST',
          '/api/agent/run',
          { messages: [] },
          {
            [WEB_SESSION_HEADER]: sessionId,
          },
        ),
      ])

      for (const res of routes) {
        expect(res.statusCode).toBe(401)
      }
    })
  })

  // ── full conversation workflow scenario ────────────────────────────────────

  describe('full conversation workflow', () => {
    it('login → run → get state → approve tool → state is updated', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()

      // 1. Start a run
      const runRes = await dispatch(
        router,
        'POST',
        '/api/agent/run',
        {
          conversationId: 'conv-1',
          messages: [{ id: 'u1', role: 'user', content: 'hello' }],
        },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(runRes.statusCode).toBe(200)
      expect(runRes.jsonBody).toMatchObject({
        conversationId: 'conv-1',
        runId: 'run-1',
      })
      // runAgent mock seeds the conversation store
      expect(conversationStore.has('conv-1')).toBe(true)

      // 2. Get agent state (running)
      mocks.getAgentState.mockReturnValue(makeAgentState('conv-1', 'running'))
      const stateRes = await dispatch(
        router,
        'GET',
        '/api/agent/state?conversationId=conv-1',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(stateRes.statusCode).toBe(200)
      expect(stateRes.jsonBody).toMatchObject({ status: 'running' })

      // 3. Approve a tool call — response must include post-approval state
      const postApprovalState = {
        ...makeAgentState('conv-1', 'idle'),
        messages: [
          { id: 'u1', role: 'user', content: 'hello' },
          { id: 'a1', role: 'assistant', content: 'result' },
        ],
      }
      mocks.approveToolCall.mockResolvedValue({
        approved: true,
        state: postApprovalState,
      })
      const approveRes = await dispatch(
        router,
        'POST',
        '/api/agent/tool/approve',
        { conversationId: 'conv-1', toolCallId: 'tool-1' },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(approveRes.statusCode).toBe(200)
      expect(approveRes.jsonBody).toMatchObject({
        approved: true,
        state: expect.objectContaining({ status: 'idle' }),
      })
      // The state in the response lets the client re-render without needing
      // another round-trip — this is the key fix for the frozen-UI bug.
      const approvedBody = approveRes.jsonBody as {
        state: { messages: unknown[] }
      }
      expect(approvedBody.state.messages).toHaveLength(2)
    })

    it('login → save chat → enqueue follow-up → peek queue', async () => {
      const { router, login, conversationStore, mocks } = createFlowHarness()
      const sessionId = await login()

      // Save initial chat
      await dispatch(
        router,
        'POST',
        '/api/chat/save',
        { id: 'chat-1', messages: [{ id: 'm1', role: 'user', content: 'hi' }] },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(conversationStore.has('chat-1')).toBe(true)

      // Enqueue a follow-up user message
      const followUp = { id: 'u2', role: 'user', content: 'follow-up' }
      mocks.enqueueUserMessage.mockReturnValue('enqueued')
      const enqueueRes = await dispatch(
        router,
        'POST',
        '/api/agent/queue/enqueue',
        { conversationId: 'chat-1', message: followUp },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(enqueueRes.statusCode).toBe(200)

      // Peek reveals the enqueued message
      mocks.peekPendingUserMessages.mockReturnValue([followUp])
      const peekRes = await dispatch(
        router,
        'GET',
        '/api/agent/queue/peek?conversationId=chat-1',
        undefined,
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(peekRes.statusCode).toBe(200)
      expect(
        (peekRes.jsonBody as { messages: unknown[] }).messages,
      ).toHaveLength(1)
    })

    it('login → save → update title → list → verify final state', async () => {
      const { router, login, conversationStore } = createFlowHarness()
      const sessionId = await login()

      // Save
      await dispatch(
        router,
        'POST',
        '/api/chat/save',
        { id: 'chat-1', messages: [] },
        { [WEB_SESSION_HEADER]: sessionId },
      )

      // Update title
      const titleRes = await dispatch(
        router,
        'POST',
        '/api/chat/update-title',
        { id: 'chat-1', title: 'Final Title' },
        { [WEB_SESSION_HEADER]: sessionId },
      )
      expect(titleRes.statusCode).toBe(200)
      expect((titleRes.jsonBody as { title: string }).title).toBe('Final Title')

      // List shows updated title
      const listRes = await dispatch(
        router,
        'GET',
        '/api/chat/list',
        undefined,
        {
          [WEB_SESSION_HEADER]: sessionId,
        },
      )
      expect(listRes.statusCode).toBe(200)
      const chats = listRes.jsonBody as { id: string; title: string }[]
      const found = chats.find((c) => c.id === 'chat-1')
      expect(found?.title).toBe('Final Title')

      // Verify the store was updated too
      expect(conversationStore.get('chat-1')?.title).toBe('Final Title')
    })
  })
})

// ─── helpers ──────────────────────────────────────────────────────────────────

async function dispatch(
  router: WebRouter,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const resolved = router.resolve(method, url)
  if (!resolved) {
    throw new Error(`No route matched: ${method} ${url}`)
  }
  const req = createRequest({ method, url, body, headers })
  const res = createResponse()
  await resolved.handler(req as never, res as never, resolved.params)
  return res
}

function createRequest({
  method,
  url,
  body,
  headers,
}: {
  method: string
  url: string
  body?: unknown
  headers?: Record<string, string>
}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const stream = Readable.from(chunks) as Readable &
    EventEmitter & {
      method?: string
      url?: string
      headers: Record<string, string>
      socket?: { remoteAddress?: string }
    }
  stream.method = method
  stream.url = url
  stream.headers = headers ?? {}
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    headers: Record<string, string>
    flushHeaders?: () => void
    setHeader: (name: string, value: string) => void
    end: (chunk?: string) => void
    write: (chunk: string) => void
    jsonBody: unknown
    rawBody: string
  }
  response.statusCode = 200
  response.writableEnded = false
  response.headers = {}
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = value
  }
  response.flushHeaders = () => {}
  response.write = (chunk) => {
    rawBody += chunk
  }
  response.end = (chunk) => {
    if (chunk) rawBody += chunk
    response.writableEnded = true
  }
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
