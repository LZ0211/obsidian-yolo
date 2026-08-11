/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { Readable } from 'node:stream'

import { readJsonBody } from './routeUtils'

describe('routeUtils', () => {
  it('rejects oversized JSON bodies before parsing', async () => {
    const result = await readJsonBody(Readable.from(['{"value":"abcdef"}']), {
      maxBytes: 8,
    })

    expect(result).toEqual({
      ok: false,
      statusCode: 413,
      body: {
        error: {
          code: 'request_too_large',
          message: 'JSON body is too large',
        },
      },
    })
  })
})
