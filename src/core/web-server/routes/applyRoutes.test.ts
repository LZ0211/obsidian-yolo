/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { WebRouter } from '../WebRouter'

import { registerApplyRoutes } from './applyRoutes'

describe('applyRoutes', () => {
  it('forwards apply review to the backend and returns the user result', async () => {
    const router = new WebRouter()
    const openApplyReview = jest.fn().mockResolvedValue(true)
    registerApplyRoutes(router, {
      openApplyReview,
      resolveApplyAccess: () => ({ ok: true }),
    })

    const resolved = router.resolve('POST', '/api/ui/apply-review')
    const state = {
      filePath: 'note.md',
      original: 'old',
      updated: 'new',
    }
    const req = createRequest({
      method: 'POST',
      url: '/api/ui/apply-review',
      body: { state },
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(openApplyReview).toHaveBeenCalledWith(state)
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ applied: true })
  })

  it('rejects unauthenticated apply-review without invoking the backend', async () => {
    const router = new WebRouter()
    const openApplyReview = jest.fn().mockResolvedValue(true)
    registerApplyRoutes(router, {
      openApplyReview,
      resolveApplyAccess: () => ({
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

    const resolved = router.resolve('POST', '/api/ui/apply-review')
    const req = createRequest({
      method: 'POST',
      url: '/api/ui/apply-review',
      body: {
        state: { filePath: 'note.md', original: 'old', updated: 'new' },
      },
    })
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'session_expired',
        message: 'The web session has expired.',
      },
    })
    expect(openApplyReview).not.toHaveBeenCalled()
  })
})

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
