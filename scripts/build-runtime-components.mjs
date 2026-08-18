import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const production = process.argv.includes('--production')
const check = process.argv.includes('--check')
const componentRoot = path.resolve('runtime-components')
const allowedIds = new Set([
  'tokenizer',
  'pdf-engine',
  'bash-engine',
  'jieba-engine',
  'sqlite-engine',
])
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

const entries = await readdir(componentRoot, { withFileTypes: true })
const components = []
for (const entry of entries.sort((left, right) =>
  left.name.localeCompare(right.name),
)) {
  if (!entry.isDirectory()) continue
  const configPath = path.join(
    componentRoot,
    entry.name,
    'component.config.json',
  )
  let config
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') continue
    throw error
  }
  validateConfig(config, entry.name)
  const componentDir = path.join(componentRoot, entry.name)
  const outputPath = path.join(componentDir, 'dist', 'entry.js')
  await mkdir(path.dirname(outputPath), { recursive: true })
  const result = await esbuild.build({
    entryPoints: [path.join(componentDir, 'src', 'entry.ts')],
    outfile: outputPath,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    minify: production,
    sourcemap: false,
    metafile: true,
    write: !check,
    define: {
      'process.env.NODE_ENV': JSON.stringify(
        production ? 'production' : 'development',
      ),
    },
    plugins: componentPlugins(entry.name),
    logLevel: 'silent',
  })
  verifyBoundary(entry.name, result.metafile)
  const output = result.outputFiles?.[0]?.contents
  const bytes = output ?? new Uint8Array(await readFile(outputPath))
  const registrationMarker = '__yolo_register_runtime_component__'
  const registrationCount = new TextDecoder()
    .decode(bytes)
    .split(registrationMarker).length - 1
  if (registrationCount !== 1) {
    throw new Error(
      `Runtime component ${entry.name} must register exactly once; found ${registrationCount}`,
    )
  }
  const descriptor = Object.freeze({
    id: config.id,
    platforms: Object.freeze([...config.platforms]),
    nameKey: config.nameKey,
    descriptionKey: config.descriptionKey,
    impactKey: config.impactKey,
    entry: `runtime-components/${config.id}/${config.entry}`,
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  components.push(descriptor)
  const metafileJson = `${JSON.stringify(result.metafile, null, 2)}\n`
  if (check) {
    const [installedEntry, installedMetafile] = await Promise.all([
      readFile(outputPath),
      readFile(path.join(componentDir, 'dist', 'meta.json'), 'utf8'),
    ])
    if (
      !sameBytes(installedEntry, bytes) ||
      installedMetafile !== metafileJson
    ) {
      throw new Error(
        `Runtime component source and dist are not synchronized: ${entry.name}`,
      )
    }
  } else {
    await writeFile(path.join(componentDir, 'dist', 'meta.json'), metafileJson)
  }
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

if (components.length !== allowedIds.size) {
  throw new Error(
    `Expected ${allowedIds.size} runtime components, found ${components.length}`,
  )
}
const registry = {
  schemaVersion: 1,
  components: components.sort((left, right) => left.id.localeCompare(right.id)),
}
const registryJson = `${JSON.stringify(registry, null, 2)}\n`
const registryPath = path.join(componentRoot, 'registry.json')
if (check) {
  const existing = await readFile(registryPath, 'utf8')
  if (existing !== registryJson) {
    throw new Error(
      'Runtime component source, dist, and registry are not synchronized',
    )
  }
} else {
  await writeFile(registryPath, registryJson)
}

function validateConfig(value, directoryName) {
  const keys = Object.keys(value).sort()
  const expected = [
    'descriptionKey',
    'entry',
    'id',
    'impactKey',
    'nameKey',
    'platforms',
    'schemaVersion',
  ].sort()
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(
      `Runtime component config has unexpected keys: ${directoryName}`,
    )
  }
  if (
    value.schemaVersion !== 1 ||
    value.id !== directoryName ||
    !allowedIds.has(value.id) ||
    value.entry !== 'dist/entry.js' ||
    !Array.isArray(value.platforms) ||
    value.platforms.length === 0 ||
    value.platforms.some(
      (platform) => platform !== 'desktop' && platform !== 'mobile',
    ) ||
    new Set(value.platforms).size !== value.platforms.length ||
    typeof value.nameKey !== 'string' ||
    typeof value.descriptionKey !== 'string' ||
    typeof value.impactKey !== 'string'
  ) {
    throw new Error(`Runtime component config is invalid: ${directoryName}`)
  }
}

function componentPlugins(componentId) {
  const plugins = []
  if (componentId === 'bash-engine') {
    plugins.push(bashEngineZlibStubPlugin())
  }
  if (componentId === 'pdf-engine') {
    plugins.push({
      name: 'runtime-pdf-worker',
      setup(build) {
        build.onResolve({ filter: /^virtual:pdfjs-worker-script$/ }, () => ({
          path: 'pdf-worker',
          namespace: 'runtime-worker',
        }))
        build.onLoad(
          { filter: /^pdf-worker$/, namespace: 'runtime-worker' },
          async () => ({
            contents: `export default ${JSON.stringify(
              await readFile(
                path.resolve(
                  'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
                ),
                'utf8',
              ),
            )}`,
            loader: 'js',
          }),
        )
      },
    })
  }
  if (componentId === 'jieba-engine') {
    plugins.push(jiebaWorkerInlinePlugin())
  }
  if (componentId === 'sqlite-engine') {
    plugins.push(sqliteWasmInlinePlugin(), sqliteNodeBuiltinsStubPlugin())
  }
  return plugins
}

/**
 * sql.js's emscripten glue guards Node-only initialization behind
 * environment detection (`require("fs")`/`require("path")`/`require("crypto")`).
 * Those branches never execute in the Obsidian renderer, so stub them out
 * (same pattern as the bash-engine zlib stub).
 */
function sqliteNodeBuiltinsStubPlugin() {
  return {
    name: 'runtime-sqlite-node-builtins-stub',
    setup(build) {
      for (const specifier of ['node:fs', 'node:path', 'node:crypto', 'fs', 'path', 'crypto']) {
        build.onResolve({ filter: new RegExp(`^${specifier.replaceAll(':', '\\:')}$`) }, () => ({
          path: 'sqlite-node-builtin-stub',
          namespace: 'runtime-stub',
        }))
      }
      build.onLoad(
        { filter: /^sqlite-node-builtin-stub$/, namespace: 'runtime-stub' },
        () => ({
          contents: [
            "const unavailable = () => { throw new Error('Node builtins are unavailable in this environment') }",
            'export default unavailable',
            'export const readFileSync = unavailable',
            'export const writeFileSync = unavailable',
            'export const existsSync = unavailable',
            'export const randomFillSync = unavailable',
            'export const resolve = (p) => p',
            'export const dirname = (p) => p',
            'export const join = (...parts) => parts.join("/")',
            'export const basename = (p) => p',
            '',
          ].join('\n'),
          loader: 'js',
        }),
      )
    },
  }
}

function sqliteWasmInlinePlugin() {
  return {
    name: 'runtime-sqlite-wasm',
    setup(build) {
      build.onResolve({ filter: /^virtual:sql-js-wasm$/ }, () => ({
        path: 'sqlite-wasm',
        namespace: 'runtime-wasm',
      }))
      build.onLoad(
        { filter: /^sqlite-wasm$/, namespace: 'runtime-wasm' },
        async () => ({
          contents: `export default ${JSON.stringify(
            (
              await readFile(
                path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
              )
            ).toString('base64'),
          )}`,
          loader: 'js',
        }),
      )
    },
  }
}

function jiebaWorkerInlinePlugin() {
  return {
    name: 'runtime-jieba-worker',
    setup(build) {
      build.onResolve({ filter: /^virtual:jieba-worker-script$/ }, () => ({
        path: 'jieba-worker',
        namespace: 'runtime-worker',
      }))
      build.onLoad(
        { filter: /^jieba-worker$/, namespace: 'runtime-worker' },
        async () => {
          const glue = await readFile(
            path.resolve('node_modules/jieba-wasm/pkg/web/jieba_rs_wasm.js'),
            'utf8',
          )
          const wasm = await readFile(
            path.resolve('node_modules/jieba-wasm/pkg/web/jieba_rs_wasm_bg.wasm'),
          )
          const wasmBase64 = wasm.toString('base64')
          const workerScript = [
            glue,
            'const wasmBytes = Uint8Array.from(atob(' +
              JSON.stringify(wasmBase64) +
              '), (c) => c.charCodeAt(0));',
            'initSync({ module: wasmBytes });',
            'self.onmessage = (event) => {',
            "  const request = event.data;",
            "  try {",
            "    if (request.type !== 'cut_for_search') throw new Error('unknown request');",
            "    const tokens = cut_for_search(request.text, true);",
            "    self.postMessage({ type: 'result', id: request.id, tokens });",
            "  } catch (error) {",
            "    self.postMessage({ type: 'error', id: request.id, message: String(error && error.message || error) });",
            "  }",
            "};",
            // Handshake: postMessage immediately after `new Worker` can be
            // dropped by Chromium before the blob script starts executing, so
            // the component waits for this before dispatching requests.
            "self.postMessage({ type: 'ready' });",
          ].join('\n')
          // Like the pdf worker: ship the script as a string default export so
          // the component receives the actual source. Returning the script as
          // raw module code would bundle it into the host entry (import default
          // becomes undefined and the blob worker is an empty shell).
          return {
            contents: `export default ${JSON.stringify(workerScript)}`,
            loader: 'js',
          }
        },
      )
    },
  }
}

function bashEngineZlibStubPlugin() {
  return {
    name: 'runtime-bash-engine-zlib-stub',
    setup(build) {
      build.onResolve({ filter: /^node:zlib$/ }, () => ({
        path: 'bash-engine-zlib-stub',
        namespace: 'runtime-stub',
      }))
      build.onLoad(
        { filter: /^bash-engine-zlib-stub$/, namespace: 'runtime-stub' },
        () => ({
          contents: [
            'export function gzipSync() {',
            "  throw new Error('gzip is not supported in this environment')",
            '}',
            'export function gunzipSync() {',
            "  throw new Error('gunzip is not supported in this environment')",
            '}',
            'export const constants = {}',
            '',
          ].join('\n'),
          loader: 'js',
        }),
      )
    },
  }
}

function verifyBoundary(componentId, metafile) {
  const componentPrefix = `runtime-components/${componentId}/`
  for (const [input, data] of Object.entries(metafile.inputs)) {
    const normalized = input.replaceAll('\\', '/')
    if (
      normalized.startsWith('src/') ||
      normalized.startsWith('modules/') ||
      normalized.includes('/obsidian/') ||
      normalized.endsWith('/obsidian') ||
      normalized === 'obsidian' ||
      [...nodeBuiltins].some(
        (builtin) =>
          normalized === builtin || normalized.endsWith(`/${builtin}`),
      )
    ) {
      throw new Error(
        `Runtime component ${componentId} crosses a forbidden build boundary: ${input}`,
      )
    }
    for (const imported of data.imports ?? []) {
      if (nodeBuiltins.has(imported.path) || imported.path === 'obsidian') {
        throw new Error(
          `Runtime component ${componentId} imports forbidden dependency ${imported.path}`,
        )
      }
      if (imported.kind === 'dynamic-import' && !imported.external) {
        throw new Error(
          `Runtime component ${componentId} contains an unapproved dynamic import in ${input}: ${imported.path}`,
        )
      }
    }
    if (
      normalized.startsWith('runtime-components/') &&
      !normalized.startsWith(componentPrefix) &&
      normalized !== 'runtime-components/sdk.d.ts'
    ) {
      throw new Error(
        `Runtime component ${componentId} imports another component: ${input}`,
      )
    }
  }
  for (const output of Object.values(metafile.outputs)) {
    if ((output.imports ?? []).length > 0) {
      throw new Error(
        `Runtime component ${componentId} output is not standalone`,
      )
    }
  }
}
