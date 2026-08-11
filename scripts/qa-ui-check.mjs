#!/usr/bin/env node
/**
 * UI 验证（CDP）：打开真实 Obsidian，检查 YOLO 设置页的
 * RAG 数据库弹窗 loading、模型设置 embedding 选择、自动更新开关。
 *
 * 用法（先关闭当前 Obsidian）：
 *   node scripts/qa-ui-check.mjs --vault-path "D:\Obsidian\个人笔记"
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const valueFor = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const vaultPath = resolve(valueFor('--vault-path') ?? '.tmp/qa-vault')
const port = Number(valueFor('--port') ?? '9232')
const obsidianExe =
  valueFor('--obsidian-exe') ?? 'C:/Program Files/Obsidian/Obsidian.exe'

async function launch() {
  const uri = `obsidian://open?path=${encodeURIComponent(vaultPath)}`
  const child = spawn(
    obsidianExe,
    [`--remote-debugging-port=${port}`, uri],
    { stdio: 'ignore' },
  )
  for (let i = 0; i < 60; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          if (
            page.url().includes('obsidian') ||
            page.url().includes('app://')
          ) {
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

async function openYoloSettings(page) {
  await page.evaluate(() => {
    const app = globalThis.app
    app.setting.open()
    app.setting.openTabById('yolo')
  })
  await new Promise((r) => setTimeout(r, 1500))
}

const { child, browser, page } = await launch()
try {
  await waitForPlugin(page)
  console.log('[qa] YOLO plugin loaded')
  await openYoloSettings(page)
  console.log('[qa] settings open')

  // 检查 RAG 设置页的 embedding 模型选择 + 自动更新开关
  const ragChecks = await page.evaluate(() => {
    const body = document.body.textContent ?? ''
    return {
      embeddingModelSelector: body.includes('Embedding model') || body.includes('嵌入模型'),
      autoUpdateToggle: body.includes('Auto update index') || body.includes('自动更新索引'),
      ragTab: body.includes('Knowledge base') || body.includes('知识库'),
    }
  })
  console.log('[qa] RAG checks:', JSON.stringify(ragChecks))

  // 切到 RAG tab（如果设置 tab 有 RAG 导航）
  await page.evaluate(() => {
    const nav = document.querySelector('.yolo-settings-nav')
    const buttons = nav ? Array.from(nav.querySelectorAll('button')) : []
    const rag = buttons.find((b) => /rag|知识库|knowledge/i.test(b.textContent ?? ''))
    rag?.click()
  })
  await new Promise((r) => setTimeout(r, 1000))

  // 截图：RAG 设置
  await page.screenshot({ path: 'qa-rag-settings.png', fullPage: false })
  console.log('[qa] screenshot: qa-rag-settings.png')

  // 打开数据库管理弹窗（RAGSection 的按钮）
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const db = buttons.find((b) => /数据库|database|explorer/i.test(b.textContent ?? ''))
    db?.click()
  })
  await new Promise((r) => setTimeout(r, 3000))

  // 检查弹窗是否 loading
  const modalState = await page.evaluate(() => {
    const body = document.body.textContent ?? ''
    return {
      loadingVisible: body.includes('Loading'),
      tableVisible: body.includes('sqlite_master') || body.includes('rag_files') || body.includes('select'),
      hasModal: Boolean(document.querySelector('.modal-content')),
    }
  })
  console.log('[qa] explorer modal:', JSON.stringify(modalState))
  await page.screenshot({ path: 'qa-db-explorer.png' })
  console.log('[qa] screenshot: qa-db-explorer.png')

  // 检查 console 错误
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text().slice(0, 300))
  })
  await new Promise((r) => setTimeout(r, 1000))
  console.log('[qa] console errors:', errors.length ? errors.slice(0, 5) : 'none')
} finally {
  await browser.close()
  child.kill()
}
