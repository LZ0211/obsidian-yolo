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
 *  f) ephemeral delegate 全链：父 mock 发 delegate_subagent（delegatedRoleId）
 *     → 真实 callLocalFileTool 路径 runSubagent（纯 ephemeral 子 run）→
 *     子代理 mock 完成 → 卡片完成态 + 父会话出现 subagent_result 消息
 */
import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../..')
const JEST_BIN = path.join(REPO_ROOT, 'node_modules', 'jest', 'bin', 'jest.js')

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

async function loginAndWaitReady(
  page: import('@playwright/test').Page,
  info: HarnessInfo,
) {
  await page.goto(`http://127.0.0.1:${info.port}/`)
  // 认证模态：yolo-web-auth-page 出现（无会话 → login 状态）
  await page.waitForSelector('.yolo-web-auth-page', { timeout: 30_000 })
  const input = page.locator('.yolo-web-auth-input')
  await input.fill(info.shareToken)
  await page.locator('.yolo-web-auth-submit').click()
  // 登录成功 → shell 出现（auth page 移除）
  await page.waitForSelector('.yolo-web-auth-page', {
    state: 'detached',
    timeout: 30_000,
  })
}

async function sendMessage(
  page: import('@playwright/test').Page,
  text: string,
) {
  // 输入区是 Lexical contentEditable（同桌面 Obsidian 的 ChatUserInput），
  // 用键盘输入 + Enter 发送。
  const input = page.locator(
    '.yolo-message-input-core [contenteditable="true"]',
  )
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
      await expect(assistant.first()).toContainText('Hello from', {
        timeout: 30_000,
      })

      // 最终文本
      await expect(assistant.first()).toContainText(
        'Hello from the mock LLM!',
        {
          timeout: 30_000,
        },
      )
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
      await expect(assistant.first()).toContainText(
        'Tool executed, answer follows!',
        {
          timeout: 45_000,
        },
      )
    } finally {
      await stopHarness(child)
    }
  })

  test('new chat clears an interrupted history load', async ({ page }) => {
    const { child, ready } = startHarness()
    const info = await ready
    let releaseHistoryLoad: () => void = () => undefined
    try {
      await loginAndWaitReady(page, info)
      await sendMessage(page, 'hello harness')
      await expect(
        page.locator('.yolo-chat-messages-assistant').first(),
      ).toContainText('Hello from the mock LLM!', { timeout: 30_000 })
      const webSessionId = await page.evaluate(() =>
        localStorage.getItem('yolo-web-session-id'),
      )
      const chats = (await fetchJson(
        info.port,
        '/api/chat/list',
        webSessionId ?? undefined,
      )) as Array<{ id: string }>
      const conversationId = chats[0]?.id
      if (!conversationId)
        throw new Error('created conversation was not listed')

      const newChatButton = page
        .locator('.yolo-chat-header-buttons button')
        .first()
      const emptyState = page.locator('.yolo-chat-empty-state-overlay')
      await newChatButton.click()
      await expect(emptyState).toBeVisible()

      const historyLoadGate = new Promise<void>((resolve) => {
        releaseHistoryLoad = resolve
      })
      let markHistoryLoadStarted: () => void = () => undefined
      const historyLoadStarted = new Promise<void>((resolve) => {
        markHistoryLoadStarted = resolve
      })
      let conversationReadCount = 0
      await page.route(`**/api/chat/get/${conversationId}`, async (route) => {
        conversationReadCount += 1
        if (conversationReadCount < 2) {
          await route.continue()
          return
        }
        markHistoryLoadStarted()
        await historyLoadGate
        await route.continue()
      })

      const openHistory = page
        .locator('.yolo-web-history-pane li.yolo-chat-list-dropdown-item')
        .first()
        .click({ noWaitAfter: true })
      await historyLoadStarted
      await newChatButton.click()
      releaseHistoryLoad()
      await openHistory

      await expect(emptyState).toBeVisible({ timeout: 5_000 })
    } finally {
      releaseHistoryLoad()
      await stopHarness(child)
    }
  })

  test('d: 重启 harness → 会话仍在（JSON 落盘）', async () => {
    const tmpdir =
      process.env.E2E_HARNESS_TMPDIR ??
      fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-web-e2e-persist-'))

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
      await expect(assistant.first()).toContainText(
        'Hello from the mock LLM!',
        { timeout: 30_000 },
      )
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
        page
          .locator('.yolo-chat-messages-user:has-text("hello harness")')
          .first(),
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        page
          .locator(
            '.yolo-chat-messages-assistant:has-text("Hello from the mock LLM!")',
          )
          .first(),
      ).toBeVisible({ timeout: 30_000 })
    } finally {
      await browser2.close()
      await stopHarness(second.child)
    }
  })

  test('e: 会话过滤（不同 agent 隔离）', async () => {
    test.skip(
      true,
      '装配复杂：需要第二个 workspace agent 的 share token 会话与不同 rootHash 会话；harness 目前只装配单 agent，见 e2e-report.md',
    )
  })

  test('f: ephemeral delegate 全链（子 run 完成 → 卡片完成态 + 父会话 subagent_result）', async ({
    page,
  }) => {
    const { child, ready } = startHarness()
    const info = await ready
    try {
      await loginAndWaitReady(page, info)

      // 父 mock 回合：delegate_subagent 工具调用 → 真实 callLocalFileTool →
      // runSubagent 派发纯 ephemeral 子 run → 续答文本。mock 的
      // isToolExecutionAllowed 要求显式允许（既有 harness 契约，场景 c
      // 同款）→ 先点审批按钮。
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
        assistant
          .filter({ hasText: 'Delegation accepted, task delegated!' })
          .first(),
      ).toBeVisible({ timeout: 45_000 })

      // 3) 子代理 mock 完成 → AgentService 结算注入父会话 → 卡片完成态
      await expect(
        page.locator('.yolo-subagent-card--success').first(),
      ).toBeVisible({ timeout: 45_000 })

      // 4) 父会话出现 subagent_result 消息：AgentService 在内存状态把子 run
      //    结算消息追加进父会话（web 客户端经 pending_background_task_results
      //    SSE → /api/agent/state 刷新渲染卡片完成态）。经生产路由断言：
      //    /api/chat/list 定位会话 → /api/agent/state 轮询 subagent_result。
      //    Web 会话绑定：从浏览器 localStorage 取 session id，作为
      //    x-yolo-web-session-id 头随 Node fetch 发出（路由级会话校验）。
      const webSessionId = await page.evaluate(() => {
        try {
          return localStorage.getItem('yolo-web-session-id')
        } catch {
          return null
        }
      })
      expect(typeof webSessionId).toBe('string')
      const chats = (await fetchJson(
        info.port,
        '/api/chat/list',
        webSessionId ?? undefined,
      )) as Array<{ id: string }>
      expect(chats.length).toBeGreaterThan(0)
      const conversationId = chats[0].id
      const state = await waitForAgentStateSubagentResult(
        info.port,
        conversationId,
        30_000,
        webSessionId ?? undefined,
      )
      const resultMessage = state.messages.find(
        (message: { role: string }) => message.role === 'subagent_result',
      )
      expect(resultMessage).toBeTruthy()
      expect(String(resultMessage.content)).toContain(
        'Delegated result: quarterly summary done',
      )
    } finally {
      await stopHarness(child)
    }
  })
})

/**
 * 经生产路由读 JSON。HTTP 层无需认证（harness 监听 127.0.0.1 loopback），
 * 但路由级 requireChatBinding/requireAgentBinding 校验 web 会话绑定——
 * 传浏览器 localStorage 里的 session id 作为 x-yolo-web-session-id 头。
 */
async function fetchJson(
  port: number,
  route: string,
  webSessionId?: string,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    headers: webSessionId
      ? { 'x-yolo-web-session-id': webSessionId }
      : undefined,
  })
  if (!response.ok) {
    throw new Error(
      `GET ${route} failed with status ${response.status}: ${await response
        .text()
        .catch(() => '')}`,
    )
  }
  return (await response.json()) as unknown
}

/**
 * 轮询父会话的 /api/agent/state，直到 subagent_result 结算消息被 AgentService
 * 追加进父会话（ephemeral 语义：结果经 backgroundTaskCompletionBus 注入内存
 * 状态，无落盘 session——由 SSE pending_background_task_results 通知客户端）。
 */
async function waitForAgentStateSubagentResult(
  port: number,
  conversationId: string,
  timeoutMs = 30_000,
  webSessionId?: string,
): Promise<{
  messages: Array<{ role: string; content?: string | null }>
}> {
  const deadline = Date.now() + timeoutMs
  let lastState: { messages: Array<{ role: string }> } = { messages: [] }
  while (Date.now() < deadline) {
    lastState = (await fetchJson(
      port,
      `/api/agent/state?conversationId=${encodeURIComponent(conversationId)}`,
      webSessionId,
    )) as { messages: Array<{ role: string }> }
    if (
      lastState.messages.some((message) => message.role === 'subagent_result')
    ) {
      return lastState as {
        messages: Array<{ role: string; content?: string | null }>
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    `timed out waiting for subagent_result in conversation ${conversationId}; ` +
      `last roles: ${JSON.stringify(lastState.messages.map((m) => m.role))}`,
  )
}

function startHarnessWithTmpdir(tmpdir: string): {
  child: ChildProcess
  ready: Promise<HarnessInfo>
} {
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
