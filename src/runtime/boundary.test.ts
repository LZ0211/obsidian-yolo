/* eslint-disable import/no-nodejs-modules -- 边界测试遍历源文件静态 import 图，运行在 Node 环境 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Mobile/web bundle red-line: the Obsidian host entry and the web-ui entry
 * must not STATICALLY import desktop-only modules (CLI provider runtimes,
 * web server, Node builtins). Dynamic `import()` stays allowed — desktop
 * capabilities are loaded lazily inside desktop-only branches.
 */
// Static `import ... from 'x'`, `import 'x'`, `export ... from 'x'`.
// Dynamic `import('x')` is intentionally NOT matched.
const STATIC_IMPORT_RE =
  /(?:^|\n)\s*(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+)['"]([^'"]+)['"]/g

const DESKTOP_PATH_PATTERNS = [
  /core\/cli-runtime\/(claude|codex|coordinator|conversation-controller|session-index-store)/,
  /core\/web-server/,
  /runtime\/web/,
]

const walkStaticImports = (
  entryPath: string,
  visited = new Set<string>(),
  depth = 0,
): string[] => {
  if (depth > 24 || visited.has(entryPath)) return []
  visited.add(entryPath)
  const absolute = resolve(entryPath)
  const source = readFileSync(absolute, 'utf8')
  const found: string[] = []
  let match: RegExpExecArray | null
  STATIC_IMPORT_RE.lastIndex = 0
  while ((match = STATIC_IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1]
    if (specifier.startsWith('node:')) {
      found.push(`${entryPath} -> node:${specifier.slice(5)}`)
      continue
    }
    if (!specifier.startsWith('.')) continue
    const resolved = resolve(dirname(absolute), specifier)
    const candidate = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map(
      (suffix) => `${resolved}${suffix}`,
    )
    const file = candidate.find((candidatePath) => {
      try {
        return statSync(candidatePath).isFile()
      } catch {
        return false
      }
    })
    if (file) {
      found.push(...walkStaticImports(file, visited, depth + 1))
    }
  }
  return found
}

describe('runtime static-graph boundaries', () => {
  it('keeps desktop-only modules out of the Obsidian host static graph', () => {
    const violations = walkStaticImports('src/main.ts').filter((specifier) =>
      DESKTOP_PATH_PATTERNS.some((pattern) => pattern.test(specifier)),
    )
    expect(violations).toEqual([])
  })

  it('keeps desktop runtime implementations out of the web entry graph', () => {
    // node:* imports are shimmed by esbuild.web.config.mjs at build time, so
    // they are tolerated here; static desktop runtime implementations are not.
    const violations = walkStaticImports('src/runtime/web-entry.ts').filter(
      (specifier) =>
        DESKTOP_PATH_PATTERNS.some((pattern) => pattern.test(specifier)),
    )
    expect(violations).toEqual([])
  })
})
