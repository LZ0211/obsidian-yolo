/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
jest.mock('node:zlib', () => {
  const actual = jest.requireActual<typeof import('node:zlib')>('node:zlib')
  return {
    ...actual,
    brotliCompress: jest.fn(actual.brotliCompress),
  }
})

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { brotliCompress, brotliDecompressSync } from 'node:zlib'

import { WebHttpServer } from './WebHttpServer'

describe('WebHttpServer auth', () => {
  it('defers Node HTTP and compression modules until the server is used', () => {
    const source = readFileSync(
      path.join(__dirname, 'WebHttpServer.ts'),
      'utf8',
    )

    expect(source).not.toMatch(
      /import\s*\{[\s\S]*?createServer,[\s\S]*?\}\s*from 'node:http'/,
    )
    expect(source).not.toMatch(
      /import \{ brotliCompress, gzip \} from 'node:zlib'/,
    )
    expect(source).toContain('loadDesktopNodeModuleSync')
  })

  it('answers CORS preflight before bearer-token authorization', async () => {
    const server = new WebHttpServer({
      host: '0.0.0.0',
      token: 'secret',
    })
    const response = createResponse()

    await server.handleRequest(
      {
        method: 'OPTIONS',
        url: '/api/settings',
        headers: { origin: 'http://127.0.0.1:19091' },
      } as never,
      response as never,
    )

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(response.headers['access-control-allow-methods']).toContain('GET')
    expect(response.headers['access-control-allow-headers']).toContain(
      'Authorization',
    )
  })

  it('adds CORS headers to JSON responses', async () => {
    const server = new WebHttpServer({
      host: '127.0.0.1',
      token: '',
    })
    server.router.get('/ok', (_req, res) => {
      res.statusCode = 200
      res.end('ok')
    })
    const response = createResponse()

    await server.handleRequest(
      { method: 'GET', url: '/ok', headers: {} } as never,
      response as never,
    )

    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe('*')
  })

  it('requires bearer token on non-loopback bind hosts', () => {
    const server = new WebHttpServer({
      host: '0.0.0.0',
      token: 'secret',
    })

    expect(server.isAuthorizedRequest({ authorization: undefined })).toBe(false)
    expect(server.isAuthorizedRequest({ authorization: 'Bearer wrong' })).toBe(
      false,
    )
    expect(server.isAuthorizedRequest({ authorization: 'Bearer secret' })).toBe(
      true,
    )
  })

  it('allows shared web auth and bootstrap routes without the server-wide bearer token', () => {
    const server = new WebHttpServer({
      host: '0.0.0.0',
      token: 'secret',
    })

    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        url: '/api/bootstrap',
      }),
    ).toBe(true)
    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        url: '/api/web/auth/login',
      }),
    ).toBe(true)
    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        url: '/index.html',
      }),
    ).toBe(true)
    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        url: '/api/settings',
      }),
    ).toBe(false)
  })

  it('allows shared web API routes with a web session header without the server-wide bearer token', () => {
    const server = new WebHttpServer({
      host: '0.0.0.0',
      token: 'secret',
    })

    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        webSessionId: 'session-1',
        url: '/api/settings',
      }),
    ).toBe(true)
    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        webSessionId: 'session-1',
        url: '/api/chat/list',
      }),
    ).toBe(true)
    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        webSessionId: 'session-1',
        url: '/api/agents',
      }),
    ).toBe(true)
    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        webSessionId: 'session-1',
        url: '/api/skills',
      }),
    ).toBe(true)
  })

  it('does not allow operator APIs with only a shared web session header', () => {
    const server = new WebHttpServer({
      host: '0.0.0.0',
      token: 'secret',
    })

    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        webSessionId: 'session-1',
        url: '/api/mcp/list-tools',
      }),
    ).toBe(false)
  })

  it('allows missing token on loopback bind hosts', () => {
    const server = new WebHttpServer({
      host: '127.0.0.1',
      token: '',
    })

    expect(server.isAuthorizedRequest({ authorization: undefined })).toBe(true)
  })

  it('rejects query string tokens', () => {
    const server = new WebHttpServer({
      host: '0.0.0.0',
      token: 'secret',
    })

    expect(
      server.isAuthorizedRequest({
        authorization: undefined,
        url: '/api/chat/list?token=secret',
      }),
    ).toBe(false)
  })

  it('does not reject token substrings outside the token query parameter', () => {
    const server = new WebHttpServer({
      host: '0.0.0.0',
      token: 'secret',
    })

    expect(
      server.isAuthorizedRequest({
        authorization: 'Bearer secret',
        url: '/api/file/content?path=token_config.md',
      }),
    ).toBe(true)
  })

  it('returns json internal errors for route failures', async () => {
    const server = new WebHttpServer({
      host: '127.0.0.1',
      token: '',
    })
    server.router.get('/boom', () => {
      throw new Error('boom')
    })
    const response = createResponse()

    await server.handleRequest(
      { method: 'GET', url: '/boom', headers: {} } as never,
      response as never,
    )

    expect(response.statusCode).toBe(500)
    expect(response.jsonBody).toEqual({
      error: { code: 'internal_error', message: 'boom' },
    })
  })

  it('uses asynchronous Brotli compression for large JSON responses', async () => {
    const server = new WebHttpServer({
      host: '127.0.0.1',
      token: '',
    })
    const body = JSON.stringify({ value: 'x'.repeat(2048) })
    server.router.get('/compressed', (_req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(body)
    })
    const response = createResponse()

    await server.handleRequest(
      {
        method: 'GET',
        url: '/compressed',
        headers: { 'accept-encoding': 'br' },
      } as never,
      response as never,
    )

    expect(brotliCompress).toHaveBeenCalled()
    await waitFor(() => response.writableEnded)
    expect(response.headers['content-encoding']).toBe('br')
    expect(brotliDecompressSync(response.rawBody).toString('utf8')).toBe(body)
  })
})

function createResponse() {
  let rawBody = Buffer.alloc(0)
  const response = {
    statusCode: 200,
    writableEnded: false,
    headers: {} as Record<string, string>,
    setHeader: jest.fn((name: string, value: string) => {
      response.headers[name.toLowerCase()] = value
    }),
    getHeader: (name: string) => response.headers[name.toLowerCase()],
    removeHeader: (name: string) => {
      Reflect.deleteProperty(response.headers, name.toLowerCase())
    },
    end: (chunk?: string | Buffer) => {
      if (chunk) {
        rawBody = Buffer.concat([
          rawBody,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        ])
      }
      response.writableEnded = true
    },
    get jsonBody() {
      return JSON.parse(rawBody.toString('utf8')) as unknown
    },
    get rawBody() {
      return rawBody
    },
  }
  return response
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition not met')
}
