#!/usr/bin/env node
/**
 * Fake-LLM feature e2e over CDP.
 *
 * Installs the QA driver (`__YOLO_ENABLE_STATE_QA__`) which overrides the real
 * model with a deterministic fake provider, then exercises tool approval and
 * subagent flows in real Obsidian without depending on a live model:
 *
 *   - tool-approval: the fake provider emits an fs_read tool call, the UI asks
 *     for approval, we approve, and the agent settles with a fake response.
 *   - subagent-completed: the fake provider emits a delegate_subagent tool
 *     call, we approve, and the subagent completes with the QA result.
 *
 * Usage:
 *   node scripts/qa-feature-e2e.mjs --source-vault "D:\Obsidian\个人笔记"
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const valueFor = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const vaultPath = resolve(valueFor('--vault-path') ?? '.tmp/yolo-startup-vault')
const sourceVault = valueFor('--source-vault')
const port = Number(valueFor('--port') ?? '9231')
const obsidianExe =
  valueFor('--obsidian-exe') ?? 'C:/Program Files/Obsidian/Obsidian.exe'

const pluginDir = resolve(vaultPath, '.obsidian/plugins/yolo')
const dataPath = resolve(pluginDir, 'data.json')

async function prepareVault() {
  await mkdir(pluginDir, { recursive: true })
  await mkdir(resolve(vaultPath, 'YOLO/.yolo_json_db/agent-sessions'), {
    recursive: true,
  })
  if (sourceVault) {
    const srcData = resolve(sourceVault, '.obsidian/plugins/yolo/data.json')
    if (!existsSync(srcData)) throw new Error(`Source vault data.json not found: ${srcData}`)
    const { readFile } = await import('node:fs/promises')
    await writeFile(dataPath, await readFile(srcData, 'utf8'))
    console.log(`[qa] using provider config from ${srcData}`)
  }
}

async function launch() {
  const uri = `obsidian://open?path=${encodeURIComponent(vaultPath)}`
  const child = spawn(obsidianExe, [`--remote-debugging-port=${port}`, uri], {
    stdio: 'ignore',
  })
  for (let i = 0; i < 40; i++) {
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

async function waitForPlugin(page, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const ready = await page.evaluate(() =>
      Boolean(globalThis.app?.plugins?.plugins?.yolo),
    )
    if (ready) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('YOLO plugin did not load')
}

async function enableQaBridge(page) {
  await page.addInitScript(() => {
    globalThis.__YOLO_ENABLE_STATE_QA__ = true
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPlugin(page)
  await page.waitForFunction(
    () => Boolean(globalThis.__YOLO_STATE_QA__?.snapshot?.()),
    undefined,
    { timeout: 30_000 },
  )
  console.log('[qa] fake-LLM bridge installed')
}

const configureQa = (page, controls) =>
  page.evaluate(
    (nextControls) => {
      globalThis.__YOLO_STATE_QA__?.configure(nextControls)
    },
    controls,
  )

async function openNewChat(page) {
  await page.evaluate(async () => {
    const executed = await globalThis.app?.commands?.executeCommandById?.(
      'yolo:open-new-chat',
    )
    if (executed === false) throw new Error('open-new-chat command failed')
  })
  await page.waitForFunction(
    () => Boolean(document.querySelector('.yolo-content-editable')),
    undefined,
    { timeout: 20_000 },
  )
}

async function submitMessage(page, text) {
  const editor = page
    .locator('.yolo-chat-container .yolo-content-editable')
    .first()
  await editor.click()
  await page.keyboard.type(text, { delay: 5 })
  await page
    .locator('.yolo-chat-user-input-submit-button-circle')
    .first()
    .click()
}

async function waitForApprovalAndApprove(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button')].some((button) =>
        /^(allow|approve|允许|批准)$/i.test((button.textContent ?? '').trim()),
      ),
    undefined,
    { timeout: 30_000 },
  )
  const button = page
    .locator('button')
    .filter({ hasText: /^(允许|批准|allow|approve)$/i })
    .first()
  await button.click()
  console.log('[qa] approved tool call')
}

async function waitForText(page, text, timeoutMs = 120_000) {
  await page.waitForFunction(
    (expected) => (document.body.textContent ?? '').includes(expected),
    text,
    { timeout: timeoutMs },
  )
}

async function runScenario({ page, label, configure, submit, approve, expectText }) {
  console.log(`\n[qa] === scenario: ${label} ===`)
  await configureQa(page, configure)
  await openNewChat(page)
  await submitMessage(page, submit)
  if (approve) await waitForApprovalAndApprove(page)
  if (expectText) await waitForText(page, expectText)
  console.log(`[qa] ${label} PASS`)
}

await prepareVault()
const { child, browser, page } = await launch()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
try {
  await waitForPlugin(page)
  await enableQaBridge(page)

  await runScenario({
    page,
    label: 'tool-approval',
    configure: {
      providerMode: 'tool',
      providerDelayMs: 0,
      requireToolApproval: true,
      toolResultMode: 'normal',
    },
    submit: 'QA feature: trigger a read tool call',
    approve: true,
    expectText: 'Unified state QA response',
  })

  await runScenario({
    page,
    label: 'subagent-completed',
    configure: {
      providerMode: 'subagent',
      providerDelayMs: 0,
      requireToolApproval: true,
      toolResultMode: 'normal',
      subagentOutcome: 'completed',
    },
    submit: 'QA feature: delegate a subagent task',
    approve: true,
    expectText: 'qa-subagent-task',
  })

  const journal = await page.evaluate(() => {
    try {
      const el = document.querySelector('.yolo-chat-messages')
      return el ? el.childElementCount : -1
    } catch {
      return -1
    }
  })
  console.log(`\n[qa] chat message nodes: ${journal}`)
  if (pageErrors.length > 0) {
    console.log(`\n[qa] page errors (${pageErrors.length}):`)
    for (const entry of pageErrors.slice(0, 5)) console.log(`  ${entry}`)
  }
  console.log('\nQA FEATURE E2E PASS: tool approval + subagent confirmed')
} catch (error) {
  console.error(`[qa] FAIL: ${error.message}`)
  const dump = await page
    .evaluate(() => {
      const chat = document.querySelector('.yolo-chat-messages')
      const buttons = [...document.querySelectorAll('button')]
        .map((b) => (b.textContent ?? '').trim())
        .filter(Boolean)
        .slice(0, 25)
      const approvalButtons = [...document.querySelectorAll('button')]
        .filter((b) => /^(允许|批准|allow|approve|拒绝|reject|deny)$/i.test((b.textContent ?? '').trim()))
        .map((b) => ({
          text: (b.textContent ?? '').trim(),
          visible: b.offsetParent !== null,
          rect: (() => {
            const r = b.getBoundingClientRect()
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
          })(),
          aria: b.getAttribute('aria-label'),
        }))
      const toolHeaders = [...document.querySelectorAll('.yolo-toolcall-header')].map(
        (h) => ({
          ariaExpanded: h.getAttribute('aria-expanded'),
          text: (h.textContent ?? '').trim().slice(0, 60),
        }),
      )
      return {
        chatText: chat?.textContent?.slice(-800) ?? '(no chat)',
        buttons,
        approvalButtons,
        toolHeaders,
        bodyTail: (document.body.textContent ?? '').slice(-400),
      }
    })
    .catch((e) => ({ error: String(e) }))
  console.log('\n[qa] state dump:', JSON.stringify(dump, null, 2))
  process.exitCode = 1
} finally {
  await browser.close().catch(() => undefined)
  child?.kill()
}
