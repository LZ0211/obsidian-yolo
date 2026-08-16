import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { brotliCompressSync, constants, gzipSync } from 'zlib'

import * as esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const builtins = (await import('builtin-modules')).default
const nodeBuiltins = [...builtins, ...builtins.map((mod) => `node:${mod}`)]

const prod = process.argv[2] === 'production'
const webUiDir = path.resolve('web-ui')

// Inline pdfjs-dist worker — the web-ui needs PDF preview support
const inlinePdfjsWorkerPlugin = {
  name: 'inline-pdfjs-worker-plugin',
  setup(build) {
    build.onResolve({ filter: /^virtual:pdfjs-worker-script$/ }, () => ({
      path: 'virtual:pdfjs-worker-script',
      namespace: 'inline-pdfjs-worker',
    }))
    build.onLoad(
      {
        filter: /^virtual:pdfjs-worker-script$/,
        namespace: 'inline-pdfjs-worker',
      },
      async () => {
        const workerEntry = path.join(
          path.dirname(require.resolve('pdfjs-dist/package.json')),
          'build/pdf.worker.min.mjs',
        )
        const workerSource = await fs.promises.readFile(workerEntry, 'utf8')
        return {
          contents: `export default ${JSON.stringify(workerSource)}`,
          loader: 'js',
        }
      },
    )
  },
}

const inlineTokenizerWorkerPlugin = {
  name: 'inline-tokenizer-worker-plugin',
  setup(build) {
    build.onResolve({ filter: /^virtual:tokenizer-worker-script$/ }, () => ({
      path: 'virtual:tokenizer-worker-script',
      namespace: 'inline-tokenizer-worker',
    }))
    build.onLoad(
      {
        filter: /^virtual:tokenizer-worker-script$/,
        namespace: 'inline-tokenizer-worker',
      },
      async () => {
        const result = await esbuild.build({
          entryPoints: ['src/utils/llm/tokenizerWorker.ts'],
          bundle: true,
          write: false,
          format: 'iife',
          platform: 'browser',
          target: 'es2020',
          logLevel: 'silent',
          minify: prod,
        })
        return {
          contents: `export default ${JSON.stringify(result.outputFiles[0]?.text ?? '')}`,
          loader: 'js',
        }
      },
    )
  },
}

const inlineOfficeWorkerPlugin = {
  name: 'inline-office-worker-plugin',
  setup(build) {
    build.onResolve({ filter: /^virtual:office-worker-script$/ }, () => ({
      path: 'virtual:office-worker-script',
      namespace: 'inline-office-worker',
    }))
    build.onLoad(
      {
        filter: /^virtual:office-worker-script$/,
        namespace: 'inline-office-worker',
      },
      async () => {
        const result = await esbuild.build({
          entryPoints: ['src/utils/office/officeWorker.ts'],
          bundle: true,
          write: false,
          format: 'iife',
          platform: 'browser',
          target: 'es2020',
          logLevel: 'silent',
          minify: prod,
        })
        return {
          contents: `export default ${JSON.stringify(result.outputFiles[0]?.text ?? '')}`,
          loader: 'js',
        }
      },
    )
  },
}

// Replace 'obsidian' imports with the existing browser-safe stub so shared
// UI code (Chat.tsx, etc.) can be bundled without throwing at module-init time.
const obsidianStubPlugin = {
  name: 'obsidian-stub',
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({
      path: path.resolve('src/runtime/web/obsidianCompat.ts'),
    }))
  },
}

const ctx = await esbuild.context({
  entryPoints: ['src/web-ui/index.tsx'],
  bundle: true,
  outfile: 'web-ui/index.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  external: ['electron', ...nodeBuiltins],
  define: {
    'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
  },
  loader: {
    '.svg': 'dataurl',
    '.md': 'text',
  },
  minify: prod,
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  plugins: [
    obsidianStubPlugin,
    inlinePdfjsWorkerPlugin,
    inlineTokenizerWorkerPlugin,
    inlineOfficeWorkerPlugin,
  ],
  logLevel: 'info',
})

if (prod) {
  await ctx.rebuild()
  await ctx.dispose()
  await fs.promises.mkdir(webUiDir, { recursive: true })
  await Promise.all([
    fs.promises.copyFile(
      'src/web-ui/index.html',
      path.join(webUiDir, 'index.html'),
    ),
    fs.promises.copyFile('app.css', path.join(webUiDir, 'app.css')),
    fs.promises.copyFile('styles.css', path.join(webUiDir, 'styles.css')),
  ])

  const indexJsPath = path.join(webUiDir, 'index.js')
  const indexJs = await fs.promises.readFile(indexJsPath)
  await Promise.all([
    fs.promises.writeFile(
      `${indexJsPath}.br`,
      brotliCompressSync(indexJs, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
        },
      }),
    ),
    fs.promises.writeFile(`${indexJsPath}.gz`, gzipSync(indexJs, { level: 9 })),
  ])
  console.log('[web-ui] Done → web-ui')
} else {
  await fs.promises.mkdir(webUiDir, { recursive: true })
  const copyIndexHtml = async () => {
    await fs.promises.copyFile(
      'src/web-ui/index.html',
      path.join(webUiDir, 'index.html'),
    )
    console.log('[web-ui] Copied src/web-ui/index.html → web-ui/index.html')
  }
  await copyIndexHtml()
  // esbuild 的 watch 只观察 JS 依赖图，src/web-ui/index.html 不在图内——
  // 单独用 fs.watch 监听，修改后重新复制（防抖合并批量事件）。
  let htmlCopyTimer = null
  const htmlWatcher = fs.watch('src/web-ui/index.html', () => {
    if (htmlCopyTimer !== null) return
    htmlCopyTimer = setTimeout(() => {
      htmlCopyTimer = null
      void copyIndexHtml().catch((error) => {
        console.error('[web-ui] Failed to copy index.html', error)
      })
    }, 100)
  })
  const stopHtmlWatcher = () => {
    if (htmlCopyTimer !== null) {
      clearTimeout(htmlCopyTimer)
      htmlCopyTimer = null
    }
    htmlWatcher.close()
  }
  process.once('SIGINT', () => {
    stopHtmlWatcher()
    process.exit(0)
  })
  process.once('SIGTERM', () => {
    stopHtmlWatcher()
    process.exit(0)
  })
  console.log(
    '[web-ui] Watching src/web-ui/index.tsx (esbuild) and src/web-ui/index.html (fs.watch) for changes...',
  )
  await ctx.watch()
}
