/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type { WebChatConversation } from '../webAgentTypes'
import { WebRouter } from '../WebRouter'

import { registerCitationRoutes } from './citationRoutes'

describe('citationRoutes', () => {
  it('returns invalid_request when conversationId is missing', async () => {
    const router = new WebRouter()
    registerCitationRoutes(router, {
      getChat: jest.fn(),
      resolveCitationBinding: createBindingResolver(),
    })

    const resolved = router.resolve('GET', '/api/citation/1')
    const req = createRequest({
      method: 'GET',
      url: '/api/citation/1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, { id: '1' })

    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message: 'conversationId is required',
      },
    })
  })

  it('rejects client-supplied workspace ids', async () => {
    const router = new WebRouter()
    registerCitationRoutes(router, {
      getChat: jest.fn(),
      resolveCitationBinding: createBindingResolver(),
    })

    const resolved = router.resolve(
      'GET',
      '/api/citation/1?conversationId=conv-1&workspaceId=ws-a',
    )
    const req = createRequest({
      method: 'GET',
      url: '/api/citation/1?conversationId=conv-1&workspaceId=ws-a',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, { id: '1' })

    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'agentId, assistantId, activeAgentId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected citation routes',
      },
    })
  })

  it('returns not_found for cross-root conversation mismatches', async () => {
    const router = new WebRouter()
    const chat: WebChatConversation = {
      id: 'conv-1',
      title: 'Workspace chat',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
      workspaceId: null,
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-b',
      },
    }
    registerCitationRoutes(router, {
      getChat: jest.fn().mockResolvedValue(chat),
      resolveCitationBinding: createBindingResolver(),
    })

    const resolved = router.resolve(
      'GET',
      '/api/citation/1?conversationId=conv-1',
    )
    const req = createRequest({
      method: 'GET',
      url: '/api/citation/1?conversationId=conv-1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, { id: '1' })

    expect(res.statusCode).toBe(404)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'not_found',
        message: 'Not found',
      },
    })
  })

  it('returns not_found when same-root conversation active agent is not authorized', async () => {
    const router = new WebRouter()
    const chat: WebChatConversation = {
      id: 'conv-1',
      title: 'Unauthorized agent chat',
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
      workspaceId: null,
      webBinding: {
        initialAgentId: 'agent-2',
        activeAgentId: 'agent-2',
        rootHash: 'root-a',
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Answer',
          metadata: {
            sources: [
              {
                ordinal: 1,
                path: 'docs/a.md',
                startLine: 1,
                endLine: 1,
                snippet: 'alpha',
                source: 'rag',
              },
            ],
          },
        },
      ],
    }
    registerCitationRoutes(router, {
      getChat: jest.fn().mockResolvedValue(chat),
      resolveCitationBinding: createBindingResolver({
        activeAgentId: 'agent-1',
        allowedAgentIds: ['agent-1'],
      }),
    })

    const resolved = router.resolve(
      'GET',
      '/api/citation/1?conversationId=conv-1',
    )
    const req = createRequest({
      method: 'GET',
      url: '/api/citation/1?conversationId=conv-1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, { id: '1' })

    expect(res.statusCode).toBe(404)
  })

  it('returns a matching citation source for an authorized web conversation', async () => {
    const router = new WebRouter()
    const chat: WebChatConversation = {
      id: 'conv-1',
      title: 'Global chat',
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
      workspaceId: null,
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-a',
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Answer',
          metadata: {
            sources: [
              {
                ordinal: 1,
                path: 'docs/a.md',
                startLine: 4,
                endLine: 8,
                snippet: 'alpha',
                source: 'rag',
              },
            ],
          },
        },
      ],
    }
    registerCitationRoutes(router, {
      getChat: jest.fn().mockResolvedValue(chat),
      resolveCitationBinding: createBindingResolver(),
    })

    const resolved = router.resolve(
      'GET',
      '/api/citation/1?conversationId=conv-1',
    )
    const req = createRequest({
      method: 'GET',
      url: '/api/citation/1?conversationId=conv-1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, { id: '1' })

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      ordinal: 1,
      path: 'docs/a.md',
      startLine: 4,
      endLine: 8,
      snippet: 'alpha',
      source: 'rag',
    })
  })

  it('returns not_found for orphaned web conversations', async () => {
    const router = new WebRouter()
    const chat: WebChatConversation = {
      id: 'conv-1',
      title: 'Orphaned chat',
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
      workspaceId: null,
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-a',
        accessState: 'orphaned',
        orphanedReason: 'agent_deleted',
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Answer',
          metadata: {
            sources: [
              {
                ordinal: 1,
                path: 'docs/a.md',
                startLine: 1,
                endLine: 1,
                snippet: 'alpha',
                source: 'rag',
              },
            ],
          },
        },
      ],
    }
    registerCitationRoutes(router, {
      getChat: jest.fn().mockResolvedValue(chat),
      resolveCitationBinding: createBindingResolver(),
    })

    const resolved = router.resolve(
      'GET',
      '/api/citation/1?conversationId=conv-1',
    )
    const req = createRequest({
      method: 'GET',
      url: '/api/citation/1?conversationId=conv-1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, { id: '1' })

    expect(res.statusCode).toBe(404)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'not_found',
        message: 'Not found',
      },
    })
  })

  it('returns not_found when citation source path is denied by active agent policy', async () => {
    const router = new WebRouter()
    const chat: WebChatConversation = {
      id: 'conv-1',
      title: 'Denied citation',
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
      workspaceId: null,
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-a',
      },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Answer',
          metadata: {
            sources: [
              {
                ordinal: 1,
                path: 'Private/secret.md',
                startLine: 1,
                endLine: 1,
                snippet: 'secret',
                source: 'rag',
              },
            ],
          },
        },
      ],
    }
    registerCitationRoutes(router, {
      getChat: jest.fn().mockResolvedValue(chat),
      resolveCitationBinding: createBindingResolver(),
    })

    const resolved = router.resolve(
      'GET',
      '/api/citation/1?conversationId=conv-1',
    )
    const req = createRequest({
      method: 'GET',
      url: '/api/citation/1?conversationId=conv-1',
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, { id: '1' })

    expect(res.statusCode).toBe(404)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'not_found',
        message: 'Not found',
      },
    })
  })
})

function createBindingResolver(
  overrides: Partial<{
    activeAgentId: string
    allowedAgentIds: string[]
  }> = {},
) {
  return jest.fn().mockReturnValue({
    ok: true,
    binding: {
      activeAgentId: overrides.activeAgentId ?? 'agent-1',
      allowedAgentIds: overrides.allowedAgentIds ?? ['agent-1'],
      rootHash: 'root-a',
      policy: {
        workspaceRoot: '/',
        readAllowlist: [],
        readDenylist: ['/Private'],
        writeDenylist: [],
      },
    },
  })
}

function createRequest({ method, url }: { method: string; url: string }) {
  const stream = Readable.from([]) as Readable &
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
