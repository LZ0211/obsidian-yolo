// eslint-disable-next-line import/no-nodejs-modules -- type-only import，编译后消失，无运行时 node 依赖
import { type IncomingMessage, type ServerResponse } from 'node:http'

import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'
import { isLoopbackHost } from '../share/shareTokenStore'

import { WebRouter } from './WebRouter'

export type WebHttpServerOptions = {
  host: string
  port?: number
  token: string
}

export type HeaderLikeRequest = {
  authorization?: string
  url?: string
  webSessionId?: string
}

export class WebHttpServer {
  readonly router = new WebRouter()
  private readonly server: ReturnType<typeof import('node:http').createServer>

  constructor(private readonly options: WebHttpServerOptions) {
    const { createServer } =
      loadDesktopNodeModuleSync<
        Pick<typeof import('node:http'), 'createServer'>
      >('node:http')
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
  }

  isAuthorizedRequest(request: HeaderLikeRequest): boolean {
    if (isLoopbackHost(this.options.host)) {
      return true
    }
    if (hasTokenQueryParam(request.url)) {
      return false
    }
    if (isPublicSharedWebRoute(request.url)) {
      return true
    }
    if (hasWebSessionHeader(request.webSessionId, request.url)) {
      return true
    }
    return (
      Boolean(this.options.token) &&
      request.authorization === `Bearer ${this.options.token}`
    )
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.options.port ?? 18900, this.options.host)
    })
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    applyCompression(req, res)
    setCorsHeaders(res)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    if (
      !this.isAuthorizedRequest({
        authorization: req.headers.authorization,
        webSessionId: getHeader(req.headers['x-yolo-web-session-id']),
        url: req.url,
      })
    ) {
      writeJson(res, 401, {
        error: { code: 'unauthorized', message: 'Unauthorized' },
      })
      return
    }

    const resolved = this.router.resolve(req.method ?? 'GET', req.url ?? '/')
    if (!resolved) {
      writeJson(res, 404, {
        error: { code: 'not_found', message: 'Not found' },
      })
      return
    }

    try {
      await resolved.handler(req, res, resolved.params)
    } catch (error) {
      if (res.writableEnded) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, 500, {
        error: { code: 'internal_error', message },
      })
    }
  }
}

function hasTokenQueryParam(requestUrl: string | undefined): boolean {
  if (!requestUrl) return false
  try {
    return new URL(requestUrl, 'http://localhost').searchParams.has('token')
  } catch {
    return false
  }
}

function isPublicSharedWebRoute(requestUrl: string | undefined): boolean {
  if (!requestUrl) return false

  let pathname: string
  try {
    pathname = new URL(requestUrl, 'http://localhost').pathname
  } catch {
    return false
  }

  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/index.js' ||
    pathname === '/app.css' ||
    pathname === '/styles.css' ||
    pathname === '/api/bootstrap' ||
    pathname.startsWith('/api/web/auth/')
  )
}

function hasWebSessionHeader(
  webSessionId: string | undefined,
  requestUrl: string | undefined,
): boolean {
  if (!webSessionId) return false
  if (!requestUrl) return false
  try {
    const pathname = new URL(requestUrl, 'http://localhost').pathname
    return isSharedWebSessionRoute(pathname)
  } catch {
    return false
  }
}

function isSharedWebSessionRoute(pathname: string): boolean {
  return (
    pathname === '/api/settings' ||
    pathname === '/api/agents' ||
    pathname === '/api/skills' ||
    pathname.startsWith('/api/chat-runtime/') ||
    pathname.startsWith('/api/chat/') ||
    pathname.startsWith('/api/agent/') ||
    pathname.startsWith('/api/vault/') ||
    pathname.startsWith('/api/citation/')
  )
}

function getHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  setCorsHeaders(res)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export type CompressionEncoding = 'br' | 'gzip' | null

/** 压缩算法选择：br 优先，其次 gzip；两者都不在 Accept-Encoding 时返回 null。 */
export const resolveCompressionEncoding = (
  acceptEncoding: string | undefined,
): CompressionEncoding => {
  if (!acceptEncoding) return null
  if (acceptEncoding.includes('br')) return 'br'
  if (acceptEncoding.includes('gzip')) return 'gzip'
  return null
}

const COMPRESSION_MIN_BYTES = 1024

/**
 * 决定单个 JSON 响应体是否值得压缩：未显式设置 content-encoding、内容为
 * application/json、且体积达到最小阈值（小于阈值时压缩反而增加开销）。
 */
export const shouldCompressJsonChunk = ({
  contentType,
  chunkByteLength,
  hasContentEncoding,
}: {
  contentType: string
  chunkByteLength: number
  hasContentEncoding: boolean
}): boolean =>
  !hasContentEncoding &&
  contentType.includes('application/json') &&
  chunkByteLength >= COMPRESSION_MIN_BYTES

function applyCompression(req: IncomingMessage, res: ServerResponse): void {
  const encoding = resolveCompressionEncoding(
    String(req.headers['accept-encoding'] ?? ''),
  )
  if (!encoding) return
  const useBr = encoding === 'br'

  const origEnd = res.end.bind(res) as (
    chunk?: unknown,
    encodingOrCb?: unknown,
    cb?: unknown,
  ) => ServerResponse

  res.end = ((
    chunk?: unknown,
    encodingOrCb?: unknown,
    cb?: unknown,
  ): ServerResponse => {
    const ct = String(res.getHeader('content-type') ?? '')
    if (
      chunk != null &&
      (Buffer.isBuffer(chunk) ||
        typeof chunk === 'string' ||
        chunk instanceof Uint8Array)
    ) {
      const raw = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Buffer.from(chunk)
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
      if (
        !shouldCompressJsonChunk({
          contentType: ct,
          chunkByteLength: raw.byteLength,
          hasContentEncoding: Boolean(res.getHeader('content-encoding')),
        })
      ) {
        return origEnd(raw, callback)
      }

      const finishCompression = (error: Error | null, compressed: Buffer) => {
        if (error) {
          origEnd(raw, callback)
          return
        }
        res.setHeader('content-encoding', useBr ? 'br' : 'gzip')
        res.setHeader('vary', 'accept-encoding')
        res.removeHeader('content-length')
        origEnd(compressed, callback)
      }
      const { brotliCompress, gzip } =
        loadDesktopNodeModuleSync<
          Pick<typeof import('node:zlib'), 'brotliCompress' | 'gzip'>
        >('node:zlib')
      if (useBr) {
        brotliCompress(raw, finishCompression)
      } else {
        gzip(raw, finishCompression)
      }
      return res
    }
    return origEnd(chunk, encodingOrCb, cb)
  }) as ServerResponse['end']
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader(
    'access-control-allow-headers',
    'Authorization, Content-Type, Accept, X-Yolo-Web-Session-Id',
  )
}
