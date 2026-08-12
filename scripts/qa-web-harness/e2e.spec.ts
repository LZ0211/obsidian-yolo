/**
 * Web 端 e2e：真实会话服务（Node harness 进程）+ 真实浏览器（Playwright）。
 *
 * 运行：npx playwright test scripts/qa-web-harness/e2e.spec.ts
 * （需要先构建过 web-ui/ 静态产物：npm run web-ui:build）
 *
 * 用例：
 *  a) token 认证（webAuthModal 输入 share token → 会话建立）
 *  b) mock LLM 文本流 → 回复渲染（含流式增量观察 + 最终文本断言）
 *  c) mock LLM tool_call → 工具审批 UI → 批准 → 工具结果 → 续答
 *  d) 重启 harness-server（同临时目录）→ 会话仍在（JSON 落盘持久化）
 *  e) 会话过滤（不同 agent 不可见）——装配复杂，跳过（见 e2e-report）
 */
import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../..')
const JEST_BIN = path.join(
  REPO_ROOT,
  'node_modules',
  'jest',
  'bin',
  'jest.js',
)

export type HarnessInfo = {
  baseDir: string
  port: number
  shareToken: string
  vaultIdentity: string
}

function startHarness(): {
  child: ChildProcess
  ready: Promise<HarnessInfo>
} {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const reuseTmpdir = process.env.E2E_HARNESS_TMPDIR
  if (reuseTmpdir) {
    env.E2E_HARNESS_TMPDIR = reuseTmpdir
  }
  const child = spawn(
    process.execPath,
    [
      JEST_BIN,
      '-c',
      'scripts/qa-web-harness/jest.config.js',
      'scripts/qa-web-harness/harness-server.test.ts',
      '--runInBand',
    ],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  const ready = new Promise<HarnessInfo>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `harness did not become ready in 60s. stdout so far:\n${stdout}`,
        ),
      )
    }, 60_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const match = stdout.match(/E2E_HARNESS_READY (\{.*\})\s*$/)
      if (match) {
        clearTimeout(timer)
        resolve(JSON.parse(match[1]) as HarnessInfo)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`harness exited early with code ${code}:\n${stdout}`))
    })
  })
  return { child, ready }
}

async function stopHarness(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function loginAndWaitReady(page: import('@playwright/test').Page, info: HarnessInfo) {
  await page.goto(`http://127.0.0.1:${info.port}/`)
  // 认证模态：yolo-web-auth-page 出现（无会话 → login 状态）
  await page.waitForSelector('.yolo-web-auth-page', { timeout: 30_000 })
  const input = page.locator('.yolo-web-auth-input')
  await input.fill(info.shareToken)
  await page.locator('.yolo-web-auth-submit').click()
  // 登录成功 → shell 出现（auth page 移除）
  await page.waitForSelector('.yolo-web-auth-page', { state: 'detached', timeout: 30_000 })
}

async function sendMessage(
  page: import('@playwright/test').Page,
  text: string,
) {
  // 输入区是 Lexical contentEditable（同桌面 Obsidian 的 ChatUserInput），
  // 用键盘输入 + Enter 发送。
  const input = page.locator('.yolo-message-input-core [contenteditable="true"]')
  await input.waitFor({ state: 'visible', timeout: 30_000 })
  await input.click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test.describe.configure({ mode: 'serial' })

test.describe('web e2e harness', () => {
  test('a+b: token 认证 + mock LLM 文本流回复', async ({ page }) => {
    const { child, ready } = startHarness()
    const info = await ready
    try {
      await loginAndWaitReady(page, info)

      // 流式过程：mock 文本流分 3 段增量，先出现第一段（尚未完成）
      await sendMessage(page, 'hello harness')
      const assistant = page.locator('.yolo-chat-messages-assistant')
      await expect(assistant.first()).toBeVisible({ timeout: 30_000 })
      await expect(assistant.first()).toContainText('Hello from', { timeout: 30_000 })

      // 最终文本
      await expect(assistant.first()).toContainText('Hello from the mock LLM!', {
        timeout: 30_000,
      })
    } finally {
      await stopHarness(child)
    }
  })

  test('c: mock LLM tool_call → 审批 UI → 批准 → 续答', async ({ page }) => {
    const { child, ready } = startHarness()
    const info = await ready
    try {
      await loginAndWaitReady(page, info)

      await sendMessage(page, 'use tool:echo please')
      // 审批 UI：工具卡片出现（pending_approval 状态），批准按钮文案
      // 中/英两种 locale 都可能出现（语言解析路径差异），都匹配。
      const toolcard = page.locator('.yolo-toolcall')
      await toolcard.first().waitFor({ state: 'visible', timeout: 45_000 })
      const approval = toolcard
        .locator('button:has-text("允许"), button:has-text("Allow")')
        .first()
      await approval.waitFor({ state: 'visible', timeout: 45_000 })

      // 批准 → 工具结果 → 续答
      await approval.click()
      const assistant = page.locator('.yolo-chat-messages-assistant')
      await expect(assistant.first()).toContainText('Tool executed, answer follows!', {
        timeout: 45_000,
      })
    } finally {
      await stopHarness(child)
    }
  })

  test('d: 重启 harness → 会话仍在（JSON 落盘）', async () => {
    const tmpdir = process.env.E2E_HARNESS_TMPDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-web-e2e-persist-'))

    // 第一次启动：发消息，等回复
    const first = startHarnessWithTmpdir(tmpdir)
    const info1 = await first.ready
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await loginAndWaitReady(page, info1)
      await sendMessage(page, 'hello harness')
      const assistant = page.locator('.yolo-chat-messages-assistant')
      await expect(assistant.first()).toContainText('Hello from the mock LLM!', { timeout: 30_000 })
      await page.close()
    } finally {
      await browser.close()
      await stopHarness(first.child)
    }

    // 第二次启动（同一临时目录，复用 shareToken）：历史会话可见
    const second = startHarnessWithTmpdir(tmpdir)
    const info2 = await second.ready
    const browser2 = await chromium.launch({ headless: true })
    try {
      const page = await browser2.newPage()
      await loginAndWaitReady(page, info2)
      // 历史侧栏出现之前的会话（标题未生成时为 New chat，点开验证内容）
      const historyItem = page
        .locator('.yolo-web-history-pane li.yolo-chat-list-dropdown-item')
        .first()
      await historyItem.waitFor({ state: 'visible', timeout: 30_000 })
      await historyItem.click()
      // 会话打开后，用户消息与 mock 回复都在（JSON 落盘恢复的证据）
      await expect(
        page.locator('.yolo-chat-messages-user:has-text("hello harness")').first(),
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        page.locator('.yolo-chat-messages-assistant:has-text("Hello from the mock LLM!")').first(),
      ).toBeVisible({ timeout: 30_000 })
    } finally {
      await browser2.close()
      await stopHarness(second.child)
    }
  })

  test('e: 会话过滤（不同 agent 隔离）', async () => {
    test.skip(true, '装配复杂：需要第二个 workspace agent 的 share token 会话与不同 rootHash 会话；harness 目前只装配单 agent，见 e2e-report.md')
  })
})

function startHarnessWithTmpdir(tmpdir: string): { child: ChildProcess; ready: Promise<HarnessInfo> } {
  const previous = process.env.E2E_HARNESS_TMPDIR
  process.env.E2E_HARNESS_TMPDIR = tmpdir
  try {
    return startHarness()
  } finally {
    if (previous === undefined) {
      delete process.env.E2E_HARNESS_TMPDIR
    } else {
      process.env.E2E_HARNESS_TMPDIR = previous
    }
  }
}
