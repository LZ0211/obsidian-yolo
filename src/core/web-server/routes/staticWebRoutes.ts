import { loadDesktopNodeModuleSync } from '../../../utils/platform/desktopNodeModule'
import { type WebRouter } from '../WebRouter'

const WEB_STATIC_FILES: Record<
  string,
  { relativePath: string; contentType: string }
> = {
  '/': { relativePath: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': {
    relativePath: 'index.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/index.js': {
    relativePath: 'index.js',
    contentType: 'text/javascript; charset=utf-8',
  },
  '/app.css': {
    relativePath: 'app.css',
    contentType: 'text/css; charset=utf-8',
  },
  '/styles.css': {
    relativePath: 'styles.css',
    contentType: 'text/css; charset=utf-8',
  },
}

const getFs = () =>
  loadDesktopNodeModuleSync<typeof import('node:fs')>('node:fs')

const getPath = () =>
  loadDesktopNodeModuleSync<typeof import('node:path')>('node:path')

export function registerStaticWebRoutes(
  router: WebRouter,
  options?: { cwd?: string },
): void {
  const cwd = options?.cwd ?? process.cwd()
  for (const [routePath, file] of Object.entries(WEB_STATIC_FILES)) {
    router.get(routePath, (req, res) => {
      const encodedAsset =
        file.relativePath === 'index.js'
          ? resolveEncodedAsset(
              cwd,
              file.relativePath,
              req.headers['accept-encoding'],
            )
          : null
      const filePath =
        encodedAsset?.filePath ?? resolveStaticFilePath(cwd, file.relativePath)
      if (!filePath) {
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('Not found')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', file.contentType)
      if (file.relativePath === 'index.js') {
        res.setHeader('vary', 'Accept-Encoding')
      }
      if (encodedAsset) {
        res.setHeader('content-encoding', encodedAsset.encoding)
      }
      getFs().createReadStream(filePath).pipe(res)
    })
  }
}

function resolveEncodedAsset(
  cwd: string,
  relativePath: string,
  acceptEncoding: string | string[] | undefined,
): { filePath: string; encoding: 'br' | 'gzip' } | null {
  const accepted = Array.isArray(acceptEncoding)
    ? acceptEncoding.join(',')
    : acceptEncoding
  const candidates = [
    { encoding: 'br' as const, suffix: '.br' },
    { encoding: 'gzip' as const, suffix: '.gz' },
  ]

  for (const candidate of candidates) {
    if (!acceptsEncoding(accepted, candidate.encoding)) continue
    const filePath = resolveStaticFilePath(cwd, relativePath + candidate.suffix)
    if (filePath) return { filePath, encoding: candidate.encoding }
  }
  return null
}

function acceptsEncoding(
  headerValue: string | undefined,
  encoding: 'br' | 'gzip',
): boolean {
  if (!headerValue) return false
  return headerValue.split(',').some((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';')
    if (name !== encoding && name !== '*') return false
    return !parameters.some((parameter) =>
      /^q=0(?:\.0*)?$/.test(parameter.trim()),
    )
  })
}

function resolveStaticFilePath(
  cwd: string,
  relativePath: string,
): string | null {
  const candidates = [
    getPath().join(cwd, 'web-ui', 'dist', relativePath),
    getPath().join(cwd, 'web-ui', relativePath),
    relativePath === 'app.css' || relativePath === 'styles.css'
      ? getPath().join(cwd, relativePath)
      : '',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (getFs().existsSync(candidate) && getFs().statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}
