/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { SETTINGS_SCHEMA_VERSION } from '../../../settings/schema/migrations'
import { parseYoloSettings } from '../../../settings/schema/settings'
import { hashShareToken, hashWorkspaceRoot } from '../shareTokenCrypto'
import { createWebAgentContextResolver } from '../webAgentContextResolver'
import { WebRouter } from '../WebRouter'
import { WebSessionStore } from '../webSessionStore'

import {
  __resetFailedLoginBucketsForTests,
  registerAuthRoutes,
} from './authRoutes'

const PEPPER = Buffer.alloc(32, 7).toString('base64url')
const VALID_TOKEN =
  'yolo_share_v1_token-public_0123456789abcdef0123456789abcdef'

describe('authRoutes', () => {
  beforeEach(() => {
    // The failed-login rate-limit buckets are a module-level singleton so
    // failed attempts in one test would otherwise carry over and trip the
    // 429 ceiling in unrelated tests. Reset between each spec.
    __resetFailedLoginBucketsForTests()
  })

  it('logs in with a body token, creates a session, and returns allowed agents', async () => {
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 1_000 })
    const settings = createSettings()
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 1_000,
    })

    const res = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-yolo-web-session-id']).toBeTruthy()
    expect(res.jsonBody).toEqual({
      session: {
        agentId: 'agent-1',
      },
      allowedAgents: [
        {
          id: 'agent-1',
          name: 'Agent One',
          agentModeAllowed: true,
        },
        {
          id: 'agent-2',
          name: 'Agent Two',
          agentModeAllowed: true,
        },
      ],
    })
  })

  it('returns setup state when no workspace agents are configured', async () => {
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 1_000 })
    const settings = createSettings({
      workspaceAgents: [],
      currentWorkspaceAgentId: undefined,
    })
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 1_000,
    })

    const res = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })

    expect(res.statusCode).toBe(403)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'agent_unavailable',
        message: 'Remote web setup is incomplete.',
      },
    })
  })

  it('does not log in with a share token issued by a disabled workspace agent', async () => {
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 1_000 })
    const settings = createSettings({
      workspaceAgents: createSettings().workspaceAgents.map((agent) =>
        agent.id === 'agent-1' ? { ...agent, disabled: true } : agent,
      ),
    })
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 1_000,
    })

    const res = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })

    expect(res.statusCode).toBe(403)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'agent_unavailable',
        message: 'Remote web setup is incomplete.',
      },
    })
  })

  it('expires session state after logout', async () => {
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 1_000 })
    const settings = createSettings()
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 1_000,
    })

    const login = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })
    const sessionId = login.headers['x-yolo-web-session-id']

    const sessionRes = await dispatch(
      router,
      'GET',
      '/api/web/auth/session',
      undefined,
      {
        'x-yolo-web-session-id': sessionId,
      },
    )
    expect(sessionRes.statusCode).toBe(200)
    expect(sessionRes.jsonBody).toEqual({
      session: { agentId: 'agent-1' },
      allowedAgents: [
        {
          id: 'agent-1',
          name: 'Agent One',
          agentModeAllowed: true,
        },
        {
          id: 'agent-2',
          name: 'Agent Two',
          agentModeAllowed: true,
        },
      ],
    })

    const logoutRes = await dispatch(
      router,
      'POST',
      '/api/web/auth/logout',
      {},
      {
        'x-yolo-web-session-id': sessionId,
      },
    )
    expect(logoutRes.statusCode).toBe(200)
    expect(logoutRes.jsonBody).toEqual({ ok: true })

    const expiredRes = await dispatch(
      router,
      'GET',
      '/api/web/auth/session',
      undefined,
      {
        'x-yolo-web-session-id': sessionId,
      },
    )
    expect(expiredRes.statusCode).toBe(401)
    expect(expiredRes.jsonBody).toEqual({
      error: {
        code: 'session_expired',
        message: 'The web session has expired.',
      },
    })
  })

  it('switches only to an authorized same-root agent', async () => {
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 1_000 })
    const settings = createSettings({
      assistants: [
        ...createSettings().assistants,
        {
          id: 'template-standalone',
          name: 'Standalone Template',
          systemPrompt: '',
        },
      ],
    })
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 1_000,
    })

    const login = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })
    const sessionId = login.headers['x-yolo-web-session-id']

    const switchRes = await dispatch(
      router,
      'POST',
      '/api/web/auth/switch-agent',
      { agentId: 'agent-2' },
      {
        'x-yolo-web-session-id': sessionId,
      },
    )

    expect(switchRes.statusCode).toBe(200)
    expect(switchRes.jsonBody).toEqual({
      session: { agentId: 'agent-2' },
      allowedAgents: [
        {
          id: 'agent-1',
          name: 'Agent One',
          agentModeAllowed: true,
        },
        {
          id: 'agent-2',
          name: 'Agent Two',
          agentModeAllowed: true,
        },
      ],
    })

    const forbiddenRes = await dispatch(
      router,
      'POST',
      '/api/web/auth/switch-agent',
      { agentId: 'agent-3' },
      {
        'x-yolo-web-session-id': sessionId,
      },
    )
    expect(forbiddenRes.statusCode).toBe(403)
    expect(forbiddenRes.jsonBody).toEqual({
      error: {
        code: 'forbidden',
        message:
          'The requested Agent is outside the current workspace-root token scope.',
      },
    })
  })

  it('rate limits repeated failed login attempts by remote address and public token id', async () => {
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 1_000 })
    const settings = createSettings()
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 1_000,
    })

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await dispatch(router, 'POST', '/api/web/auth/login', {
        token: `${VALID_TOKEN}x`,
      })
      expect(res.statusCode).toBe(401)
    }

    const limited = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: `${VALID_TOKEN}x`,
    })

    expect(limited.statusCode).toBe(429)
    expect(limited.jsonBody).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many failed login attempts. Try again later.',
      },
    })
  })

  it('rejects an expired token with token_expired (does not consume rate-limit budget)', async () => {
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 5_000 })
    const settings = createSettings({
      workspaceAgents: createSettings().workspaceAgents.map((agent) =>
        agent.id === 'agent-1'
          ? {
              ...agent,
              shareTokens: (agent.shareTokens ?? []).map((token) => ({
                ...token,
                // Expired 1ms before "now" — boundary check ensures strict <=.
                expiresAt: 4_999,
              })),
            }
          : agent,
      ),
    })
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 5_000,
    })

    const res = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'token_expired',
        message: 'This share token has expired.',
      },
    })

    // Crucial: an expired token should NOT consume the rate-limit budget,
    // because it's a state-of-record problem rather than a brute-force signal.
    // Spam-firing the same expired token shouldn't trip the 429 ceiling.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const repeat = await dispatch(router, 'POST', '/api/web/auth/login', {
        token: VALID_TOKEN,
      })
      expect(repeat.statusCode).toBe(401)
      expect(readErrorCode(repeat.jsonBody)).toBe('token_expired')
    }
  })

  it('rejects a disabled token with token_disabled (does not consume rate-limit budget)', async () => {
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 1_000 })
    const settings = createSettings({
      workspaceAgents: createSettings().workspaceAgents.map((agent) =>
        agent.id === 'agent-1'
          ? {
              ...agent,
              shareTokens: (agent.shareTokens ?? []).map((token) => ({
                ...token,
                disabled: true,
              })),
            }
          : agent,
      ),
    })
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 1_000,
    })

    const res = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'token_disabled',
        message: 'This share token has been disabled.',
      },
    })

    // Same as expired: repeated rejections shouldn't burn the limiter — the
    // attacker has nothing to brute-force when the matching record is just
    // turned off.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const repeat = await dispatch(router, 'POST', '/api/web/auth/login', {
        token: VALID_TOKEN,
      })
      expect(repeat.statusCode).toBe(401)
      expect(readErrorCode(repeat.jsonBody)).toBe('token_disabled')
    }
  })

  it('disabled status takes precedence over expiry in the rejection reason', async () => {
    // When a token is both expired AND disabled, we surface the disabled
    // status — that's the more recent admin action and matches the
    // findMatchingShareToken loop order (disabled check before expiry).
    const router = new WebRouter()
    const sessionStore = new WebSessionStore({ now: () => 10_000 })
    const settings = createSettings({
      workspaceAgents: createSettings().workspaceAgents.map((agent) =>
        agent.id === 'agent-1'
          ? {
              ...agent,
              shareTokens: (agent.shareTokens ?? []).map((token) => ({
                ...token,
                disabled: true,
                expiresAt: 1, // also in the past
              })),
            }
          : agent,
      ),
    })
    const resolver = createResolver(settings, sessionStore)

    registerAuthRoutes(router, {
      getSettings: () => settings,
      pepper: PEPPER,
      sessionStore,
      resolver,
      vaultIdentity: 'vault-a',
      now: () => 10_000,
    })

    const res = await dispatch(router, 'POST', '/api/web/auth/login', {
      token: VALID_TOKEN,
    })

    expect(res.statusCode).toBe(401)
    expect(readErrorCode(res.jsonBody)).toBe('token_disabled')
  })
})

function createSettings(
  overrides: Partial<ReturnType<typeof parseYoloSettings>> = {},
) {
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
            tokenHashVersion: 'hmac-sha256-v1',
            scope: {
              kind: 'workspaceRoot',
              rootHash: hashWorkspaceRoot('/', 'vault-a'),
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
    ...overrides,
  })
}

function createResolver(
  settings: ReturnType<typeof parseYoloSettings>,
  sessionStore: WebSessionStore,
) {
  return createWebAgentContextResolver({
    getSettings: () => settings,
    getSession: (sessionId) => {
      const session = sessionId ? sessionStore.resolve(sessionId) : null
      if (!session) {
        return null
      }
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
    vaultIdentity: 'vault-a',
  })
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
  stream.socket = { remoteAddress: '203.0.113.4' }
  return stream
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    headers: Record<string, string>
    setHeader: (name: string, value: string) => void
    end: (chunk?: string) => void
    write: (chunk: string) => void
    jsonBody: unknown
  }
  response.statusCode = 200
  response.writableEnded = false
  response.headers = {}
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = value
  }
  response.write = (chunk) => {
    rawBody += chunk
  }
  response.end = (chunk) => {
    if (chunk) {
      rawBody += chunk
    }
    response.writableEnded = true
  }
  Object.defineProperty(response, 'jsonBody', {
    get() {
      return rawBody ? (JSON.parse(rawBody) as unknown) : null
    },
  })
  return response
}

function readErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined
  }
  const maybeError = (body as { error?: unknown }).error
  if (!maybeError || typeof maybeError !== 'object') {
    return undefined
  }
  const code = (maybeError as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
