import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
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
