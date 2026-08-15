/**
 * BS 模式鉴权 e2e：真实 WebHttpServer（非 loopback host -> 强制鉴权），
 * 验证 chat-runtime 路由的 401 / Bearer token / web 会话头三条路径。
 */
/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，直接使用 node 内置模块构造真实服务器 */
/* eslint-disable @typescript-eslint/no-require-imports -- 同文件后续 site 用 require 做惰性模块解析，Node 测试环境允许 */
import { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { registerChatRuntimeRoutes } from './routes/chatRuntimeRoutes'
import { WebHttpServer } from './WebHttpServer'
import { WebRouter } from './WebRouter'

const fakeRuntime = {
  runtimeId: 'codex',
  capabilities: {},
  subscribe: () => () => undefined,
  getSnapshot: () => ({}),
  sendTurn: async () => ({}),
  rewriteTurn: async () => ({ ok: true }),
  rollbackToTurn: async () => ({ ok: true }),
  cancel: async () => ({ ok: true }),
  respondApproval: async () => ({ ok: true }),
  respondQuestion: async () => ({ ok: true }),
  updateConfiguration: async () => ({ ok: true }),
  updatePermissionProfile: async () => ({ ok: true }),
  setSessionPinned: async () => ({ ok: true }),
  compact: async () => ({ ok: true }),
  listSessions: async () => ({ ok: true, sessions: [] }),
  openSession: async () => ({ ok: true }),
  renameSession: async () => ({ ok: true }),
  deleteSession: async () => ({ ok: true }),
  setSessionTitle: async () => ({ ok: true }),
  readSubagent: async () => ({ ok: true, messages: [] }),
  watchSubagent: async () => ({ ok: true, unsubscribe: () => undefined }),
  dispose: async () => undefined,
} as never

const request = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) =>
  new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    const req = (require('node:http') as typeof import('node:http')).request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers,
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          let json: unknown = null
          try {
            json = raw ? JSON.parse(raw) : null
          } catch {
            json = raw
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })

describe('WebHttpServer chat-runtime token auth（BS 模式非 loopback）', () => {
  let server: Server
  let port: number

  beforeAll(async () => {
    const httpServer = new WebHttpServer({
      host: '0.0.0.0',
      port: 0,
      token: 'test-token',
    })
    const router: WebRouter = httpServer.router
    registerChatRuntimeRoutes(router, {
      getChatRuntime: () => fakeRuntime,
    })
    await httpServer.listen()
    server = (httpServer as unknown as { server: Server }).server
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    ;(
      server as Server & { closeAllConnections?: () => void }
    ).closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('rejects chat-runtime calls without credentials', async () => {
    const response = await request(
      port,
      'GET',
      '/api/chat-runtime/codex/sessions',
    )
    expect(response.status).toBe(401)
    expect(response.json).toMatchObject({
      error: { code: 'unauthorized' },
    })
  })

  it('accepts a valid bearer token', async () => {
    const response = await request(
      port,
      'GET',
      '/api/chat-runtime/codex/sessions',
      { authorization: 'Bearer test-token' },
    )
    expect(response.status).toBe(200)
  })

  it('accepts the web session header on chat-runtime routes', async () => {
    const response = await request(
      port,
      'GET',
      '/api/chat-runtime/codex/sessions',
      { 'x-yolo-web-session-id': 'session-1' },
    )
    expect(response.status).toBe(200)
  })

  it('rejects a wrong token', async () => {
    const response = await request(
      port,
      'GET',
      '/api/chat-runtime/codex/sessions',
      { authorization: 'Bearer wrong' },
    )
    expect(response.status).toBe(401)
  })
})
