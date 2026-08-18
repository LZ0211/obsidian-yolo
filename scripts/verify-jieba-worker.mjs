// Verifies the jieba-engine worker in a real Chromium (same engine family as
// Obsidian's Electron renderer): loads the built component artifact and drives
// cutForSearch through its blob worker. Exits non-zero on any hang/mismatch.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const PORT = 48231
const ROOT = new URL('../', import.meta.url)
const entryPath = 'runtime-components/jieba-engine/dist/entry.js'

const html = `<!doctype html>
<script type="module">
  globalThis.__yolo_register_runtime_component__ = (definition) => {
    window.__jieba = definition.create()
  }
  await import('/${entryPath}')
  window.__jiebaReady = true
</script>
<script type="module">
  // Minimal sanity check: does a blob worker in THIS browser exchange messages
  // at all? (Playwright's headless mode must not fake the failure.)
  window.__msgProbe = async () => {
    const script = [
      'console.log("WORKER-START")',
      'self.onmessage = (e) => { console.log("WORKER-GOT:", JSON.stringify(e.data)); self.postMessage({ ok: true, echo: e.data }) }',
      "self.postMessage({ type: 'ready' })",
      'console.log("WORKER-READY-SENT")',
    ].join('\\n')
    const blob = new Blob([script], { type: 'text/javascript' })
    const worker = new Worker(URL.createObjectURL(blob))
    const received = []
    const result = await new Promise((resolve) => {
      worker.onmessage = (event) => {
        received.push(event.data)
        if (event.data && event.data.ok) resolve('pong-received')
      }
      worker.postMessage('ping')
      setTimeout(() => resolve('timeout'), 5_000)
    })
    worker.terminate()
    return { result, received }
  }
</script>
<script type="module">
  // Same glue + WASM as the worker, but on the MAIN thread — isolates whether
  // the wedge is wasm-bindgen init itself or the worker environment.
  const glue = await import('/node_modules/jieba-wasm/pkg/web/jieba_rs_wasm.js')
  const wasm = await (await fetch('/node_modules/jieba-wasm/pkg/web/jieba_rs_wasm_bg.wasm')).arrayBuffer()
  window.__mainThreadProbe = async () => {
    const steps = {}
    const t0 = performance.now()
    glue.initSync({ module: new Uint8Array(wasm) })
    steps.initSyncMs = Math.round(performance.now() - t0)
    const t1 = performance.now()
    const tokens = glue.cut_for_search('hi', true)
    steps.cutMs = Math.round(performance.now() - t1)
    steps.tokens = tokens
    return steps
  }
</script>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '')
  if (path === 'index.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
    return
  }
  try {
    const body = await readFile(new URL(path, ROOT))
    const type = path.endsWith('.js') ? 'text/javascript' : 'text/html'
    res.writeHead(200, { 'content-type': type })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, resolve)
  })

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('console', (message) => {
    console.log(`[page:${message.type()}]`, message.text().slice(0, 300))
  })
  page.on('pageerror', (error) => {
    console.log('[pageerror]', String(error).slice(0, 300))
  })
  page.on('worker', (worker) => {
    console.log('[worker created]', worker.url())
  })
  await page.goto(`http://localhost:${PORT}/index.html`)
  await page.waitForFunction('window.__jiebaReady === true', null, { timeout: 10_000 })

  const withDeadline = async (label, fn, ms = 30_000) => {
    const startedAt = Date.now()
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms),
      ),
    ])
    return { result, elapsedMs: Date.now() - startedAt }
  }

  const msgProbe = await withDeadline('blob worker message probe', () =>
    page.evaluate(() => window.__msgProbe()),
  )
  console.log('[msg probe]', JSON.stringify(msgProbe.result))

  const mainThread = await withDeadline('main-thread initSync+cut', () =>
    page.evaluate(() => window.__mainThreadProbe()),
  )
  record(
    'main-thread initSync + cut',
    Array.isArray(mainThread.result.tokens) && mainThread.result.tokens.length > 0,
    `initSync=${mainThread.result.initSyncMs}ms cut=${mainThread.result.cutMs}ms tokens=${JSON.stringify(mainThread.result.tokens)}`,
  )

  const basic = await withDeadline('cut "hi" (30s)', () =>
    page.evaluate(() => window.__jieba.cutForSearch('hi')),
  )
  record('cut "hi"', JSON.stringify(basic.result) === JSON.stringify(['hi']), JSON.stringify(basic.result) + ` in ${basic.elapsedMs}ms`)

  const chinese = await withDeadline('cut 北京烤鸭', () =>
    page.evaluate(() => window.__jieba.cutForSearch('北京烤鸭')),
  )
  record(
    'cut 北京烤鸭',
    JSON.stringify(chinese.result) === JSON.stringify(['北京', '烤鸭', '北京烤鸭']),
    JSON.stringify(chinese.result) + ` in ${chinese.elapsedMs}ms`,
  )

  const concurrent = await withDeadline('concurrent cuts', () =>
    page.evaluate(async () => {
      const texts = Array.from({ length: 8 }, (_, i) => `并发测试文本${i}号`)
      const all = await Promise.all(texts.map((text) => window.__jieba.cutForSearch(text)))
      return all.map((tokens, i) => tokens.length > 0 && texts[i].includes(tokens[0]))
    }),
  )
  record('concurrent cuts (8)', concurrent.result.every(Boolean), `in ${concurrent.elapsedMs}ms`)

  const empty = await withDeadline('cut ""', () =>
    page.evaluate(() => window.__jieba.cutForSearch('')),
  )
  record('cut ""', Array.isArray(empty.result) && empty.result.length === 0, JSON.stringify(empty.result) + ` in ${empty.elapsedMs}ms`)

  const large = await withDeadline('cut 10k-char text', () =>
    page.evaluate(() => {
      const text = '中文分词测试'.repeat(1000)
      return window.__jieba.cutForSearch(text)
    }),
  )
  record('cut 10k-char text', Array.isArray(large.result) && large.result.length > 0, `tokens=${large.result.length} in ${large.elapsedMs}ms`)

  await browser.close()
} finally {
  server.close()
}

const failed = results.filter((result) => !result.ok)
if (failed.length > 0) {
  console.error(`\n${failed.length} worker check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll jieba worker checks passed')
