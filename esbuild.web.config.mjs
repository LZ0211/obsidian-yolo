import fs from 'fs'
import path from 'path'
import process from 'process'

import builtins from 'builtin-modules'
import esbuild from 'esbuild'

const prod = process.argv[2] === 'production'
const nodeBuiltinNames = new Set([
  ...builtins,
  ...builtins.map((name) => `node:${name}`),
  'fs/promises',
  'node:fs/promises',
])

const nodeBuiltinShimPlugin = {
  name: 'node-builtin-shim-plugin',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!nodeBuiltinNames.has(args.path)) return undefined
      return {
        path: args.path.replace(/^node:/, ''),
        namespace: 'node-builtin-shim',
      }
    })

    build.onLoad({ filter: /.*/, namespace: 'node-builtin-shim' }, (args) => {
      const name = args.path
      return {
        loader: 'js',
        contents: `
          const unsupported = () => { throw new Error(${JSON.stringify(name)} + ' is not available in the web runtime') }
          export default {}
          export const promises = {}
          export const constants = {}
          export const Buffer = globalThis.Buffer
          export const process = globalThis.process ?? { env: {}, platform: 'browser', versions: {} }
          export const env = process.env
          export const platform = process.platform
          export const versions = process.versions
          export const cwd = () => '/'
          export const homedir = () => '/'
          export const userInfo = () => ({ username: 'web', homedir: '/', shell: null })
          export const tmpdir = () => '/tmp'
          export const join = (...parts) => parts.filter(Boolean).join('/').replace(/\\/+/g, '/')
          export const resolve = (...parts) => join(...parts)
          export const isAbsolute = (value) => String(value).startsWith('/')
          export const dirname = (value) => String(value).split('/').slice(0, -1).join('/') || '.'
          export const basename = (value) => String(value).split('/').pop() || ''
          export const extname = (value) => { const base = basename(value); const index = base.lastIndexOf('.'); return index > 0 ? base.slice(index) : '' }
          export const sep = '/'
          export const delimiter = ':'
          export const posix = { join, resolve, dirname, basename, extname, sep: '/', delimiter: ':' }
          export const win32 = posix
          export const createRequire = () => unsupported
          export const builtinModules = []
          export const isDeepStrictEqual = Object.is
          export const inspect = (value) => String(value)
          export const promisify = (fn) => fn
          export const callbackify = (fn) => fn
          export const parse = (value) => new URL(String(value), 'http://localhost')
          export const format = (value) => String(value ?? '')
          export const URL = globalThis.URL
          export const URLSearchParams = globalThis.URLSearchParams
          export const Readable = class {}
          export const Writable = class {}
          export const Transform = class {}
          export const PassThrough = class {}
          export const EventEmitter = class {
            on() { return this }
            once() { return this }
            off() { return this }
            emit() { return false }
          }
          export const StringDecoder = class { write(value) { return String(value ?? '') } end() { return '' } }
          export const spawn = unsupported
          export const exec = unsupported
          export const execFile = unsupported
          export const request = unsupported
          export const get = unsupported
          export const lookup = unsupported
          export const connect = unsupported
          export const randomUUID = () => crypto.randomUUID()
          export const webcrypto = crypto
          export const subtle = crypto.subtle
          export const createHash = unsupported
          export const readFile = unsupported
          export const access = unsupported
          export const stat = unsupported
          export const readFileSync = unsupported
          export const writeFile = unsupported
          export const writeFileSync = unsupported
          export const existsSync = () => false
        `,
      }
    })
  },
}

const ctx = await esbuild.context({
  entryPoints: ['src/web-ui/index.tsx'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: prod ? false : 'inline',
  minify: prod,
  outfile: 'web-ui/dist/index.js',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
  },
  alias: {
    obsidian: path.resolve('src/runtime/web/obsidianCompat.ts'),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
  },
  plugins: [nodeBuiltinShimPlugin],
})

if (prod) {
  await ctx.rebuild()
  await ctx.dispose()
  await fs.promises.mkdir('web-ui/dist', { recursive: true })
  await Promise.all([
    fs.promises.copyFile('src/web-ui/index.html', 'web-ui/dist/index.html'),
    fs.promises.copyFile('app.css', 'web-ui/dist/app.css'),
    fs.promises.copyFile('styles.css', 'web-ui/dist/styles.css'),
  ])
} else {
  await ctx.watch()
}
