// Reproduces RuntimeComponentLoader's execution path in a real Chromium:
// bridge injection + classic blob <script> + synchronous registration check.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const PORT = 48233
const ROOT = new URL('../', import.meta.url)

const html = `<!doctype html>
<meta charset="utf-8">
<script type="module">
  window.__loaderProbe = async () => {
    const source = await (
      await fetch('/runtime-components/jieba-engine/dist/entry.js')
    ).text()
    const results = []
    let definition
    let registrations = 0
    let registrationOpen = true
    const register = (candidate) => {
      results.push('register-called')
      if (!registrationOpen) {
        results.push('register-after-close')
        return
      }
      registrations += 1
      definition = candidate
    }
    globalThis.__yolo_register_runtime_component__ = register
    const blob = new Blob([source], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const outcome = await new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = url
      script.onload = () => resolve('load')
      script.onerror = (e) => resolve('error:' + (e && e.message))
      document.head.appendChild(script)
    })
    registrationOpen = false
    results.push('outcome=' + outcome)
    results.push('registrations=' + registrations)
    results.push('definition=' + (definition ? definition.id : 'none'))
    // cutForSearch must be usable after load.
    if (definition) {
      const cut = definition.create().cutForSearch('北京烤鸭')
      const cutOutcome = await Promise.race([
        cut.then((tokens) => 'tokens=' + JSON.stringify(tokens)),
        new Promise((resolve) => setTimeout(() => resolve('cut-timeout'), 5000)),
      ])
      results.push('cut=' + cutOutcome)
    }
    return results
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
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, resolve)
  })
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(`http://localhost:${PORT}/index.html`)
  const results = await page.evaluate(() => window.__loaderProbe())
  console.log('[loader probe]', JSON.stringify(results))
  await browser.close()
} finally {
  server.close()
}
