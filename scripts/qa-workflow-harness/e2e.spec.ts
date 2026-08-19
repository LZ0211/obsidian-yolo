import { build } from 'esbuild'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const REPOSITORY_ROOT = path.resolve(__dirname, '../..')
const FIXTURE_ENTRY = path.join(__dirname, 'fixture.tsx')

let server: Server | undefined
let temporaryDirectory: string | undefined
let baseUrl = ''

test.beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'yolo-workflow-e2e-'),
  )
  const bundlePath = path.join(temporaryDirectory, 'workflow.js')
  await build({
    absWorkingDir: REPOSITORY_ROOT,
    entryPoints: [FIXTURE_ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: bundlePath,
    logLevel: 'silent',
  })
  const [bundle, stylesheet] = await Promise.all([
    readFile(bundlePath),
    readFile(path.join(REPOSITORY_ROOT, 'modules/workflow/src/style.css')),
  ])
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Workflow Studio E2E</title>
    <style>
      :root { --background-primary: #ffffff; --background-secondary: #f4f5f7; --background-secondary-alt: #e9ebef; --background-modifier-border: #d8dce3; --text-normal: #20242b; --text-muted: #667085; --interactive-accent: #6750a4; --color-green: #2f9e44; --color-orange: #e67700; --color-red: #d94841; }
      * { box-sizing: border-box; }
      html, body, #root { width: 100%; height: 100%; margin: 0; }
      body { overflow: hidden; font-family: system-ui, sans-serif; }
    </style>
    <style>${stylesheet.toString()}</style>
    <script>
      window.__workflowModuleDefinition = null;
      window.yolo = {
        registerModule(moduleDefinition) {
          window.__workflowModuleDefinition = moduleDefinition;
        }
      };
    </script>
  </head>
  <body><div id="root"></div><script src="/workflow.js"></script></body>
</html>`
  server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (requestPath === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    if (requestPath === '/workflow.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end(bundle)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server failed')
  baseUrl = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve()
      return
    }
    server.close((error) => (error ? reject(error) : resolve()))
  })
  if (temporaryDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true })
})

test('runs the registered workflow module from edit to persisted assistant review', async ({
  page,
}) => {
  const pageErrors: string[] = []
  const consoleIssues: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      consoleIssues.push(`${message.type()}: ${message.text()}`)
  })
  await page.goto(baseUrl)
  await page.waitForTimeout(250)
  if (pageErrors.length > 0) throw new Error(pageErrors.join('\n'))

  expect(await page.title()).toBe('Workflow Studio E2E')
  expect(await page.url()).toBe(`${baseUrl}/`)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  await expect(page.locator('body')).toContainText('Workflow Studio')
  await expect(
    page.locator('style[data-yolo-workflow-style="true"]'),
  ).toHaveCount(1)
  expect(
    await page.locator('style[data-yolo-workflow-style="true"]').textContent(),
  ).toContain('.yolo-workflow-studio')
  const stepNumberGeometry = await page
    .locator('.yolo-workflow-rail__step')
    .evaluateAll((steps) =>
      steps.map((step) => {
        const number = step.querySelector<HTMLElement>(
          '.yolo-workflow-rail__step-number',
        )
        if (!number) throw new Error('workflow step number is missing')
        const stepBox = step.getBoundingClientRect()
        const numberBox = number.getBoundingClientRect()
        const computed = getComputedStyle(step)
        const contentLeft =
          stepBox.left +
          Number.parseFloat(computed.borderLeftWidth) +
          Number.parseFloat(computed.paddingLeft)
        const firstTrackWidth = Number.parseFloat(
          computed.gridTemplateColumns.split(' ')[0] ?? '0',
        )
        return Math.abs(
          numberBox.left +
            numberBox.width / 2 -
            (contentLeft + firstTrackWidth / 2),
        )
      }),
    )
  expect(stepNumberGeometry).toEqual([0, 0, 0])
  expect(
    await page
      .locator('.vite-error-overlay, .webpack-dev-server-client-overlay')
      .count(),
  ).toBe(0)
  await expect(
    page.getByRole('button', { name: 'Optimize doc', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Optimize doc', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Accept', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()

  const apply = page.locator('button[aria-label="Apply changes"]')
  await expect(apply).toBeEnabled()
  await apply.click()
  await page.waitForTimeout(250)
  if (pageErrors.length > 0) throw new Error(pageErrors.join('\n'))
  await expect(apply).toBeDisabled()
  await expect(page.locator('.yolo-workflow-canvas-toolbar__sync')).toHaveText(
    'Markdown synced',
  )
  await expect
    .poll(() => page.evaluate(() => window.__workflowE2E?.readManifest()))
    .toContain('Reviewed by browser harness.')
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
  await page.screenshot({
    path: path.join(os.tmpdir(), 'yolo-workflow-e2e.png'),
    fullPage: false,
  })
})

test('keeps compact workflow panels mutually exclusive', async ({ page }) => {
  const consoleIssues: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      consoleIssues.push(`${message.type()}: ${message.text()}`)
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  await expect(page.locator('.yolo-workflow-rail')).toHaveCount(0)
  await expect(page.locator('.yolo-workflow-inspector')).toHaveCount(0)

  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(page.locator('.yolo-workflow-rail')).toBeVisible()
  await page
    .getByRole('button', { name: 'Node properties', exact: true })
    .click()
  await expect(page.locator('.yolo-workflow-rail')).toHaveCount(0)
  await expect(page.locator('.yolo-workflow-inspector')).toBeVisible()
  expect(consoleIssues).toEqual([])
  await page.screenshot({
    path: path.join(os.tmpdir(), 'yolo-workflow-e2e-mobile.png'),
    fullPage: false,
  })
})

test('keeps desktop grid regions aligned when panels close', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(page.locator('.yolo-workflow-rail')).toHaveCount(0)
  assertAligned(await readLayout(page), 'rail closed')

  await page
    .getByRole('button', { name: 'Node properties', exact: true })
    .click()
  await expect(page.locator('.yolo-workflow-inspector')).toHaveCount(0)
  assertAligned(await readLayout(page), 'both panels closed')
})

test('responds to workflow file toolbar actions', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  await page
    .locator('.yolo-workflow-canvas-toolbar button[aria-label="New workflow"]')
    .click()
  const createInput = page.getByRole('textbox', { name: 'New workflow' })
  await expect(createInput).toBeVisible()
  await createInput.fill('Alpha Flow')
  await createInput.press('Enter')

  const workflowSelect = page.locator('select[aria-label="Open workflow"]')
  await expect(workflowSelect).toHaveValue('Alpha-Flow/WORKFLOW.md')
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__workflowE2E?.hasFile('workflows/Alpha-Flow/WORKFLOW.md'),
      ),
    )
    .toBe(true)

  const downloadPromise = page.waitForEvent('download')
  await page
    .locator('.yolo-workflow-canvas-toolbar button[aria-label="Export JSON"]')
    .click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.json$/)

  await page
    .locator(
      '.yolo-workflow-canvas-toolbar button[aria-label="Delete workflow"]',
    )
    .click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__workflowE2E?.hasFile('workflows/Alpha-Flow/WORKFLOW.md'),
      ),
    )
    .toBe(false)
  await expect(workflowSelect).toHaveValue('demo/WORKFLOW.md')

  const importPayload = {
    name: 'Imported Flow',
    workflowContent: '# Imported Flow\n',
    docs: {
      input: 'steps/input/STEP.md',
      output: 'steps/output/STEP.md',
    },
    nodes: [
      {
        id: 'input',
        kind: 'input',
        position: { x: 80, y: 100 },
        data: { label: 'Input' },
      },
      {
        id: 'output',
        kind: 'output',
        position: { x: 420, y: 100 },
        data: { label: 'Output' },
      },
    ],
    edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    stepContents: {
      input: '# Imported input\n',
      output: '# Imported output\n',
    },
  }
  await page.locator('input[type="file"]').setInputFiles({
    name: 'import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importPayload)),
  })
  await expect(workflowSelect).toHaveValue('Imported-Flow/WORKFLOW.md')
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__workflowE2E?.hasFile('workflows/Imported-Flow/WORKFLOW.md'),
      ),
    )
    .toBe(true)
  await expect(
    page.locator('[data-yolo-workflow-node="output"]'),
  ).toContainText('Output')
})

test('responds to assistant instruction, rejection and cancellation', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  const instruction = page.getByRole('textbox', { name: 'Instruction' })
  await instruction.fill('Keep the workflow concise.')
  await expect(instruction).toHaveValue('Keep the workflow concise.')

  await page.getByRole('button', { name: 'Optimize doc', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Accept', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Proposal', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.locator('button[aria-label="Apply changes"]'),
  ).toBeDisabled()

  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.holdAssistant = true
  })
  await page
    .getByRole('button', { name: 'Optimize workflow', exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => window.__workflowE2E?.assistantStarted()))
    .toBe(true)
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeVisible()
  await cancel.click()
  await expect(cancel).toHaveCount(0)
  await expect(
    page.locator('.yolo-workflow-assistant__proposal-empty'),
  ).toContainText('No proposal yet')
})

test('keeps node and markdown controls synchronized after clicks', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  await page.locator('[data-yolo-workflow-node="input"]').click()
  await expect(page.locator('.yolo-workflow-node-inspector strong')).toHaveText(
    'Input',
  )

  const labelInput = page.locator('.yolo-workflow-node-inspector input').nth(1)
  await labelInput.fill('Input renamed')
  await expect(
    page.locator(
      '[data-yolo-workflow-node="input"] .yolo-workflow-graph__node-label',
    ),
  ).toHaveText('Input renamed')
  const undo = page.locator(
    '.yolo-workflow-canvas-toolbar button[aria-label="Undo"]',
  )
  const redo = page.locator(
    '.yolo-workflow-canvas-toolbar button[aria-label="Redo"]',
  )
  await expect(undo).toBeEnabled()
  await undo.click()
  await expect(
    page.locator(
      '[data-yolo-workflow-node="input"] .yolo-workflow-graph__node-label',
    ),
  ).toHaveText('Input')
  await redo.click()
  await expect(
    page.locator(
      '[data-yolo-workflow-node="input"] .yolo-workflow-graph__node-label',
    ),
  ).toHaveText('Input renamed')

  await page.locator('[data-yolo-workflow-node="agent"]').click()
  await page.locator('.yolo-workflow-markdown-tabs button').nth(1).click()
  await expect(page.locator('.yolo-workflow-markdown-meta small')).toHaveText(
    'demo/steps/agent/STEP.md',
  )
  const markdown = page.getByRole('textbox', { name: 'Markdown content' })
  await markdown.fill('# Agent draft\n')
  await page
    .locator('.yolo-workflow-markdown-actions')
    .getByRole('button', { name: 'Save', exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__workflowE2E?.readFile('workflows/demo/steps/agent/STEP.md'),
      ),
    )
    .toBe('# Agent draft\n')
  await page
    .locator('.yolo-workflow-markdown-actions')
    .getByRole('button', { name: 'Open workflow', exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => window.__workflowE2E?.getOpenFile()))
    .toBe('workflows/demo/steps/agent/STEP.md')

  await page
    .locator('.yolo-workflow-add-node-bar button[aria-label="Add node: Agent"]')
    .click()
  const addedNode = page.locator('[data-yolo-workflow-node="agent-1"]')
  await expect(addedNode).toBeVisible()
  await page.locator('.yolo-workflow-markdown-tabs button').nth(1).click()
  await expect(page.locator('.yolo-workflow-markdown-meta small')).toHaveText(
    'demo/steps/agent-1/STEP.md',
  )
  await page.getByRole('button', { name: 'Delete node', exact: true }).click()
  await expect(addedNode).toHaveCount(0)
  await expect(page.locator('.yolo-workflow-markdown-meta small')).toHaveText(
    'demo/WORKFLOW.md',
  )
  await expect(
    page.locator('.yolo-workflow-markdown-tabs button').first(),
  ).toHaveClass(/is-active/)
})

test('responds to graph selection, reconnect, delete, zoom and drag', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  const edgeHitbox = page.locator('.yolo-workflow-graph__edge-hitbox').first()
  const edgeBox = await edgeHitbox.boundingBox()
  expect(edgeBox).not.toBeNull()
  if (edgeBox)
    await page.mouse.click(
      edgeBox.x + edgeBox.width / 2,
      edgeBox.y + edgeBox.height / 2,
    )
  await expect(page.locator('.yolo-workflow-edge-inspector')).toBeVisible()

  const targetSelect = page
    .locator('.yolo-workflow-edge-inspector select')
    .nth(1)
  await targetSelect.selectOption('output')
  await expect(targetSelect).toHaveValue('output')
  await page
    .locator('.yolo-workflow-edge-inspector')
    .getByRole('button', { name: 'Delete connection', exact: true })
    .click()
  await expect(page.locator('.yolo-workflow-edge-inspector')).toHaveCount(0)
  await expect(page.locator('.yolo-workflow-graph__edge')).toHaveCount(1)

  const world = page.locator('.yolo-workflow-graph__world')
  const initialTransform = await world.getAttribute('style')
  await page
    .locator('.yolo-workflow-graph__controls button[aria-label="Zoom in"]')
    .click()
  await expect(world).not.toHaveAttribute('style', initialTransform ?? '')

  const inputNode = page.locator('[data-yolo-workflow-node="input"]')
  const beforeLeft = await inputNode.evaluate((element) => element.style.left)
  const box = await inputNode.boundingBox()
  expect(box).not.toBeNull()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      box.x + box.width / 2 + 38,
      box.y + box.height / 2 + 24,
    )
    await page.mouse.up()
  }
  await expect
    .poll(() => inputNode.evaluate((element) => element.style.left))
    .not.toBe(beforeLeft)
})

test('responds to connection handles, errors and branch selection', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  const inputSource = page.locator(
    '[data-yolo-workflow-node="input"] .yolo-workflow-graph__handle--source',
  )
  const agentTarget = page.locator(
    '[data-yolo-workflow-node="agent"] .yolo-workflow-graph__handle--target',
  )
  const outputTarget = page.locator(
    '[data-yolo-workflow-node="output"] .yolo-workflow-graph__handle--target',
  )

  await inputSource.dragTo(outputTarget)
  await expect(page.locator('.yolo-workflow-graph__edge')).toHaveCount(3)

  await inputSource.dragTo(agentTarget)
  await expect(page.locator('.yolo-workflow-canvas-message')).toContainText(
    'already connected',
  )
  await page
    .locator('.yolo-workflow-canvas-message button[aria-label="Cancel"]')
    .click()
  await expect(page.locator('.yolo-workflow-canvas-message')).toHaveCount(0)

  await page
    .locator(
      '.yolo-workflow-add-node-bar button[aria-label="Add node: Condition"]',
    )
    .click()
  const conditionSource = page.locator(
    '[data-yolo-workflow-node="condition-1"] .yolo-workflow-graph__handle--source',
  )
  await expect(conditionSource).toBeVisible()
  await conditionSource.dragTo(outputTarget)
  const branchPicker = page.locator('.yolo-workflow-branch-picker')
  await expect(branchPicker).toBeVisible()
  await branchPicker.getByRole('button', { name: 'True', exact: true }).click()
  await expect(page.locator('.yolo-workflow-graph__edge')).toHaveCount(4)
})

test('keeps every desktop canvas toolbar action reachable', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  const layout = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>(
      '.yolo-workflow-canvas-toolbar',
    )
    const shell = document.querySelector<HTMLElement>(
      '.yolo-workflow-canvas-shell',
    )
    if (!toolbar || !shell) throw new Error('workflow toolbar is missing')
    const shellRect = shell.getBoundingClientRect()
    return {
      toolbar: {
        clientWidth: toolbar.clientWidth,
        scrollWidth: toolbar.scrollWidth,
        overflowX: getComputedStyle(toolbar).overflowX,
      },
      buttons: [...toolbar.querySelectorAll<HTMLButtonElement>('button')].map(
        (button) => {
          const rect = button.getBoundingClientRect()
          return {
            label: button.getAttribute('aria-label'),
            left: rect.left,
            right: rect.right,
            shellLeft: shellRect.left,
            shellRight: shellRect.right,
          }
        },
      ),
    }
  })

  expect(layout.buttons).not.toHaveLength(0)
  for (const button of layout.buttons)
    expect(
      button.right <= button.shellRight + 1 ||
        (layout.toolbar.scrollWidth > layout.toolbar.clientWidth &&
          ['auto', 'scroll'].includes(layout.toolbar.overflowX)),
      `${button.label} is clipped without a scrollable toolbar`,
    ).toBe(true)
})

const DEMO_WORKFLOW_PATH = 'demo/WORKFLOW.md'
const DEMO_RUN_ACTIVITY_ID = `workflow:run:${DEMO_WORKFLOW_PATH}`

test('switches between the Assistant and Run studio tabs', async ({ page }) => {
  const consoleIssues: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      consoleIssues.push(`${message.type()}: ${message.text()}`)
  })
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  const assistantTab = page.getByRole('tab', { name: 'Assistant', exact: true })
  const runTab = page.getByRole('tab', { name: 'Run', exact: true })
  await expect(assistantTab).toBeVisible()
  await expect(runTab).toBeVisible()
  await expect(assistantTab).toHaveClass(/is-active/)
  await expect(page.locator('.yolo-workflow-assistant')).toBeVisible()

  await runTab.click()
  await expect(runTab).toHaveClass(/is-active/)
  await expect(page.locator('.yolo-workflow-run-panel')).toBeVisible()
  await expect(page.locator('.yolo-workflow-run-panel')).toContainText(
    'No output yet',
  )

  await assistantTab.click()
  await expect(assistantTab).toHaveClass(/is-active/)
  await expect(page.locator('.yolo-workflow-assistant')).toBeVisible()
  expect(consoleIssues).toEqual([])
})

test('parses run input as JSON or plain text', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()

  const input = page.getByRole('textbox', { name: 'Run input' })
  const runButton = page
    .locator('.yolo-workflow-run-panel')
    .getByRole('button', { name: 'Run', exact: true })

  await input.fill('{"a": 1}')
  await runButton.click()
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (await window.__workflowE2E?.readRunFile(workflowPath)) as {
            status?: string
            input?: unknown
          } | null,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toEqual(expect.objectContaining({ status: 'succeeded', input: { a: 1 } }))

  await input.fill('plain run text')
  await runButton.click()
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (
            (await window.__workflowE2E?.readRunFile(workflowPath)) as {
              input?: unknown
            } | null
          )?.input,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toBe('plain run text')
  // The detail preview shows the parsed string form of the plain-text input.
  await expect(page.locator('.yolo-workflow-run-preview')).toContainText(
    'plain run text',
  )
})

test('runs a workflow end to end and persists the run record', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()

  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.holdRun = true
  })
  await page
    .getByRole('textbox', { name: 'Run input' })
    .fill('{"question": "life"}')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Running',
  )
  // The background activity is present while the run is active.
  await expect
    .poll(() =>
      page.evaluate(() => window.__workflowE2E?.backgroundActivities() ?? []),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: DEMO_RUN_ACTIVITY_ID }),
      ]),
    )

  await page.evaluate(() => window.__workflowE2E?.releaseRun())
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Succeeded',
  )
  await expect(page.locator('.yolo-workflow-run-status__progress')).toHaveText(
    '3/3',
  )
  // The output area shows the run outputs with the submitted agent value.
  await expect(page.locator('.yolo-workflow-run-output__value')).toContainText(
    '"ok"',
  )
  // The run record is persisted with the submitted value and input.
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (await window.__workflowE2E?.readRunFile(workflowPath)) as {
            status?: string
            input?: unknown
            outputs?: unknown
          } | null,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toEqual(
      expect.objectContaining({
        status: 'succeeded',
        input: { question: 'life' },
        outputs: { output: { ok: true } },
      }),
    )
  // The background activity is removed once the run finishes.
  await expect
    .poll(() =>
      page.evaluate(() => window.__workflowE2E?.backgroundActivities() ?? []),
    )
    .toEqual([])
  expect(pageErrors).toEqual([])
})

test('stops a running workflow', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()

  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.holdRun = true
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('stop me')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  await runPanel.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'cancelled',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Cancelled',
  )
  await expect
    .poll(() =>
      page.evaluate(() => window.__workflowE2E?.backgroundActivities() ?? []),
    )
    .toEqual([])
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (
            (await window.__workflowE2E?.readRunFile(workflowPath)) as {
              status?: string
            } | null
          )?.status,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toBe('cancelled')
})

test('continues a failed run from the failed node after confirmation', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()

  await page.evaluate(() => {
    const e2e = window.__workflowE2E
    if (!e2e) return
    e2e.failRun = true
    e2e.runErrorMessage = 'Simulated step failure'
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('retry me')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'failed',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Failed',
  )
  const agentNode = page.locator('.yolo-workflow-run-node', {
    hasText: 'Agent',
  })
  await expect(agentNode.locator('.yolo-workflow-run-node__badge')).toHaveClass(
    /badge--failed/,
  )
  await page.getByRole('tab', { name: 'Error', exact: true }).click()
  await expect(page.locator('.yolo-workflow-run-error')).toContainText(
    'Simulated step failure',
  )
  expect(
    await page.evaluate(() => window.__workflowE2E?.confirmCalls() ?? []),
  ).toEqual([])

  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.failRun = false
  })
  await runPanel.getByRole('button', { name: 'Continue', exact: true }).click()
  // Continuing asks for side-effect confirmation first.
  await expect
    .poll(() => page.evaluate(() => window.__workflowE2E?.confirmCalls() ?? []))
    .toContainEqual(
      expect.objectContaining({
        title: 'Continue',
        message:
          'Continuing resumes the workflow from the first unfinished step; that step may re-apply side effects at least once.',
      }),
    )
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Succeeded',
  )
  // The previously failed node was reset and re-executed.
  await expect(agentNode.locator('.yolo-workflow-run-node__badge')).toHaveClass(
    /badge--succeeded/,
  )
})

test('tests a single node and hides the test button during full runs', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()

  // A full run first, so a persisted record exists for the test path.
  await page.getByRole('textbox', { name: 'Run input' }).fill('seed run')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )

  // Select the agent node and test it with a controlled submitted value.
  await page.locator('.yolo-workflow-run-node', { hasText: 'Agent' }).click()
  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.runOutput = { ok: false }
  })
  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  await runPanel.getByRole('button', { name: 'Test node', exact: true }).click()
  await expect(page.locator('.yolo-workflow-run-preview')).toContainText(
    '"ok": false',
  )

  // The test button disappears while a full run is active and returns after.
  await page.evaluate(() => {
    const e2e = window.__workflowE2E
    if (!e2e) return
    e2e.holdRun = true
    e2e.runOutput = { ok: true }
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('second run')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  await expect(
    runPanel.getByRole('button', { name: 'Test node', exact: true }),
  ).toHaveCount(0)
  await page.evaluate(() => window.__workflowE2E?.releaseRun())
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect(
    runPanel.getByRole('button', { name: 'Test node', exact: true }),
  ).toBeVisible()
})

test('locks editing controls while a run is active', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()

  const addNodeButton = page
    .locator('.yolo-workflow-add-node-bar button')
    .first()
  await expect(addNodeButton).toBeEnabled()
  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.holdRun = true
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('lock me')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  await expect(addNodeButton).toBeDisabled()
  await expect(
    runPanel.getByRole('button', { name: 'Run', exact: true }),
  ).toBeDisabled()

  await page.evaluate(() => window.__workflowE2E?.releaseRun())
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect(addNodeButton).toBeEnabled()
})

test('recovers a persisted running run as interrupted after reload', async ({
  page,
}) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  await page.evaluate((workflowPath) => {
    window.__workflowE2E?.seedRun(workflowPath, {
      status: 'running',
      nodes: {
        input: { status: 'succeeded', output: 'seeded' },
        agent: { status: 'running' },
        output: { status: 'pending' },
      },
    })
  }, DEMO_WORKFLOW_PATH)

  await page.reload()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'interrupted',
  )
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Interrupted',
  )
  const continueButton = page
    .locator('.yolo-workflow-run-panel')
    .getByRole('button', { name: 'Continue', exact: true })
  await expect(continueButton).toBeVisible()
  // The recovered run shows as a reminder in the background.
  await expect
    .poll(() =>
      page.evaluate(() => window.__workflowE2E?.backgroundActivities() ?? []),
    )
    .toEqual([
      expect.objectContaining({
        id: DEMO_RUN_ACTIVITY_ID,
        status: 'reminder',
      }),
    ])
  // The interrupted status is persisted back over the running record.
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (
            (await window.__workflowE2E?.readRunFile(workflowPath)) as {
              status?: string
            } | null
          )?.status,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toBe('interrupted')

  // Continuing the recovered run finishes it.
  await continueButton.click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
})

test('uses the selected run model for agent requests', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()

  const modelSelect = runPanel.getByRole('combobox', {
    name: 'Run model',
    exact: true,
  })
  await expect(modelSelect).toHaveValue('browser-model')
  await modelSelect.selectOption('deepseek-model')
  await page.getByRole('textbox', { name: 'Run input' }).fill('model check')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect
    .poll(() => page.evaluate(() => window.__workflowE2E?.lastAgentRequest()))
    .toEqual(expect.objectContaining({ modelId: 'deepseek-model' }))
})

test('shows the failing agent error in the Error tab', async ({ page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()

  await page.evaluate(() => {
    const e2e = window.__workflowE2E
    if (!e2e) return
    e2e.failRun = true
    e2e.runErrorMessage = 'Broken step'
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('fail me')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'failed',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Failed',
  )
  await expect(page.locator('.yolo-workflow-run-status__error')).toContainText(
    'Broken step',
  )
  await page.getByRole('tab', { name: 'Error', exact: true }).click()
  await expect(page.locator('.yolo-workflow-run-error')).toContainText(
    'Broken step',
  )
})

test('pauses an in-memory run and resumes it without confirmation', async ({
  page,
}) => {
  const { pageErrors, consoleIssues } = trackPageIssues(page)
  const runPanel = await openRunStudio(page)

  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.holdRun = true
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('pause me')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Running',
  )

  const pause = runPanel.getByRole('button', { name: 'Pause', exact: true })
  await expect(pause).toBeVisible()
  await pause.click()
  // The run stays running but the badge flips to Paused; Resume and Stop
  // replace Pause while it is parked.
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Paused',
  )
  await expect(
    runPanel.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeVisible()
  await expect(
    runPanel.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible()
  await expect(pause).toHaveCount(0)
  // The mid-flight agent node stays running and the downstream node pending.
  const agentNode = page.locator('.yolo-workflow-run-node', {
    hasText: 'Agent',
  })
  const outputNode = page.locator('.yolo-workflow-run-node', {
    hasText: 'Output',
  })
  await expect(agentNode.locator('.yolo-workflow-run-node__badge')).toHaveClass(
    /badge--running/,
  )
  await expect(
    outputNode.locator('.yolo-workflow-run-node__badge'),
  ).toHaveClass(/badge--pending/)

  // Releasing the held agent call parks the run at the next node boundary: the
  // downstream node stays pending while the run is paused.
  await page.evaluate(() => window.__workflowE2E?.releaseRun())
  await expect(
    outputNode.locator('.yolo-workflow-run-node__badge'),
  ).toHaveClass(/badge--pending/)
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Paused',
  )

  // In-memory resume needs no confirmation: the same ActiveRun continues.
  await runPanel.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Succeeded',
  )
  await expect(page.locator('.yolo-workflow-run-status__progress')).toHaveText(
    '3/3',
  )
  expect(
    await page.evaluate(() => window.__workflowE2E?.confirmCalls() ?? []),
  ).toEqual([])
  // The terminal record clears paused.
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (
            (await window.__workflowE2E?.readRunFile(workflowPath)) as {
              status?: string
            } | null
          )?.status,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toBe('succeeded')
  expect(
    await page.evaluate(
      async (workflowPath) =>
        (
          (await window.__workflowE2E?.readRunFile(workflowPath)) as {
            paused?: boolean
          } | null
        )?.paused,
      DEMO_WORKFLOW_PATH,
    ),
  ).toBeUndefined()
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
})

test('recovers a paused run and resumes it after side-effect confirmation', async ({
  page,
}) => {
  const { pageErrors, consoleIssues } = trackPageIssues(page)
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()

  // A running+paused record with a mid-flight agent node and usage that must
  // survive the reload's store validation.
  await page.evaluate((workflowPath) => {
    window.__workflowE2E?.seedRun(workflowPath, {
      status: 'running',
      paused: true,
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      nodes: {
        // The completed input node keeps its output like a real persisted
        // record, so the resumed agent has an active upstream source.
        input: {
          status: 'succeeded',
          output: { ok: true },
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        },
        agent: { status: 'running' },
        output: { status: 'pending' },
      },
    })
  }, DEMO_WORKFLOW_PATH)

  await page.reload()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Paused',
  )
  const resume = runPanel.getByRole('button', { name: 'Resume', exact: true })
  await expect(resume).toBeVisible()
  await expect(
    runPanel.getByRole('button', { name: 'Pause', exact: true }),
  ).toHaveCount(0)
  // The recovered paused run shows as a waiting reminder in the background.
  await expect
    .poll(() =>
      page.evaluate(() => window.__workflowE2E?.backgroundActivities() ?? []),
    )
    .toEqual([
      expect.objectContaining({ id: DEMO_RUN_ACTIVITY_ID, status: 'waiting' }),
    ])
  // The seeded usage survives the reload.
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (
            (await window.__workflowE2E?.readRunFile(workflowPath)) as {
              usage?: unknown
            } | null
          )?.usage,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })

  // A recovered pause has no ActiveRun, so resuming asks for the side-effect
  // confirmation before rebuilding the run.
  await resume.click()
  await expect
    .poll(() => page.evaluate(() => window.__workflowE2E?.confirmCalls() ?? []))
    .toContainEqual(
      expect.objectContaining({
        title: 'Continue',
        message:
          'Continuing resumes the workflow from the first unfinished step; that step may re-apply side effects at least once.',
      }),
    )
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Succeeded',
  )
  // The final record keeps the seeded input-node usage and adds the resumed
  // agent round: 3/1/4 + 10/5/15 = 13/6/19.
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (await window.__workflowE2E?.readRunFile(workflowPath)) as {
            status?: string
            usage?: unknown
            nodes?: Record<string, { usage?: unknown }>
          } | null,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toEqual(
      expect.objectContaining({
        status: 'succeeded',
        usage: { inputTokens: 13, outputTokens: 6, totalTokens: 19 },
        nodes: expect.objectContaining({
          input: expect.objectContaining({
            usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
          }),
          agent: expect.objectContaining({
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }),
        }),
      }),
    )
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
})

test('renames a workflow and migrates its persisted run record', async ({
  page,
}) => {
  const { pageErrors, consoleIssues } = trackPageIssues(page)
  const runPanel = await openRunStudio(page)
  const workflowSelect = page.locator('select[aria-label="Open workflow"]')
  const renameButton = page.locator(
    '.yolo-workflow-canvas-toolbar button[aria-label="Rename workflow"]',
  )

  // A run record exists for the demo path before the rename.
  await page.getByRole('textbox', { name: 'Run input' }).fill('pre-rename run')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )

  await renameButton.click()
  const renameInput = page.getByRole('textbox', { name: 'Rename workflow' })
  await expect(renameInput).toBeVisible()
  await renameInput.fill('Renamed Flow')
  await renameInput.press('Enter')

  // The new path is listed and the old one is gone; the folder subtree moved.
  await expect(workflowSelect).toHaveValue('Renamed-Flow/WORKFLOW.md')
  await expect
    .poll(() =>
      page.evaluate(() => ({
        renamed: window.__workflowE2E?.hasFile(
          'workflows/Renamed-Flow/WORKFLOW.md',
        ),
        old: window.__workflowE2E?.hasFile('workflows/demo/WORKFLOW.md'),
        step: window.__workflowE2E?.hasFile(
          'workflows/Renamed-Flow/steps/agent/STEP.md',
        ),
      })),
    )
    .toEqual({ renamed: true, old: false, step: true })

  // The persisted run record migrated to the new path's key; the old key is
  // gone.
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (await window.__workflowE2E?.readRunFile(workflowPath)) as {
            workflowPath?: string
            status?: string
          } | null,
        'Renamed-Flow/WORKFLOW.md',
      ),
    )
    .toEqual(
      expect.objectContaining({
        workflowPath: 'Renamed-Flow/WORKFLOW.md',
        status: 'succeeded',
      }),
    )
  expect(
    await page.evaluate(
      async () =>
        (await window.__workflowE2E?.readRunFile('demo/WORKFLOW.md')) ?? null,
    ),
  ).toBeNull()

  // The frozen definition keeps running under the renamed path, and the
  // background activity is re-keyed to the new path.
  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.holdRun = true
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('post-rename run')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  await expect
    .poll(() =>
      page.evaluate(() => window.__workflowE2E?.backgroundActivities() ?? []),
    )
    .toContainEqual(
      expect.objectContaining({
        id: 'workflow:run:Renamed-Flow/WORKFLOW.md',
      }),
    )
  expect(
    await page.evaluate(
      () =>
        window.__workflowE2E?.backgroundActivities() ??
        ([] as readonly {
          id: string
        }[]),
    ),
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: DEMO_RUN_ACTIVITY_ID }),
    ]),
  )
  await page.evaluate(() => window.__workflowE2E?.releaseRun())
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            (await window.__workflowE2E?.readRunFile(
              'Renamed-Flow/WORKFLOW.md',
            )) as { input?: unknown } | null
          )?.input,
      ),
    )
    .toBe('post-rename run')
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
})

test('gates rename while a run is active or the editor is dirty', async ({
  page,
}) => {
  const runPanel = await openRunStudio(page)
  const renameButton = page.locator(
    '.yolo-workflow-canvas-toolbar button[aria-label="Rename workflow"]',
  )
  await expect(renameButton).toBeEnabled()

  // A running snapshot disables rename.
  await page.evaluate(() => {
    if (window.__workflowE2E) window.__workflowE2E.holdRun = true
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('gate rename')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  await expect(renameButton).toBeDisabled()
  await expect(renameButton).toHaveAttribute(
    'title',
    'Stop or finish the run before renaming.',
  )
  await page.evaluate(() => window.__workflowE2E?.releaseRun())
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect(renameButton).toBeEnabled()

  // Dirty edits disable rename until applied.
  await page.locator('[data-yolo-workflow-node="input"]').click()
  await page
    .locator('.yolo-workflow-node-inspector input')
    .nth(1)
    .fill('Input renamed')
  await expect(renameButton).toBeDisabled()
  await expect(renameButton).toHaveAttribute(
    'title',
    'Save or discard the current edits before renaming.',
  )
})

test('repairs a rejected agent submission and sums usage across rounds', async ({
  page,
}) => {
  const { pageErrors, consoleIssues } = trackPageIssues(page)
  const runPanel = await openRunStudio(page)

  await page.evaluate(() => {
    const e2e = window.__workflowE2E
    if (!e2e) return
    e2e.setRunScript([
      { rejectValue: { ok: 'not-a-boolean' } },
      { acceptValue: { ok: true } },
    ])
    e2e.holdRun = true
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('repair me')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'running',
  )
  // Round 1 is rejected; the repair round starts and parks at the agent call,
  // with the background activity carrying the repairing detail.
  await page.evaluate(() => window.__workflowE2E?.releaseRun())
  await expect
    .poll(() =>
      page.evaluate(() => window.__workflowE2E?.backgroundActivities() ?? []),
    )
    .toContainEqual(
      expect.objectContaining({
        id: DEMO_RUN_ACTIVITY_ID,
        detail: 'Repairing output…',
      }),
    )

  // Round 2 accepts the corrected value and the run succeeds.
  await page.evaluate(() => window.__workflowE2E?.releaseRun())
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Succeeded',
  )
  await expect(page.locator('.yolo-workflow-run-output__value')).toContainText(
    '"ok": true',
  )

  // The repair round ran with the rejection feedback in its prompt.
  const secondRequest = await page.evaluate(() =>
    window.__workflowE2E?.lastAgentRequest(),
  )
  expect(secondRequest?.prompt).toContain(
    'Your previous submission was rejected because it does not satisfy the node output schema',
  )
  expect(secondRequest?.prompt).toContain(
    'Rejected value: {"ok":"not-a-boolean"}',
  )
  expect(secondRequest?.prompt).toContain(
    'Schema errors: /value/ok must be boolean',
  )

  // The final record sums both rounds' usage: 10/5/15 per round.
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (await window.__workflowE2E?.readRunFile(workflowPath)) as {
            status?: string
            usage?: unknown
            nodes?: Record<string, { usage?: unknown }>
          } | null,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toEqual(
      expect.objectContaining({
        status: 'succeeded',
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        nodes: expect.objectContaining({
          agent: expect.objectContaining({
            usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          }),
        }),
      }),
    )
  // The run activity is removed once the repaired run finishes.
  await expect
    .poll(() =>
      page.evaluate(() => window.__workflowE2E?.backgroundActivities() ?? []),
    )
    .toEqual([])
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
})

test('fails the run when the repair round is rejected too', async ({
  page,
}) => {
  const { pageErrors, consoleIssues } = trackPageIssues(page)
  const runPanel = await openRunStudio(page)

  await page.evaluate(() => {
    window.__workflowE2E?.setRunScript([
      { rejectValue: { ok: 'not-a-boolean' } },
      { rejectValue: { ok: 'still-not-a-boolean' } },
    ])
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('fail repair')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'failed',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Failed',
  )
  const agentNode = page.locator('.yolo-workflow-run-node', {
    hasText: 'Agent',
  })
  await expect(agentNode.locator('.yolo-workflow-run-node__badge')).toHaveClass(
    /badge--failed/,
  )

  // The Error tab carries the round-1 Ajv rejection and the value preview.
  await page.getByRole('tab', { name: 'Error', exact: true }).click()
  await expect(page.locator('.yolo-workflow-run-error')).toContainText(
    'Agent output rejected twice',
  )
  await expect(page.locator('.yolo-workflow-run-error')).toContainText(
    '/value/ok must be boolean',
  )
  await expect(page.locator('.yolo-workflow-run-error')).toContainText(
    '{"ok":"not-a-boolean"}',
  )

  // The persisted record carries the agent-failed code on the run and node.
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (await window.__workflowE2E?.readRunFile(workflowPath)) as {
            status?: string
            error?: { code?: string }
            nodes?: Record<string, { error?: { code?: string } }>
          } | null,
        DEMO_WORKFLOW_PATH,
      ),
    )
    .toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'agent-failed' }),
        nodes: expect.objectContaining({
          agent: expect.objectContaining({
            error: expect.objectContaining({ code: 'agent-failed' }),
          }),
        }),
      }),
    )
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
})

test('fails a hard verification mismatch with the verification message', async ({
  page,
}) => {
  const { pageErrors, consoleIssues } = trackPageIssues(page)
  const runPanel = await openRunStudio(page)

  const verifiedManifestPath = await page.evaluate(
    () => window.__workflowE2E?.verifiedManifestPath ?? '',
  )
  expect(verifiedManifestPath).toBe('workflows/verified/WORKFLOW.md')
  const verifiedWorkflowPath = verifiedManifestPath.slice('workflows/'.length)
  await page
    .locator('select[aria-label="Open workflow"]')
    .selectOption(verifiedWorkflowPath)
  await page.evaluate(() => {
    // Schema-valid but failing the hard verification postcondition (ok must
    // be exactly true).
    window.__workflowE2E?.setRunScript([{ acceptValue: { ok: false } }])
  })
  await page.getByRole('textbox', { name: 'Run input' }).fill('verify me')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'failed',
  )
  await expect(page.locator('.yolo-workflow-run-status__badge')).toHaveText(
    'Failed',
  )
  const agentNode = page.locator('.yolo-workflow-run-node', {
    hasText: 'Agent',
  })
  await expect(agentNode.locator('.yolo-workflow-run-node__badge')).toHaveClass(
    /badge--failed/,
  )
  // The Error tab shows the verification verdict, not an agent failure.
  await page.getByRole('tab', { name: 'Error', exact: true }).click()
  await expect(page.locator('.yolo-workflow-run-error')).toContainText(
    'verification: /ok must be equal to constant',
  )
  await expect
    .poll(() =>
      page.evaluate(
        async (workflowPath) =>
          (
            (await window.__workflowE2E?.readRunFile(workflowPath)) as {
              error?: { code?: string }
            } | null
          )?.error?.code,
        verifiedWorkflowPath,
      ),
    )
    .toBe('verification-failed')
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
})

test('routes node model tiers through the module config', async ({ page }) => {
  const { pageErrors, consoleIssues } = trackPageIssues(page)
  const runPanel = await openRunStudio(page)

  await page.locator('[data-yolo-workflow-node="agent"]').click()
  const modelField = page
    .locator('.yolo-workflow-node-inspector .yolo-workflow-inspector__field', {
      hasText: 'Model',
    })
    .locator('input')
  await modelField.fill('deep')
  await page.evaluate(() => {
    window.__workflowE2E?.setConfigData({ 'tier.deep': 'deepseek-model' })
  })
  await page.locator('button[aria-label="Apply changes"]').click()
  await expect(page.locator('.yolo-workflow-canvas-toolbar__sync')).toHaveText(
    'Markdown synced',
  )

  await page.getByRole('textbox', { name: 'Run input' }).fill('tier check')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    'succeeded',
  )
  // The agent request carried the configured tier mapping, not the alias.
  await expect
    .poll(() => page.evaluate(() => window.__workflowE2E?.lastAgentRequest()))
    .toEqual(expect.objectContaining({ modelId: 'deepseek-model' }))
  // The inspector shows the resolved tier for the run's definition.
  await page.locator('[data-yolo-workflow-node="agent"]').click()
  await expect(page.locator('.yolo-workflow-inspector__hint')).toContainText(
    'Deep tier model',
  )
  await expect(page.locator('.yolo-workflow-inspector__hint')).toContainText(
    'Resolves to: deepseek-model',
  )
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
})

test('rejects run start when the requested tier is not configured', async ({
  page,
}) => {
  const { pageErrors, consoleIssues } = trackPageIssues(page)
  const runPanel = await openRunStudio(page)

  await page.locator('[data-yolo-workflow-node="agent"]').click()
  const modelField = page
    .locator('.yolo-workflow-node-inspector .yolo-workflow-inspector__field', {
      hasText: 'Model',
    })
    .locator('input')
  await modelField.fill('fast')
  await page.evaluate(() => {
    window.__workflowE2E?.setConfigData({})
  })
  await page.locator('button[aria-label="Apply changes"]').click()
  await expect(page.locator('.yolo-workflow-canvas-toolbar__sync')).toHaveText(
    'Markdown synced',
  )

  await page.getByRole('textbox', { name: 'Run input' }).fill('tier missing')
  await runPanel.getByRole('button', { name: 'Run', exact: true }).click()
  // Start bails with the tier-unavailable notice.
  await expect
    .poll(() => page.evaluate(() => window.__workflowE2E?.getNotice()))
    .toBe('The requested model tier is not configured.')
  // No run ever started: no record, no background activity, no status.
  expect(
    await page.evaluate(
      async () =>
        (await window.__workflowE2E?.readRunFile('demo/WORKFLOW.md')) ?? null,
    ),
  ).toBeNull()
  expect(
    await page.evaluate(
      () => window.__workflowE2E?.backgroundActivities() ?? [],
    ),
  ).toEqual([])
  await expect(page.locator('.yolo-workflow-module-root')).toHaveAttribute(
    'data-yolo-run-status',
    '',
  )
  expect(pageErrors).toEqual([])
  expect(consoleIssues).toEqual([])
})

type LayoutBox = Readonly<{
  left: number
  right: number
  top: number
  bottom: number
}>

type WorkflowLayout = Readonly<{
  root: LayoutBox
  canvas: LayoutBox
  addNode: LayoutBox
  assistant: LayoutBox
  rail: LayoutBox | null
  inspector: LayoutBox | null
}>

async function readLayout(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const box = (selector: string): LayoutBox | null => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      }
    }
    return {
      root: box('.yolo-workflow-studio')!,
      canvas: box('.yolo-workflow-canvas-shell')!,
      addNode: box('.yolo-workflow-add-node-bar')!,
      assistant: box('.yolo-workflow-assistant')!,
      rail: box('.yolo-workflow-rail'),
      inspector: box('.yolo-workflow-inspector'),
    }
  })
}

/** Boots the fixture and opens the Run studio tab, returning the run panel. */
async function openRunStudio(page: Page): Promise<Locator> {
  await page.goto(baseUrl)
  await expect(page.locator('.yolo-workflow-module-root')).toBeVisible()
  const runPanel = page.locator('.yolo-workflow-run-panel')
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  return runPanel
}

/** Records page errors and console error/warning messages for later assertions. */
function trackPageIssues(page: Page): {
  pageErrors: string[]
  consoleIssues: string[]
} {
  const pageErrors: string[] = []
  const consoleIssues: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      consoleIssues.push(`${message.type()}: ${message.text()}`)
  })
  return { pageErrors, consoleIssues }
}

function assertAligned(layout: WorkflowLayout, state: string): void {
  const same = (left: number, right: number): void => {
    expect(Math.abs(left - right), state).toBeLessThanOrEqual(1)
  }
  same(layout.canvas.left, layout.addNode.left)
  same(layout.canvas.right, layout.addNode.right)
  same(layout.canvas.left, layout.assistant.left)
  same(layout.canvas.right, layout.assistant.right)
  if (layout.rail) same(layout.rail.right, layout.canvas.left)
  else same(layout.root.left, layout.canvas.left)
  if (layout.inspector) same(layout.canvas.right, layout.inspector.left)
  else same(layout.root.right, layout.canvas.right)
}
