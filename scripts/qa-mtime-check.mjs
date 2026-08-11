#!/usr/bin/env node
/** CDP 验证：Obsidian stat.mtime vs rag_files 存储 mtime。 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const valueFor = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const vaultPath = resolve(valueFor('--vault-path') ?? '.tmp/qa-vault')
const port = Number(valueFor('--port') ?? '9233')
const obsidianExe =
  valueFor('--obsidian-exe') ?? 'C:/Program Files/Obsidian/Obsidian.exe'

const dbRows = JSON.parse(readFileSync('/tmp/rag-samples.json', 'utf8'))

async function launch() {
  const uri = `obsidian://open?path=${encodeURIComponent(vaultPath)}`
  const child = spawn(obsidianExe, [`--remote-debugging-port=${port}`, uri], {
    stdio: 'ignore',
  })
  for (let i = 0; i < 60; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          if (page.url().includes('obsidian') || page.url().includes('app://')) {
            return { child, browser, page }
          }
        }
      }
      await browser.close()
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  child.kill()
  throw new Error('Timed out waiting for Obsidian CDP')
}

async function waitForPlugin(page, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const ready = await page.evaluate(
      () => Boolean(globalThis.app?.plugins?.plugins?.yolo),
    )
    if (ready) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('YOLO plugin did not load')
}

const { child, browser, page } = await launch()
try {
  await waitForPlugin(page)
  const obsidianStats = await page.evaluate((paths) => {
    const vault = globalThis.app.vault
    return paths.map((p) => {
      const file = vault.getAbstractFileByPath(p)
      if (!file) return { path: p, found: false }
      const raw = file.stat?.mtime
      return {
        path: p,
        found: true,
        raw,
        rounded: typeof raw === 'number' ? Math.round(raw) : null,
        json: JSON.stringify(raw),
      }
    })
  }, dbRows.map((r) => r.path))

  console.log('[qa] Obsidian stat.mtime vs rag_files mtime:')
  let mismatch = 0
  for (let i = 0; i < dbRows.length; i++) {
    const dbRow = dbRows[i]
    const obs = obsidianStats[i]
    if (!obs.found) {
      console.log('  MISSING in vault:', dbRow.path)
      continue
    }
    const match = obs.rounded === dbRow.mtime
    if (!match) mismatch += 1
    console.log(
      match ? '  MATCH   ' : '  MISMATCH',
      'db:', dbRow.mtime,
      'obsidian:', obs.raw,
      'rounded:', obs.rounded,
      obs.path.slice(0, 60),
    )
  }
  console.log(`[qa] mismatch: ${mismatch}/${dbRows.length}`)
} finally {
  await browser.close()
  child.kill()
}
