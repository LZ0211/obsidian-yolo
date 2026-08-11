/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { TFile } from 'obsidian'

import { parseYoloSettings } from '../../../settings/schema/settings'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { McpManager } from '../../mcp/mcpManager'
import type { ResolvedWebAgentContext } from '../webAgentTypes'
import { WebRouter } from '../WebRouter'

import { type McpRoutesContext, registerMcpRoutes } from './mcpRoutes'

jest.mock('../../skills/liteSkills', () => ({
  listLiteSkillEntries: jest.fn(async () => [
    {
      name: 'skill-a',
      description: 'A',
      mode: 'lazy',
      path: 'Vault/skills/skill-a.md',
    },
    {
      name: 'skill-b',
      description: 'B',
      mode: 'always',
      path: 'builtin://skill-b',
    },
  ]),
}))

// useChatHistory 模块加载会引入 React app-context，测试环境无 React；
// deserializeChatMessage 的 mentionable 解析复用真实实现（纯模块）。
jest.mock('../../../hooks/useChatHistory', () => {
  const { deserializeMentionable } = jest.requireActual(
    '../../../utils/chat/mentionable',
  )
  return {
    deserializeChatMessage: jest.fn((message: never, app: never) => ({
      ...(message as Record<string, unknown>),
      mentionables: (
        (message as { mentionables?: unknown[] }).mentionables ?? []
      )
        .map((m) => deserializeMentionable(m as never, app))
        .filter((m) => m !== null),
    })),
  }
})

describe('mcpRoutes', () => {
  it('forwards tool listing to the backend MCP manager', async () => {
    const router = new WebRouter()
    const listAvailableTools = jest
      .fn()
      .mockResolvedValue([
        { name: 'builtin__fs_read', description: 'Read file', inputSchema: {} },
      ])
    registerMcpRoutes(router, {
      app: createMockApp(),
      getSettings: () => parseYoloSettings({}),
      getMcpManager: async () =>
        ({
          listAvailableTools,
        }) as never,
      resolveMcpAccess: createAuthorizedResolve(),
    })

    const resolved = router.resolve('POST', '/api/mcp/list-tools')
    const req = createRequest({
      method: 'POST',
      url: '/api/mcp/list-tools',
      body: {
        includeBuiltinTools: true,
        chatModelModalities: ['text'],
      },
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(listAvailableTools).toHaveBeenCalledWith({
      includeBuiltinTools: true,
      chatModelModalities: ['text'],
    })
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual([
      { name: 'builtin__fs_read', description: 'Read file', inputSchema: {} },
    ])
  })

  it('forwards tool allowance to the backend MCP manager', async () => {
    const router = new WebRouter()
    const allowToolForConversation = jest.fn()
    registerMcpRoutes(router, {
      app: createMockApp(),
      getSettings: () => parseYoloSettings({}),
      getMcpManager: async () =>
        ({
          allowToolForConversation,
        }) as never,
      resolveMcpAccess: createAuthorizedResolve(),
    })

    const resolved = router.resolve(
      'POST',
      '/api/mcp/allow-tool-for-conversation',
    )
    const req = createRequest({
      method: 'POST',
      url: '/api/mcp/allow-tool-for-conversation',
      body: {
        requestToolName: 'builtin__fs_read',
        conversationId: 'chat-1',
        requestArgs: { path: 'A.md' },
      },
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(allowToolForConversation).toHaveBeenCalledWith(
      'builtin__fs_read',
      'chat-1',
      { path: 'A.md' },
    )
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ ok: true })
  })

  it('forwards tool calls with hydrated conversation messages', async () => {
    const router = new WebRouter()
    const file = Object.assign(new TFile(), {
      path: 'A.md',
      name: 'A.md',
      basename: 'A',
      extension: 'md',
    })
    const app = createMockApp(file)
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'ok' },
    })
    registerMcpRoutes(router, {
      app,
      getSettings: () => parseYoloSettings({}),
      getMcpManager: async () =>
        ({
          callTool,
        }) as never,
      resolveMcpAccess: createAuthorizedResolve(),
    })

    const resolved = router.resolve('POST', '/api/mcp/call-tool')
    const req = createRequest({
      method: 'POST',
      url: '/api/mcp/call-tool',
      body: {
        name: 'builtin__fs_read',
        args: { path: 'A.md' },
        id: 'tool-1',
        conversationId: 'chat-1',
        conversationMessages: [
          {
            role: 'user',
            id: 'u1',
            content: null,
            mentionables: [{ type: 'file', file: 'A.md' }],
          },
        ],
      },
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'builtin__fs_read',
        args: { path: 'A.md' },
        id: 'tool-1',
        conversationId: 'chat-1',
        conversationMessages: [
          expect.objectContaining({
            role: 'user',
            mentionables: [{ type: 'file', file }],
          }),
        ],
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'ok' },
    })
  })

  it('forwards tool abort to the backend MCP manager', async () => {
    const router = new WebRouter()
    const abortToolCall = jest.fn().mockReturnValue(true)
    registerMcpRoutes(router, {
      app: createMockApp(),
      getSettings: () => parseYoloSettings({}),
      getMcpManager: async () =>
        ({
          abortToolCall,
        }) as never,
      resolveMcpAccess: createAuthorizedResolve(),
    })

    const resolved = router.resolve('POST', '/api/mcp/abort-tool-call')
    const req = createRequest({
      method: 'POST',
      url: '/api/mcp/abort-tool-call',
      body: { id: 'tool-1' },
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(abortToolCall).toHaveBeenCalledWith('tool-1')
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ aborted: true })
  })

  it('rejects unauthenticated list-tools', async () => {
    const { router } = createHarness({ denied: true })
    const res = await dispatch(router, 'POST', '/api/mcp/list-tools', {
      includeBuiltinTools: false,
    })

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'session_expired',
        message: 'The web session has expired.',
      },
    })
  })

  it('rejects unauthenticated allow-tool-for-conversation', async () => {
    const { router } = createHarness({ denied: true })
    const res = await dispatch(
      router,
      'POST',
      '/api/mcp/allow-tool-for-conversation',
      {
        requestToolName: 'builtin__fs_read',
        conversationId: 'chat-1',
      },
    )

    expect(res.statusCode).toBe(401)
  })

  it('rejects unauthenticated call-tool', async () => {
    const { router } = createHarness({ denied: true })
    const res = await dispatch(router, 'POST', '/api/mcp/call-tool', {
      name: 'builtin__fs_read',
      args: { path: 'A.md' },
    })

    expect(res.statusCode).toBe(401)
  })

  it('rejects unauthenticated abort-tool-call', async () => {
    const { router } = createHarness({ denied: true })
    const res = await dispatch(router, 'POST', '/api/mcp/abort-tool-call', {
      id: 'tool-1',
    })

    expect(res.statusCode).toBe(401)
  })

  it('derives workspace policy and skill paths from the session, ignoring client-supplied values', async () => {
    const router = new WebRouter()
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'ok' },
    })
    registerMcpRoutes(router, {
      app: createMockApp(),
      getSettings: () => ({
        ...parseYoloSettings({}),
        skills: { disabledSkillIds: ['skill-a'] },
      }),
      getMcpManager: async () =>
        ({
          callTool,
        }) as never,
      resolveMcpAccess: createAuthorizedResolve(),
    })

    const resolved = router.resolve('POST', '/api/mcp/call-tool')
    const req = createRequest({
      method: 'POST',
      url: '/api/mcp/call-tool',
      body: {
        name: 'builtin__fs_read',
        args: { path: 'A.md' },
        // Client-supplied values must be ignored in favor of the session's
        // active agent policy and enabled skills.
        workspaceAccessPolicy: {
          enabled: false,
          workspaceRoot: '/',
          readExtraIncludes: [],
          readExcludes: [],
          writeExcludes: [],
        },
        allowedSkillPaths: ['/etc/escape'],
      },
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'builtin__fs_read',
        workspaceAccessPolicy: {
          enabled: true,
          workspaceRoot: '/vault',
          readExtraIncludes: ['A.md'],
          readExcludes: [],
          writeExcludes: [],
        },
        allowedSkillPaths: ['builtin://skill-b'],
      }),
    )
    expect(res.statusCode).toBe(200)
  })
})

function createHarness({
  denied = false,
  getMcpManager = async () => ({}),
}: {
  denied?: boolean
  getMcpManager?: () => Promise<Partial<McpManager>>
} = {}) {
  const router = new WebRouter()
  registerMcpRoutes(router, {
    app: createMockApp(),
    getSettings: () => parseYoloSettings({}),
    getMcpManager: getMcpManager as never,
    resolveMcpAccess: denied
      ? createDeniedResolve()
      : createAuthorizedResolve(),
  })
  return { router }
}

function createAuthorizedResolve(): McpRoutesContext['resolveMcpAccess'] {
  return () => ({ ok: true, context: AUTHORIZED_CONTEXT })
}

function createDeniedResolve(): McpRoutesContext['resolveMcpAccess'] {
  return () => ({
    ok: false,
    statusCode: 401,
    body: {
      error: {
        code: 'session_expired',
        message: 'The web session has expired.',
      },
    },
  })
}

const AUTHORIZED_CONTEXT: ResolvedWebAgentContext = {
  sessionId: 'session-1',
  tokenScope: { kind: 'agent', agentId: 'agent-1' },
  activeAgent: {
    id: 'agent-1',
    name: 'Agent 1',
    templateId: 'tpl-1',
    workspacePolicy: {
      workspaceRoot: '/vault',
      readAllowlist: ['A.md'],
      readDenylist: [],
      writeDenylist: [],
    },
    createdAt: 0,
    updatedAt: 0,
    systemPrompt: '',
    description: '',
    modelId: 'model-1',
    persona: 'balanced',
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    toolPreferences: {},
    toolServerPreferences: {},
    enabledSkills: ['skill-a'],
    skillPreferences: {},
    enableProjectInstructions: false,
    includeCurrentFileContent: false,
    timeContextEnabled: false,
    agentModeAllowed: true,
  },
  template: {} as never,
  rootHash: 'root-hash',
  allowedAgents: [],
}

function createMockApp(file: TFile | null = null) {
  return {
    vault: {
      getAbstractFileByPath: jest.fn((path: string) =>
        file?.path === path ? file : null,
      ),
      getFileByPath: jest.fn((path: string) =>
        file?.path === path ? file : null,
      ),
    },
  } as never
}

async function dispatch(
  router: WebRouter,
  method: string,
  url: string,
  body?: unknown,
) {
  const resolved = router.resolve(method, url)
  if (!resolved) {
    throw new Error(`No route for ${method} ${url}`)
  }
  const req = createRequest({ method, url, body })
  const res = createResponse()
  await resolved.handler(req as never, res as never, {})
  return res
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
    setHeader: (name: string, value: string) => void
    end: (chunk?: string) => void
    write: (chunk: string) => void
    jsonBody: unknown
  }
  response.statusCode = 200
  response.writableEnded = false
  response.setHeader = jest.fn()
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
