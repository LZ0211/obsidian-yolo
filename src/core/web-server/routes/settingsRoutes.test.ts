/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import { parseYoloSettings } from '../../../settings/schema/settings'
import { WebRouter } from '../WebRouter'

import { registerSettingsRoutes } from './settingsRoutes'

describe('settingsRoutes', () => {
  it('redacts webRuntime token from the response', async () => {
    const router = new WebRouter()
    registerSettingsRoutes(router, {
      getSettings: () =>
        parseYoloSettings({
          webRuntime: {
            enabled: true,
            host: '0.0.0.0',
            port: 18900,
            token: 'secret-token',
          },
        }),
    })

    const resolved = router.resolve('GET', '/api/settings')
    const req = createRequest('/api/settings')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { webRuntime?: { token: string } }
    expect(body.webRuntime?.token).toBe('')
  })

  it('redacts the local MCP server bearer token from the response', async () => {
    const parsedSettings = parseYoloSettings({})
    parsedSettings.mcp.localServer = {
      enabled: true,
      port: 18999,
      token: 'mcp-secret-token',
    }
    const router = new WebRouter()
    registerSettingsRoutes(router, {
      getSettings: () => parsedSettings,
    })

    const resolved = router.resolve('GET', '/api/settings')
    const req = createRequest('/api/settings')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      mcp?: { localServer?: { token?: string } }
    }
    expect(body.mcp?.localServer?.token).toBe('')
  })

  it('requires web session access when a resolver is provided', async () => {
    const router = new WebRouter()
    registerSettingsRoutes(router, {
      getSettings: () => parseYoloSettings({}),
      resolveSettingsAccess: () => ({
        ok: false,
        statusCode: 401,
        body: {
          error: {
            code: 'session_expired',
            message: 'The web session has expired.',
          },
        },
      }),
    })

    const resolved = router.resolve('GET', '/api/settings')
    const req = createRequest('/api/settings')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'session_expired',
        message: 'The web session has expired.',
      },
    })
  })

  it('redacts share token hashes from the web settings response', async () => {
    const router = new WebRouter()
    registerSettingsRoutes(router, {
      getSettings: () => ({
        ...parseYoloSettings({
          assistants: [{ id: 'template-1', name: 'Template' }],
        }),
        workspaceAgents: [
          {
            id: 'agent-1',
            name: 'Agent',
            templateId: 'template-1',
            workspacePolicy: {
              workspaceRoot: '/',
              readAllowlist: [],
              readDenylist: [],
              writeDenylist: [],
            },
            shareTokens: [
              {
                id: 'token-1',
                tokenHash: 'hmac-sha256-v1:secret-hash',
                tokenHashVersion: 'hmac-sha256-v1',
                scope: { kind: 'agent', agentId: 'agent-1' },
                createdAt: 1,
              },
            ],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      resolveSettingsAccess: () => ({ ok: true }),
    })

    const resolved = router.resolve('GET', '/api/settings')
    const req = createRequest('/api/settings')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    const body = res.jsonBody as {
      workspaceAgents: Array<{ shareTokens?: Array<{ tokenHash: string }> }>
    }
    expect(body.workspaceAgents[0]?.shareTokens?.[0]?.tokenHash).toBe('')
  })

  it('filters assistants (not just workspaceAgents) by the session allowedAgents scope', async () => {
    // Regression: /api/settings used to filter workspaceAgents by token scope
    // but forgot to apply the same filter to the raw assistants array, so a
    // scoped web session could still see every assistant template via
    // runtime.getAgents() (which re-derives the unified list client-side from
    // this response).
    const router = new WebRouter()
    // parseYoloSettings runs a full version-migration pipeline whenever the
    // input object has any keys, which discards ad hoc partial assistant
    // fixtures; build on top of the migration-free `{}` defaults instead so
    // our custom assistants survive untouched.
    const baseSettings: YoloSettings = {
      ...parseYoloSettings({}),
      assistants: [
        { id: 'template-allowed', name: 'Allowed', systemPrompt: '' },
        { id: 'template-hidden', name: 'Hidden', systemPrompt: '' },
      ],
    }
    registerSettingsRoutes(router, {
      getSettings: () => baseSettings,
      resolveSettingsAccess: () => ({ ok: true }),
      getSessionContext: () => ({
        sessionId: 'session-1',
        tokenScope: { kind: 'agent', agentId: 'template-allowed' },
        activeAgent: {} as never,
        template: {} as never,
        rootHash: '',
        allowedAgents: [
          { id: 'template-allowed', name: 'Allowed', agentModeAllowed: true },
        ],
      }),
    })

    const resolved = router.resolve('GET', '/api/settings')
    const req = createRequest('/api/settings')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    const body = res.jsonBody as { assistants: Array<{ id: string }> }
    expect(body.assistants.map((a) => a.id)).toEqual(['template-allowed'])
  })

  it('keeps a workspace agent template visible even though the template id differs from the agent id', async () => {
    // Regression: allowedAgents lists *agent* ids, which are never the same
    // as the workspace agent's templateId. Filtering settings.assistants by
    // allowedIds directly stripped out every template — including the one
    // backing the session's own allowed agent — which made
    // getUnifiedAgentList() on the client unable to resolve any workspace
    // agent at all, emptying the assistant dropdown entirely.
    const router = new WebRouter()
    const baseSettings: YoloSettings = {
      ...parseYoloSettings({}),
      assistants: [
        { id: 'template-1', name: 'Template', systemPrompt: '' },
        { id: 'template-hidden', name: 'Hidden', systemPrompt: '' },
      ],
      workspaceAgents: [
        {
          id: 'agent-1',
          name: 'Agent',
          templateId: 'template-1',
          workspacePolicy: {
            workspaceRoot: '/',
            readAllowlist: [],
            readDenylist: [],
            writeDenylist: [],
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }
    registerSettingsRoutes(router, {
      getSettings: () => baseSettings,
      resolveSettingsAccess: () => ({ ok: true }),
      getSessionContext: () => ({
        sessionId: 'session-1',
        tokenScope: { kind: 'agent', agentId: 'agent-1' },
        activeAgent: {} as never,
        template: {} as never,
        rootHash: '',
        allowedAgents: [
          { id: 'agent-1', name: 'Agent', agentModeAllowed: true },
        ],
      }),
    })

    const resolved = router.resolve('GET', '/api/settings')
    const req = createRequest('/api/settings')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    const body = res.jsonBody as {
      assistants: Array<{ id: string }>
      workspaceAgents: Array<{ id: string }>
    }
    expect(body.assistants.map((a) => a.id)).toEqual(['template-1'])
    expect(body.workspaceAgents.map((a) => a.id)).toEqual(['agent-1'])
  })
})

function createRequest(url: string) {
  const stream = Readable.from([]) as Readable &
    EventEmitter & {
      method?: string
      url?: string
      headers: Record<string, string>
    }
  stream.method = 'GET'
  stream.url = url
  stream.headers = {}
  return stream
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    setHeader: (_name: string, _value: string) => void
    end: (chunk?: string) => void
    write: (chunk: string) => void
    jsonBody: unknown
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
  Object.defineProperty(response, 'jsonBody', {
    get() {
      return rawBody ? (JSON.parse(rawBody) as unknown) : null
    },
  })
  return response
}

describe('settingsRoutes protected path privacy', () => {
  const POLICY = {
    workspaceRoot: 'vault/private-root',
    readAllowlist: [],
    readDenylist: [],
    writeDenylist: [],
  }

  function registerWithAgents() {
    const router = new WebRouter()
    registerSettingsRoutes(router, {
      getSettings: () => ({
        ...parseYoloSettings({
          assistants: [
            {
              id: 'template-1',
              name: 'Template',
              workspaceAccessPolicy: {
                enabled: true,
                workspaceRoot: 'vault/secret-root',
                readExtraIncludes: ['vault/hidden-a'],
                readExcludes: [],
                writeExcludes: [],
                protectedPaths: [
                  { kind: 'prefix', path: 'vault/secret' },
                  { kind: 'exact', path: 'vault/do-not-open.md' },
                ],
              },
            },
          ],
        }),
        workspaceAgents: [
          {
            id: 'agent-1',
            name: 'Agent',
            templateId: 'template-1',
            workspacePolicy: POLICY,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      resolveSettingsAccess: () => ({ ok: true }),
    })
    return router
  }

  async function fetchSettings(router: WebRouter) {
    const req = createRequest('/api/settings')
    const res = createResponse()
    await router.resolve('GET', '/api/settings')?.handler(
      req as never,
      res as never,
      {},
    )
    return res.jsonBody as Record<string, unknown>
  }

  it('strips workspacePolicy (workspaceRoot + protected paths) from workspace agents', async () => {
    const body = await fetchSettings(registerWithAgents())
    const agents = body.workspaceAgents as Array<Record<string, unknown>>
    expect(agents[0]).not.toHaveProperty('workspacePolicy')
    expect(JSON.stringify(body)).not.toContain('private-root')
  })

  it('strips workspaceAccessPolicy (protected paths) from assistant templates', async () => {
    const body = await fetchSettings(registerWithAgents())
    const assistants = body.assistants as Array<Record<string, unknown>>
    expect(assistants[0]).not.toHaveProperty('workspaceAccessPolicy')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('secret-root')
    expect(serialized).not.toContain('vault/hidden-a')
    expect(serialized).not.toContain('do-not-open')
  })
})
