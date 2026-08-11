/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { SETTINGS_SCHEMA_VERSION } from '../../../settings/schema/migrations'
import { parseYoloSettings } from '../../../settings/schema/settings'
import type { ResolvedWebAgentContext } from '../webAgentTypes'
import { WebRouter } from '../WebRouter'

import { registerBootstrapRoutes } from './bootstrapRoutes'

describe('bootstrapRoutes', () => {
  it('returns setup bootstrap state when no remote agents are configured', async () => {
    const router = new WebRouter()
    registerBootstrapRoutes(router, {
      host: '0.0.0.0',
      port: 18900,
      getSettings: () =>
        parseYoloSettings({
          version: SETTINGS_SCHEMA_VERSION,
          webRuntime: {
            enabled: true,
            host: '0.0.0.0',
            port: 18900,
            token: 'secret',
          },
          workspaceAgents: [],
        }),
      getSessionContext: () => null,
    })

    const resolved = router.resolve('GET', '/api/bootstrap')
    const req = createRequest('/api/bootstrap')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      serverUrl: 'http://0.0.0.0:18900',
      phase: 1,
      authRequired: true,
      workspaceAgentConfigured: false,
      session: null,
      allowedAgents: [],
      settings: {
        webRuntimeEnabled: true,
      },
    })
  })

  it('returns session summary and allowed agents when a web session is active', async () => {
    const router = new WebRouter()
    registerBootstrapRoutes(router, {
      host: '0.0.0.0',
      port: 18900,
      getSettings: () =>
        parseYoloSettings({
          version: SETTINGS_SCHEMA_VERSION,
          webRuntime: {
            enabled: true,
            host: '0.0.0.0',
            port: 18900,
            token: 'secret',
          },
          assistants: [
            {
              id: 'template-1',
              name: 'Template',
              modePolicy: {
                kind: 'fixed',
                mode: 'ask',
              },
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
              shareTokens: [],
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
          ],
          currentWorkspaceAgentId: 'agent-1',
        }),
      getSessionContext: () =>
        ({
          sessionId: 'session-1',
          tokenScope: {
            kind: 'workspaceRoot',
            rootHash: 'root-1',
            issuedForAgentId: 'agent-1',
          },
          activeAgent: {
            id: 'agent-1',
            name: 'Agent One',
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
            systemPrompt: '',
            description: '',
            modelId: '',
            persona: undefined,
            enableTools: false,
            includeBuiltinTools: true,
            enabledToolNames: [],
            toolPreferences: {},
            toolServerPreferences: {},
            enabledSkills: [],
            skillPreferences: {},
            enableProjectInstructions: true,
            includeCurrentFileContent: true,
            timeContextEnabled: true,
            agentModeAllowed: true,
          },
          template: {
            id: 'template-1',
            name: 'Template',
            systemPrompt: '',
          },
          rootHash: 'root-1',
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
        }) satisfies ResolvedWebAgentContext,
    })

    const resolved = router.resolve('GET', '/api/bootstrap')
    const req = createRequest('/api/bootstrap', {
      'x-yolo-web-session-id': 'session-1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      serverUrl: 'http://0.0.0.0:18900',
      phase: 1,
      authRequired: true,
      workspaceAgentConfigured: true,
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
      settings: {
        webRuntimeEnabled: true,
      },
    })
  })

  it('surfaces workspaceRoot from the active assistant template policy', async () => {
    const router = new WebRouter()
    registerBootstrapRoutes(router, {
      host: '0.0.0.0',
      port: 18900,
      getSettings: () =>
        parseYoloSettings({
          version: SETTINGS_SCHEMA_VERSION,
          webRuntime: {
            enabled: true,
            host: '0.0.0.0',
            port: 18900,
            token: 'secret',
          },
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
              shareTokens: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          currentWorkspaceAgentId: 'agent-1',
        }),
      getSessionContext: () =>
        ({
          sessionId: 'session-1',
          tokenScope: {
            kind: 'workspaceRoot',
            rootHash: 'root-1',
            issuedForAgentId: 'agent-1',
          },
          activeAgent: {
            id: 'agent-1',
            name: 'Agent One',
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
            systemPrompt: '',
            description: '',
            modelId: '',
            persona: undefined,
            enableTools: false,
            includeBuiltinTools: true,
            enabledToolNames: [],
            toolPreferences: {},
            toolServerPreferences: {},
            enabledSkills: [],
            skillPreferences: {},
            enableProjectInstructions: true,
            includeCurrentFileContent: true,
            timeContextEnabled: true,
            agentModeAllowed: true,
          },
          template: {
            id: 'template-1',
            name: 'Template',
            systemPrompt: '',
            workspaceAccessPolicy: {
              enabled: true,
              workspaceRoot: 'Notes/Project',
              readExtraIncludes: [],
              readExcludes: [],
              writeExcludes: [],
            },
          },
          rootHash: 'root-1',
          allowedAgents: [],
        }) satisfies ResolvedWebAgentContext,
    })

    const resolved = router.resolve('GET', '/api/bootstrap')
    const req = createRequest('/api/bootstrap', {
      'x-yolo-web-session-id': 'session-1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toMatchObject({
      workspaceRoot: 'Notes/Project',
    })
  })

  it('omits workspaceRoot when the access policy is disabled', async () => {
    const router = new WebRouter()
    registerBootstrapRoutes(router, {
      host: '0.0.0.0',
      port: 18900,
      getSettings: () =>
        parseYoloSettings({
          version: SETTINGS_SCHEMA_VERSION,
          webRuntime: {
            enabled: true,
            host: '0.0.0.0',
            port: 18900,
            token: 'secret',
          },
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
              shareTokens: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          currentWorkspaceAgentId: 'agent-1',
        }),
      getSessionContext: () =>
        ({
          sessionId: 'session-1',
          tokenScope: {
            kind: 'workspaceRoot',
            rootHash: 'root-1',
            issuedForAgentId: 'agent-1',
          },
          activeAgent: {
            id: 'agent-1',
            name: 'Agent One',
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
            systemPrompt: '',
            description: '',
            modelId: '',
            persona: undefined,
            enableTools: false,
            includeBuiltinTools: true,
            enabledToolNames: [],
            toolPreferences: {},
            toolServerPreferences: {},
            enabledSkills: [],
            skillPreferences: {},
            enableProjectInstructions: true,
            includeCurrentFileContent: true,
            timeContextEnabled: true,
            agentModeAllowed: true,
          },
          template: {
            id: 'template-1',
            name: 'Template',
            systemPrompt: '',
            workspaceAccessPolicy: {
              enabled: false,
              workspaceRoot: 'ShouldNotLeakWhenDisabled',
              readExtraIncludes: [],
              readExcludes: [],
              writeExcludes: [],
            },
          },
          rootHash: 'root-1',
          allowedAgents: [],
        }) satisfies ResolvedWebAgentContext,
    })

    const resolved = router.resolve('GET', '/api/bootstrap')
    const req = createRequest('/api/bootstrap', {
      'x-yolo-web-session-id': 'session-1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(200)
    expect(
      (res.jsonBody as { workspaceRoot?: unknown }).workspaceRoot,
    ).toBeUndefined()
  })

  it('treats only disabled workspace agents as setup-incomplete', async () => {
    const router = new WebRouter()
    registerBootstrapRoutes(router, {
      host: '0.0.0.0',
      port: 18900,
      getSettings: () =>
        parseYoloSettings({
          version: SETTINGS_SCHEMA_VERSION,
          webRuntime: {
            enabled: true,
            host: '0.0.0.0',
            port: 18900,
            token: 'secret',
          },
          assistants: [
            {
              id: 'template-1',
              name: 'Template',
            },
          ],
          workspaceAgents: [
            {
              id: 'agent-1',
              name: 'Agent One',
              templateId: 'template-1',
              disabled: true,
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
          ],
        }),
      getSessionContext: () => null,
    })

    const resolved = router.resolve('GET', '/api/bootstrap')
    const req = createRequest('/api/bootstrap')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toMatchObject({
      workspaceAgentConfigured: false,
    })
  })
})

function createRequest(url: string, headers: Record<string, string> = {}) {
  const stream = Readable.from([]) as Readable &
    EventEmitter & {
      method?: string
      url?: string
      headers: Record<string, string>
    }
  stream.method = 'GET'
  stream.url = url
  stream.headers = headers
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
