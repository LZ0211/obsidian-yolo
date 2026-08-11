/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
} from 'node:zlib'

import { WebRouter } from '../WebRouter'

import { registerStaticWebRoutes } from './staticWebRoutes'

describe('staticWebRoutes', () => {
  it('defers Node fs and path loading until a desktop static route is served', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'staticWebRoutes.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:(fs|path)'/)
    expect(source).toContain('loadDesktopNodeModuleSync')
  })

  it('serves the web runtime css from the web-ui directory', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-rag-web-static-'))
    fs.mkdirSync(path.join(cwd, 'web-ui', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'web-ui', 'dist', 'app.css'), 'body{}')
    const router = new WebRouter()
    registerStaticWebRoutes(router, { cwd })

    const res = await dispatch(router, '/app.css')

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(res.rawBody).toBe('body{}')
  })

  it('does not register arbitrary static file paths', () => {
    const router = new WebRouter()
    registerStaticWebRoutes(router, { cwd: process.cwd() })

    expect(router.resolve('GET', '/package.json')).toBeNull()
  })

  it('serves the precompressed Brotli JavaScript asset when accepted', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-rag-web-static-'))
    const distDir = path.join(cwd, 'web-ui', 'dist')
    const source = 'globalThis.__webBundle = "brotli";'
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(path.join(distDir, 'index.js'), source)
    fs.writeFileSync(
      path.join(distDir, 'index.js.br'),
      brotliCompressSync(source),
    )
    fs.writeFileSync(path.join(distDir, 'index.js.gz'), gzipSync(source))
    const router = new WebRouter()
    registerStaticWebRoutes(router, { cwd })

    const res = await dispatch(router, '/index.js', {
      'accept-encoding': 'gzip, br',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers.vary).toBe('Accept-Encoding')
    expect(brotliDecompressSync(res.rawBuffer).toString('utf8')).toBe(source)
  })

  it('serves the precompressed gzip JavaScript asset when Brotli is unavailable', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-rag-web-static-'))
    const distDir = path.join(cwd, 'web-ui', 'dist')
    const source = 'globalThis.__webBundle = "gzip";'
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(path.join(distDir, 'index.js'), source)
    fs.writeFileSync(path.join(distDir, 'index.js.gz'), gzipSync(source))
    const router = new WebRouter()
    registerStaticWebRoutes(router, { cwd })

    const res = await dispatch(router, '/index.js', {
      'accept-encoding': 'gzip',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers.vary).toBe('Accept-Encoding')
    expect(gunzipSync(res.rawBuffer).toString('utf8')).toBe(source)
  })

  it('serves the raw JavaScript asset when compression is not accepted', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-rag-web-static-'))
    const distDir = path.join(cwd, 'web-ui', 'dist')
    const source = 'globalThis.__webBundle = "raw";'
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(path.join(distDir, 'index.js'), source)
    fs.writeFileSync(
      path.join(distDir, 'index.js.br'),
      brotliCompressSync(source),
    )
    fs.writeFileSync(path.join(distDir, 'index.js.gz'), gzipSync(source))
    const router = new WebRouter()
    registerStaticWebRoutes(router, { cwd })

    const res = await dispatch(router, '/index.js')

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.rawBody).toBe(source)
  })
})

async function dispatch(
  router: WebRouter,
  url: string,
  headers: Record<string, string> = {},
) {
  const resolved = router.resolve('GET', url)
  if (!resolved) throw new Error(`missing route: ${url}`)
  const req = Object.assign(new EventEmitter(), { headers }) as never
  const res = createResponse()
  // The handler starts an async pipe from a file stream into `res`; the
  // handler's promise resolves synchronously, so wait for the response's
  // 'finish' event before letting the test assert on the body.
  const finished = new Promise<void>((resolve) => {
    res.once('finish', () => resolve())
  })
  await resolved.handler(req, res as never, {})
  await finished
  return res
}

function createResponse() {
  const rawChunks: Buffer[] = []
  // fs.createReadStream(...).pipe(res) treats `res` as a writable stream — it
  // needs `write`, `end`, `destroy`, and `on` to be there. The minimal subset
  // below keeps the pipe happy without pulling in a real Writable.
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    headers: Record<string, string>
    setHeader: (_name: string, _value: string) => void
    write: (chunk: string | Buffer) => boolean
    end: (chunk?: string | Buffer) => void
    destroy: () => void
    rawBody: string
    rawBuffer: Buffer
  }
  response.statusCode = 200
  response.writableEnded = false
  response.headers = {}
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = value
  }
  response.write = (chunk) => {
    if (chunk)
      rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }
  response.end = (chunk) => {
    if (chunk)
      rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    response.writableEnded = true
    response.emit('finish')
  }
  response.destroy = () => {
    response.writableEnded = true
  }
  Object.defineProperty(response, 'rawBody', {
    get() {
      return Buffer.concat(rawChunks).toString('utf8')
    },
  })
  Object.defineProperty(response, 'rawBuffer', {
    get() {
      return Buffer.concat(rawChunks)
    },
  })
  return response
}
