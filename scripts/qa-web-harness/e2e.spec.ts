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
 *  f) durable delegate 全链：父 mock 发 delegate_subagent（delegatedRoleId）→
 *     真实 callLocalFileTool 路径 spawn 持久会话 → 子代理 mock 完成 → 卡片
 *     完成态 + 父会话结果 → after_run 意图（harness 测试入口投递）→ 续跑
 *     run 2 结算（session JSON 落盘断言）
 *  g) 崩溃重启 → needs_resume → 恢复 UI：after_run 续跑 run 2 运行中
 *     （慢速 mock 回合）kill harness → 同 TMPDIR 重启 → 恢复扫描置
 *     NEEDS_RESUME → 卡片状态行 + 恢复按钮 → 恢复/重投 → run 3 续跑完成
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

  test('f: durable delegate 全链（spawn 持久会话 → 完成 → after_run 续跑 run 2）', async ({ page }) => {
    const { child, ready } = startHarness()
    const info = await ready
    try {
      await loginAndWaitReady(page, info)

      // 父 mock 回合：delegate_subagent 工具调用 → 真实 callLocalFileTool →
      // spawn 持久会话（durable）→ 续答文本。mock 的 isToolExecutionAllowed
      // 要求显式允许（既有 harness 契约，场景 c 同款）→ 先点审批按钮。
      await sendMessage(page, 'delegate a subagent please')

      // 0) 审批 UI（PendingApproval 走 .yolo-toolcall 通用卡片）→ 批准
      const toolcard = page.locator('.yolo-toolcall')
      await toolcard.first().waitFor({ state: 'visible', timeout: 45_000 })
      const approval = toolcard
        .locator('button:has-text("允许"), button:has-text("Allow")')
        .first()
      await approval.waitFor({ state: 'visible', timeout: 45_000 })
      await approval.click()

      // 1) 卡片出现（delegate_subagent 且非 PendingApproval → SubagentCard）
      const card = page.locator('.yolo-subagent-card')
      await card.first().waitFor({ state: 'visible', timeout: 45_000 })

      // 2) 父会话出现派发后结果文本（工具执行完成 → 父回合续答）
      const assistant = page.locator('.yolo-chat-messages-assistant')
      await expect(
        assistant.filter({ hasText: 'Delegation accepted, task delegated!' }).first(),
      ).toBeVisible({ timeout: 45_000 })

      // 3) 子代理 mock 完成 → 卡片完成态 + session JSON 落盘（run 1 结算）
      const sessionRow = await waitForSessionJson(
        info.baseDir,
        (row) =>
          Array.isArray(row.runs) &&
          row.runs.length >= 1 &&
          row.runs[0].status === 'completed' &&
          row.session?.status === 'idle',
        60_000,
      )
      const sessionId = sessionRow.session.sessionId
      expect(typeof sessionId).toBe('string')
      await expect(
        page.locator('.yolo-subagent-card--success').first(),
      ).toBeVisible({ timeout: 45_000 })

      // 4) after_run 意图（harness 测试入口：真实 service.send + deliver）→
      //    续跑 run 2（IDLE 续跑：beginRun 创建 run 2 并原子 claim 意图）
      const sent = await harnessApiPost(info.port, '/api/harness/subagent/send-and-deliver', {
        sessionId,
        text: 'Follow up with the risk section',
      })
      expect(sent.ok).toBe(true)

      // 5) run 2 结算：runs[1].status completed + 意图 COMMITTED + session 回 idle
      const finalRow = await waitForSessionJson(
        info.baseDir,
        (row) =>
          Array.isArray(row.runs) &&
          row.runs.length >= 2 &&
          row.runs[1].status === 'completed' &&
          row.runs[1].result?.content?.includes('risk section added') &&
          row.session?.status === 'idle' &&
          row.session?.nextRunSequence === 3,
        60_000,
      )
      expect(finalRow.intents?.[0]?.state).toBe('committed')
    } finally {
      await stopHarness(child)
    }
  })

  test('g: 崩溃重启 → needs_resume → 恢复/重投 → 续跑 run 3', async () => {
    const tmpdir = process.env.E2E_HARNESS_TMPDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-web-e2e-delegate-'))

    // ── 阶段 1：delegate run 1 完成 → after_run 意图 → 续跑 run 2 运行中 kill
    const first = startHarnessWithTmpdir(tmpdir)
    const info1 = await first.ready
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch({ headless: true })
    let phase1SessionId = ''
    try {
      const page = await browser.newPage()
      await loginAndWaitReady(page, info1)
      await sendMessage(page, 'delegate a subagent please')

      // delegate 审批（mock 要求显式允许，与场景 c/f 同款）
      const toolcard = page.locator('.yolo-toolcall')
      await toolcard.first().waitFor({ state: 'visible', timeout: 45_000 })
      const approval = toolcard
        .locator('button:has-text("允许"), button:has-text("Allow")')
        .first()
      await approval.waitFor({ state: 'visible', timeout: 45_000 })
      await approval.click()

      // run 1 完成（父会话结果文本出现）
      const assistant = page.locator('.yolo-chat-messages-assistant')
      await expect(
        assistant.filter({ hasText: 'Delegation accepted, task delegated!' }).first(),
      ).toBeVisible({ timeout: 45_000 })

      // run 1 结算落盘
      const row1 = await waitForSessionJson(
        info1.baseDir,
        (row) => row.runs?.[0]?.status === 'completed' && row.session?.status === 'idle',
        60_000,
      )
      phase1SessionId = row1.session.sessionId

      // after_run 意图 → 续跑 run 2（场景 g：慢速 mock 回合保持未结算）
      const sent = await harnessApiPost(info1.port, '/api/harness/subagent/send-and-deliver', {
        sessionId: phase1SessionId,
        text: 'Follow up with the compliance review',
      })
      expect(sent.ok).toBe(true)

      // run 2 已开始（session RUNNING + currentRunSequence 2）→ 立即 kill：
      // 崩溃发生在结算之前，重启进程的恢复扫描必须把它标记为中断
      await waitForSessionJson(
        info1.baseDir,
        (row) => row.session?.status === 'running' && row.session?.currentRunSequence === 2,
        30_000,
      )
      await page.close()
    } finally {
      await browser.close()
      await stopHarness(first.child)
    }
    expect(phase1SessionId.length).toBeGreaterThan(0)

    // ── 阶段 2：同 TMPDIR 重启 → 恢复扫描 → needs_resume UI → 恢复/重投 → 续跑
    const second = startHarnessWithTmpdir(tmpdir)
    const info2 = await second.ready
    const browser2 = await chromium.launch({ headless: true })
    try {
      const page = await browser2.newPage()
      await loginAndWaitReady(page, info2)

      // 打开历史会话（父会话工具消息持久化 → 卡片重建，sessionId 经
      // accepted 响应兜底解析）
      const historyItem = page
        .locator('.yolo-web-history-pane li.yolo-chat-list-dropdown-item')
        .first()
      await historyItem.waitFor({ state: 'visible', timeout: 30_000 })
      await historyItem.click()

      // 卡片 + needs_resume 状态行（恢复扫描已完成：run 2 INTERRUPTED +
      // session NEEDS_RESUME；i18n 文案中/英双匹配）
      const card = page.locator('.yolo-subagent-card')
      await card.first().waitFor({ state: 'visible', timeout: 45_000 })
      const statusLine = card.locator('.yolo-subagent-card__session-status').first()
      await statusLine.waitFor({ state: 'visible', timeout: 45_000 })
      await expect(statusLine).toContainText(/需要恢复|Needs resume/, { timeout: 15_000 })

      // 打开详情弹窗 → 恢复按钮可见 → 点击恢复（run 2 → ABORTED，session → idle）
      await card.first().locator('.yolo-subagent-card__main').click()
      const modal = page.locator('.yolo-subagent-detail-overlay')
      await modal.waitFor({ state: 'visible', timeout: 30_000 })
      const recoverBtn = modal.locator('.yolo-subagent-detail-recover-btn')
      await recoverBtn.waitFor({ state: 'visible', timeout: 30_000 })
      await recoverBtn.click()

      // 被中断 run 已 claim 的 after_run 意图经扫描置 RECOVERY_REQUIRED →
      // 弹窗出现重投按钮 → 点击重投（意图 PENDING → deliver → 续跑 run 3）
      const resendBtn = modal.locator('.yolo-subagent-detail-queued-btn--resend')
      await resendBtn.waitFor({ state: 'visible', timeout: 30_000 })
      await resendBtn.click()

      // run 3 续跑完成：runs[2] completed（恢复路径沿用被中断 runKey？不——
      // 先 recover 置 ABORTED 再 resend 走 IDLE beginRun 新建 run 3）
      const finalRow = await waitForSessionJson(
        info2.baseDir,
        (row) =>
          Array.isArray(row.runs) &&
          row.runs.length >= 3 &&
          row.runs[2].status === 'completed' &&
          row.runs[2].result?.content?.includes('Compliance follow-up completed') &&
          row.session?.status === 'idle',
        60_000,
      )
      expect(finalRow.session.sessionId).toBe(phase1SessionId)
      expect(finalRow.runs.map((run) => run.status)).toEqual([
        'completed',
        'aborted',
        'completed',
      ])
      expect(finalRow.intents?.[0]?.state).toBe('committed')
    } finally {
      await browser2.close()
      await stopHarness(second.child)
    }
  })
})

/**
 * 读取 baseDir 下唯一的 durable session JSON（`YOLO/data/subagents/v1_*.json`），
 * 轮询直到 predicate 满足（Playwright 侧直读 fs——会话落盘即 durable 语义）。
 */
async function waitForSessionJson(
  baseDir: string,
  predicate: (row: StoredSessionRow) => boolean,
  timeoutMs = 60_000,
): Promise<StoredSessionRow> {
  const dir = path.join(baseDir, 'YOLO', 'data', 'subagents')
  const deadline = Date.now() + timeoutMs
  let lastRows: StoredSessionRow[] = []
  while (Date.now() < deadline) {
    lastRows = readSessionRows(dir)
    if (lastRows.length > 0 && predicate(lastRows[0])) {
      return lastRows[0]
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    `timed out waiting for subagent session JSON at ${dir}; last rows: ${JSON.stringify(
      lastRows.map((row) => ({
        session: row.session,
        runs: row.runs?.map((run) => ({
          runSequence: run.runSequence,
          status: run.status,
          result: run.result,
        })),
      })),
    )}`,
  )
}

type StoredSessionRow = {
  session?: {
    sessionId: string
    status: string
    currentRunSequence?: number
    nextRunSequence?: number
  }
  runs?: Array<{
    runSequence: number
    runKey?: string
    status: string
    result?: { status?: string; content?: string }
  }>
  intents?: Array<{ state: string }>
}

function readSessionRows(dir: string): StoredSessionRow[] {
  if (!fs.existsSync(dir)) return []
  const rows: StoredSessionRow[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!/^v\d+_.+\.json$/.test(name)) continue
    try {
      rows.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as StoredSessionRow)
    } catch {
      // 半写文件（kill 竞态）：跳过，下一轮轮询
    }
  }
  return rows
}

async function harnessApiPost(
  port: number,
  route: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    // 空响应体
  }
  return { ok: response.ok, status: response.status, body: parsed }
}

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
