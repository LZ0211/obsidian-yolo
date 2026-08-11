/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { parseYoloSettings } from '../../../settings/schema/settings'
import { WebRouter } from '../WebRouter'

import { registerSkillRoutes } from './skillRoutes'

jest.mock('../../skills/liteSkills', () => ({
  listLiteSkillEntries: jest.fn(async () => [
    {
      name: 'skill-a',
      description: 'A',
      mode: 'lazy',
      path: 'builtin://skill-a',
    },
    {
      name: 'skill-b',
      description: 'B',
      mode: 'always',
      path: 'Vault/skills/skill-b.md',
    },
  ]),
}))

describe('skillRoutes', () => {
  it('requires an active web session when a resolver is provided', async () => {
    const router = new WebRouter()
    registerSkillRoutes(router, {
      app: {} as never,
      getSettings: () => parseYoloSettings({}),
      resolveSkillsAccess: () => ({
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

    const resolved = router.resolve('GET', '/api/skills')
    const req = createRequest('/api/skills')
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

  it('returns the full skill list for an authorized web session', async () => {
    const router = new WebRouter()
    registerSkillRoutes(router, {
      app: {} as never,
      getSettings: () => parseYoloSettings({}),
      resolveSkillsAccess: () => ({ ok: true }),
    })

    const resolved = router.resolve('GET', '/api/skills')
    const req = createRequest('/api/skills')
    const res = createResponse()

    await resolved?.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual([
      {
        name: 'skill-a',
        description: 'A',
        mode: 'lazy',
        path: 'builtin://skill-a',
      },
      {
        name: 'skill-b',
        description: 'B',
        mode: 'always',
        path: 'Vault/skills/skill-b.md',
      },
    ])
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
