#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
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
  const info = await page.evaluate(() => {
    const app = globalThis.app
    return {
      vaultPath: app.vault.adapter.getBasePath(),
      vaultName: app.vault.getName(),
      sampleExists: app.vault.getAbstractFileByPath(
        '00-Email/Inbox/2026-07-14_回复：46工艺路线③力学仿真（盖板厚度0.4mm→0.6mm+止动架3.3mm）_3224bfa5.md',
      ) != null,
      fileCount: app.vault.getFiles().length,
    }
  })
  console.log('[qa] vault:', JSON.stringify(info))
} finally {
  await browser.close()
  child.kill()
}
