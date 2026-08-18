// Verifies the sqlite-engine WASM in a real Chromium (same engine family as
// Obsidian's Electron renderer): loads the built component artifact and drives
// open/insert/query/transaction/flush/reopen against a mock vault adapter.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const PORT = 48232
const ROOT = new URL('../', import.meta.url)
const entryPath = 'runtime-components/sqlite-engine/dist/entry.js'

const html = `<!doctype html>
<meta charset="utf-8">
<script type="module">
  globalThis.__yolo_register_runtime_component__ = (definition) => {
    window.__sqlite = definition.create()
  }
  await import('/${entryPath}')
  window.__sqliteReady = true
</script>
<script type="module">
  window.__sqliteProbe = async () => {
    const files = new Map()
    const adapter = {
      exists: async (path) => files.has(path),
      readBinary: async (path) => files.get(path),
      writeBinary: async (path, data) => {
        files.set(path, data.slice(0))
      },
      rename: async (from, to) => {
        const bytes = files.get(from)
        if (bytes !== undefined) {
          files.delete(from)
          files.set(to, bytes)
        }
      },
    }
    const results = {}
    const runtime = await window.__sqlite.openSqliteJsRuntime({
      relativePath: 'probe.db',
      adapter,
    })
    runtime.exec('create table if not exists entries (id integer primary key, note text)')
    runtime.exec('insert into entries (note) values (?)', ['你好'])
    results.rows = runtime.query('select id, note from entries order by id')
    results.transaction = (() => {
      let committed = null
      runtime.transaction(() => {
        runtime.exec('insert into entries (note) values (?)', ['事务中'])
      })
      committed = runtime.query('select count(*) as n from entries')[0].n
      try {
        runtime.transaction(() => {
          runtime.exec('insert into entries (note) values (?)', ['回滚'])
          throw new Error('rollback')
        })
      } catch {
        // expected
      }
      const afterRollback = runtime.query('select count(*) as n from entries')[0].n
      return { committed, afterRollback }
    })()
    await runtime.flush()
    results.persistedBytes = files.get('probe.db') ? files.get('probe.db').byteLength : 0
    runtime.close()

    // Reopen from the flushed bytes — data must survive.
    const reopened = await window.__sqlite.openSqliteJsRuntime({
      relativePath: 'probe.db',
      adapter,
    })
    results.reopenedRows = reopened.query('select note from entries order by id')
    reopened.close()
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
  page.on('pageerror', (error) => {
    console.log('[pageerror]', String(error).slice(0, 300))
  })
  await page.goto(`http://localhost:${PORT}/index.html`)
  await page.waitForFunction('window.__sqliteReady === true', null, { timeout: 15_000 })

  const probe = await page.evaluate(() => window.__sqliteProbe())
  console.log('[sqlite probe]', JSON.stringify(probe))

  record(
    'insert + query',
    Array.isArray(probe.rows) &&
      probe.rows.length === 1 &&
      probe.rows[0]?.note === '你好',
    JSON.stringify(probe.rows),
  )
  record(
    'transaction commit/rollback',
    probe.transaction.committed === 2 && probe.transaction.afterRollback === 2,
    JSON.stringify(probe.transaction),
  )
  record('flush persists bytes', probe.persistedBytes > 0, `${probe.persistedBytes} bytes`)
  record(
    'reopen retains data',
    Array.isArray(probe.reopenedRows) &&
      probe.reopenedRows.length === 2 &&
      probe.reopenedRows[0]?.note === '你好',
    JSON.stringify(probe.reopenedRows),
  )

  await browser.close()
} finally {
  server.close()
}

const failed = results.filter((result) => !result.ok)
if (failed.length > 0) {
  console.error(`\n${failed.length} sqlite check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll sqlite WASM checks passed')
