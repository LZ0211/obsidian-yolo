/** @jest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import type { WorkflowNode, WorkflowTopology } from '../domain/workflow-model'
import type {
  JsonValue,
  WorkflowNodeExecutionResult,
  WorkflowRunSnapshot,
} from '../execution/workflow-run-types'
import { createWorkflowCopy } from '../i18n'

import type { WorkflowRunPanelProps } from './workflow-run-panel'
import { WorkflowRunPanel } from './workflow-run-panel'

let testContainer: HTMLDivElement
let testRoot: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  })
  testContainer = document.createElement('div')
  document.body.appendChild(testContainer)
  testRoot = createRoot(testContainer)
})

afterEach(() => {
  act(() => testRoot.unmount())
  testContainer.remove()
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

describe('workflow run panel interactions', () => {
  it('disables Run while the editor is dirty or has validation issues', async () => {
    const { rerender } = await renderPanel({ dirty: true })
    expect(runButton()).not.toBeNull()
    expect(runButton()!.disabled).toBe(true)

    await rerender({ dirty: false, issues: [{ code: 'cycle' }] })
    expect(runButton()!.disabled).toBe(true)

    await rerender({ dirty: false, issues: [] })
    expect(runButton()!.disabled).toBe(false)
  })

  it('disables Run when no model resolves', async () => {
    await renderPanel({
      modelSnapshot: { defaultModelId: '', models: [] },
    })
    expect(runButton()!.disabled).toBe(true)
    expect(
      testContainer.querySelector<HTMLSelectElement>(
        'select[aria-label="Run model"]',
      )?.disabled,
    ).toBe(true)
  })

  it('shows Stop for an active run and cancels without local busy state', async () => {
    const { onCancel, rerender } = await renderPanel({
      run: createRunSnapshot({ status: 'running' }),
    })
    // Run is disabled while the path already has a run; Stop owns the action.
    expect(runButton()!.disabled).toBe(true)
    expect(runButton()!.title).toBe('This workflow is already running.')
    expect(stopButton()).not.toBeNull()

    act(() => stopButton()!.click())

    expect(onCancel).toHaveBeenCalledTimes(1)
    // No local busy state: the controls still reflect the snapshot.
    expect(stopButton()).not.toBeNull()
    expect(runButton()!.disabled).toBe(true)

    await rerender({
      run: createRunSnapshot({
        status: 'succeeded',
        nodes: {
          input: { status: 'succeeded', output: 'done' },
          agent: { status: 'succeeded', output: 'done' },
        },
        outputs: { agent: 'done' },
      }),
    })
    expect(stopButton()).toBeNull()
    expect(runButton()).not.toBeNull()
    expect(runButton()!.disabled).toBe(false)
  })

  it('passes parsed JSON input to the start callback', async () => {
    const { onStart } = await renderPanel()
    await setInput('{"topic": "demo", "count": 2}')
    act(() => runButton()!.click())

    expect(onStart).toHaveBeenCalledWith(
      { topic: 'demo', count: 2 },
      'provider/model',
    )
  })

  it('passes plain text input to the start callback as a string', async () => {
    const { onStart } = await renderPanel()
    await setInput('  summarize this flow  ')
    act(() => runButton()!.click())

    expect(onStart).toHaveBeenCalledWith(
      'summarize this flow',
      'provider/model',
    )
  })

  it('rejects invalid JSON input without calling start', async () => {
    const { onStart } = await renderPanel()
    await setInput('{"topic":')
    act(() => runButton()!.click())

    expect(onStart).not.toHaveBeenCalled()
    expect(testContainer.textContent).toContain(
      'Enter a JSON value or plain text as the run input.',
    )
  })

  it('requires the side-effect confirmation before continuing a failed run', async () => {
    const { onContinue, confirm, rerender } = await renderPanel({
      run: createRunSnapshot({
        status: 'failed',
        error: { code: 'agent-failed', message: 'boom' },
      }),
    })
    expect(continueButton()).not.toBeNull()

    confirm.mockResolvedValueOnce(false)
    act(() => continueButton()!.click())
    await flush()
    expect(confirm).toHaveBeenCalledWith({
      title: 'Continue',
      message: expect.stringContaining('re-apply side effects'),
      ctaText: 'Continue',
      cancelText: 'Cancel',
    })
    expect(onContinue).not.toHaveBeenCalled()

    confirm.mockResolvedValueOnce(true)
    act(() => continueButton()!.click())
    await flush()
    expect(onContinue).toHaveBeenCalledTimes(1)

    await rerender({
      run: createRunSnapshot({ status: 'succeeded' }),
    })
    expect(continueButton()).toBeNull()
  })

  it('hides Continue for interrupted runs only after a terminal state', async () => {
    const { rerender } = await renderPanel({
      run: createRunSnapshot({ status: 'interrupted' }),
    })
    expect(continueButton()).not.toBeNull()

    await rerender({
      run: createRunSnapshot({
        status: 'cancelled',
        cancelRequested: true,
      }),
    })
    expect(continueButton()).toBeNull()
  })

  it('renders node statuses and output from the snapshot without local duplication', async () => {
    const { rerender } = await renderPanel({
      run: createRunSnapshot({
        status: 'running',
        nodes: {
          input: { status: 'succeeded', output: { topic: 'demo' } },
          agent: { status: 'running' },
        },
      }),
      selectedNodeId: 'input',
    })

    expect(
      testContainer.querySelector('.yolo-workflow-run-status__badge')
        ?.textContent,
    ).toBe('Running')
    expect(testContainer.textContent).toContain('1/2')
    expect(
      testContainer.querySelector('.yolo-workflow-run-node small')?.textContent,
    ).toBe('Succeeded')

    act(() => {
      Array.from(testContainer.querySelectorAll('button'))
        .find((button) => button.textContent === 'Output')
        ?.click()
    })
    expect(
      testContainer.querySelector('.yolo-workflow-run-preview')?.textContent,
    ).toContain('"topic": "demo"')

    // A snapshot update flows straight into the same preview elements.
    await rerender({
      run: createRunSnapshot({
        status: 'succeeded',
        nodes: {
          input: { status: 'succeeded', output: { topic: 'demo' } },
          agent: { status: 'succeeded', output: { result: 42 } },
        },
        outputs: { agent: { result: 42 } },
      }),
      selectedNodeId: 'agent',
    })
    expect(
      testContainer.querySelector('.yolo-workflow-run-status__badge')
        ?.textContent,
    ).toBe('Succeeded')
    expect(
      testContainer.querySelector('.yolo-workflow-run-preview')?.textContent,
    ).toContain('"result": 42')
  })

  it('selecting a run node calls the select callback', async () => {
    const { onSelectNode } = await renderPanel({
      run: createRunSnapshot({ status: 'running' }),
    })
    const nodes = testContainer.querySelectorAll('.yolo-workflow-run-node')
    expect(nodes.length).toBe(2)

    act(() => {
      ;(nodes[1] as HTMLButtonElement).click()
    })

    expect(onSelectNode).toHaveBeenCalledWith('agent')
  })

  it('keeps long errors and large output inside the panel', async () => {
    const longError = 'x'.repeat(5000)
    const longOutput = 'y'.repeat(5000)
    await renderPanel({
      run: createRunSnapshot({
        status: 'failed',
        error: { code: 'agent-failed', message: longError },
        nodes: {
          input: { status: 'succeeded', output: 'done' },
          agent: {
            status: 'failed',
            output: longOutput,
            error: { code: 'agent-failed', message: longError },
          },
        },
      }),
      selectedNodeId: 'agent',
    })

    const errorTab = Array.from(testContainer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Error',
    )
    act(() => errorTab!.click())

    const errorBox = testContainer.querySelector('.yolo-workflow-run-error')
    expect(errorBox).not.toBeNull()
    expect(errorBox!.textContent).toBe(longError)

    act(() => {
      Array.from(testContainer.querySelectorAll('button'))
        .find((button) => button.textContent === 'Output')
        ?.click()
    })
    const preview = testContainer.querySelector('.yolo-workflow-run-preview')
    expect(preview).not.toBeNull()
    expect(preview!.textContent).toContain(longOutput)
    expect(
      testContainer.querySelector('.yolo-workflow-run-panel'),
    ).not.toBeNull()
  })

  it('shows the side-effect confirmation notice for failed and interrupted runs', async () => {
    await renderPanel({
      run: createRunSnapshot({
        status: 'failed',
        error: { code: 'agent-failed', message: 'boom' },
      }),
    })
    const notice = testContainer.querySelector(
      '.yolo-workflow-run-confirmation',
    )
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('re-apply side effects')
  })

  it('keeps the Test node control hidden until the testNode callback is wired', async () => {
    await renderPanel({ run: createRunSnapshot({ status: 'running' }) })
    expect(findButton('Test node')).toBeNull()

    const onTestNode = jest.fn(async () => ({ value: 'tested' }))
    await renderPanel({
      run: createRunSnapshot({ status: 'succeeded' }),
      selectedNodeId: 'agent',
      onTestNode,
    })
    expect(findButton('Test node')).not.toBeNull()
    await setInput('{"probe": true}')
    act(() => findButton('Test node')!.click())
    await flush()
    expect(onTestNode).toHaveBeenCalledWith('agent', { probe: true })
  })

  it('hides the Test node control for missing or non-executable selections', async () => {
    const onTestNode = jest.fn()
    const { rerender } = await renderPanel({
      run: createRunSnapshot({ status: 'succeeded' }),
      selectedNodeId: 'input',
      onTestNode,
    })
    expect(findButton('Test node')).toBeNull()

    await rerender({ selectedNodeId: null })
    expect(findButton('Test node')).toBeNull()
  })

  it('hides the Test node control while a full run is active', async () => {
    const onTestNode = jest.fn()
    await renderPanel({
      run: createRunSnapshot({ status: 'running' }),
      selectedNodeId: 'agent',
      onTestNode,
    })
    expect(findButton('Test node')).toBeNull()
  })

  it('runs a node test from the parsed input and shows the result in the output area', async () => {
    const onTestNode = jest.fn(
      async (_nodeId: string, input: JsonValue) => ({ value: input }),
    )
    const { rerender } = await renderPanel({
      run: createRunSnapshot({
        status: 'succeeded',
        nodes: {
          input: { status: 'succeeded', output: { topic: 'demo' } },
          agent: { status: 'succeeded', output: 'done' },
        },
      }),
      selectedNodeId: 'agent',
      onTestNode,
    })
    act(() => {
      Array.from(testContainer.querySelectorAll('button'))
        .find((button) => button.textContent === 'Output')
        ?.click()
    })
    expect(
      testContainer.querySelector('.yolo-workflow-run-preview')?.textContent,
    ).toBe('"done"')

    await setInput('{"probe": true}')
    act(() => findButton('Test node')!.click())
    await flush()

    expect(onTestNode).toHaveBeenCalledWith('agent', { probe: true })
    // The test result replaces the run snapshot output for the selected node.
    expect(
      testContainer.querySelector('.yolo-workflow-run-preview')?.textContent,
    ).toContain('"probe": true')

    // A snapshot refresh keeps the test result displayed for the same node.
    await rerender({
      run: createRunSnapshot({
        status: 'succeeded',
        nodes: {
          input: { status: 'succeeded', output: { topic: 'demo' } },
          agent: { status: 'succeeded', output: 'changed' },
        },
      }),
    })
    expect(
      testContainer.querySelector('.yolo-workflow-run-preview')?.textContent,
    ).toContain('"probe": true')
  })

  it('shows Testing… while the node test is pending and clears on selection change', async () => {
    let resolveTest!: (result: WorkflowNodeExecutionResult) => void
    const onTestNode = jest.fn(
      () =>
        new Promise<WorkflowNodeExecutionResult>((resolve) => {
          resolveTest = resolve
        }),
    )
    const { rerender } = await renderPanel({
      run: createRunSnapshot({ status: 'succeeded' }),
      selectedNodeId: 'agent',
      onTestNode,
    })
    await setInput('hello')
    act(() => findButton('Test node')!.click())
    await flush()
    expect(findButton('Testing…')).not.toBeNull()
    expect(findButton('Testing…')!.disabled).toBe(true)

    act(() => {
      resolveTest({ value: 'result-1' })
    })
    await flush()
    expect(findButton('Test node')).not.toBeNull()
    expect(findButton('Testing…')).toBeNull()

    // Selecting another node clears the previous test result.
    act(() => {
      Array.from(testContainer.querySelectorAll('button'))
        .find((button) => button.textContent === 'Output')
        ?.click()
    })
    expect(
      testContainer.querySelector('.yolo-workflow-run-preview')?.textContent,
    ).toContain('"result-1"')
    await rerender({ selectedNodeId: 'input' })
    expect(
      testContainer.querySelector('.yolo-workflow-run-preview')?.textContent,
    ).toContain('"topic": "demo"')
  })

  it('shows a failed node test error in the error tab', async () => {
    const onTestNode = jest.fn(async () => {
      throw new Error('boom test')
    })
    await renderPanel({
      run: createRunSnapshot({ status: 'succeeded' }),
      selectedNodeId: 'agent',
      onTestNode,
    })
    await setInput('hello')
    act(() => findButton('Test node')!.click())
    await flush()

    act(() => {
      Array.from(testContainer.querySelectorAll('button'))
        .find((button) => button.textContent === 'Error')
        ?.click()
    })
    expect(
      testContainer.querySelector('.yolo-workflow-run-error')?.textContent,
    ).toBe('boom test')
  })

  it('rejects a node test with blank input through the existing parser', async () => {
    const onTestNode = jest.fn()
    await renderPanel({
      run: createRunSnapshot({ status: 'succeeded' }),
      selectedNodeId: 'agent',
      onTestNode,
    })
    act(() => findButton('Test node')!.click())

    expect(onTestNode).not.toHaveBeenCalled()
    expect(testContainer.textContent).toContain(
      'Enter a JSON value or plain text as the run input.',
    )
  })
})

async function renderPanel(
  props: Partial<WorkflowRunPanelProps> = {},
): Promise<{
  onStart: jest.Mock
  onCancel: jest.Mock
  onContinue: jest.Mock
  onSelectNode: jest.Mock
  onTestNode: jest.Mock
  confirm: jest.Mock
  rerender: (next: Partial<WorkflowRunPanelProps>) => Promise<void>
}> {
  const onStart = jest.fn()
  const onCancel = jest.fn()
  const onContinue = jest.fn()
  const onSelectNode = jest.fn()
  const onTestNode = jest.fn()
  const confirm = jest.fn(async () => true)
  let merged: WorkflowRunPanelProps = {
    copy: createWorkflowCopy('en'),
    run: null,
    selectedNodeId: null,
    modelSnapshot: {
      defaultModelId: 'provider/model',
      models: [{ id: 'provider/model', name: 'Model', providerId: 'provider' }],
    },
    dirty: false,
    issues: [],
    confirm,
    onStart,
    onCancel,
    onContinue,
    onSelectNode,
    ...props,
  }
  const render = async (): Promise<void> => {
    await act(async () => {
      testRoot.render(<WorkflowRunPanel {...merged} />)
      await Promise.resolve()
    })
  }
  await render()
  return {
    onStart,
    onCancel,
    onContinue,
    onSelectNode,
    onTestNode: (props.onTestNode ?? onTestNode) as jest.Mock,
    confirm,
    rerender: async (next) => {
      merged = { ...merged, ...next }
      await render()
    },
  }
}

async function setInput(value: string): Promise<void> {
  const textarea = testContainer.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Run input"]',
  )
  expect(textarea).not.toBeNull()
  await act(async () => {
    textarea!.value = value
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

function runButton(): HTMLButtonElement | null {
  return testContainer.querySelector('.yolo-workflow-run-controls__run')
}

function stopButton(): HTMLButtonElement | null {
  return testContainer.querySelector('.yolo-workflow-run-controls__stop')
}

function continueButton(): HTMLButtonElement | null {
  return testContainer.querySelector('.yolo-workflow-run-controls__continue')
}

function findButton(label: string): HTMLButtonElement | null {
  return (
    Array.from(
      testContainer.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === label) ?? null
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function createRunSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {},
): WorkflowRunSnapshot {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    workflowPath: 'demo/WORKFLOW.md',
    definition: {
      workflowPath: 'demo/WORKFLOW.md',
      workflowContextMarkdown: '',
      topology: createTopology(),
      stepContents: { input: '# Input\n', agent: '# Agent\n' },
      modelByNodeId: { input: 'provider/model', agent: 'provider/model' },
      policy: {
        capability: 'vault-write',
        mapConcurrency: 3,
        mergeStrategy: 'concat',
      },
      definitionHash: 'hash',
    },
    input: { topic: 'demo' },
    status: 'running',
    nodes: {
      input: { status: 'succeeded', output: { topic: 'demo' } },
      agent: { status: 'pending' },
    },
    outputs: {},
    startedAt: 0,
    ...overrides,
  }
}

function createTopology(): WorkflowTopology {
  const input: WorkflowNode = {
    id: 'input',
    kind: 'input',
    label: 'Input',
    stepPath: 'steps/input/STEP.md',
    position: { x: 70, y: 90 },
  }
  const agent: WorkflowNode = {
    id: 'agent',
    kind: 'agent',
    label: 'Agent',
    stepPath: 'steps/agent/STEP.md',
    position: { x: 315, y: 90 },
  }
  return {
    revision: 1,
    nodes: [input, agent],
    edges: [{ id: 'input-agent', source: 'input', target: 'agent' }],
  }
}
