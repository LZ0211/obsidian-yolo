/** @jest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import type { WorkflowNode, WorkflowTopology } from '../domain/workflow-model'
import { createWorkflowCopy } from '../i18n'
import type {
  WorkflowEditorModel,
  WorkflowEditorSnapshot,
} from './workflow-editor-model'
import { WorkflowGraph } from './workflow-graph'
import { WorkflowStudio } from './workflow-studio'

let testContainer: HTMLDivElement
let testRoot: Root

const pointerIds = new Set<number>()
const originalSetPointerCapture = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'setPointerCapture',
)
const originalHasPointerCapture = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'hasPointerCapture',
)
const originalReleasePointerCapture = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'releasePointerCapture',
)

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value(pointerId: number) {
      pointerIds.add(pointerId)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
    configurable: true,
    value(pointerId: number) {
      return pointerIds.has(pointerId)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value(pointerId: number) {
      pointerIds.delete(pointerId)
    },
  })
})

afterAll(() => {
  pointerIds.clear()
  restorePrototypeMethod(
    HTMLElement.prototype,
    'setPointerCapture',
    originalSetPointerCapture,
  )
  restorePrototypeMethod(
    HTMLElement.prototype,
    'hasPointerCapture',
    originalHasPointerCapture,
  )
  restorePrototypeMethod(
    HTMLElement.prototype,
    'releasePointerCapture',
    originalReleasePointerCapture,
  )
})

describe('workflow studio UI interactions', () => {
  let restoreMatchMedia: (() => void) | undefined

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
    restoreMatchMedia?.()
    restoreMatchMedia = undefined
    testContainer.remove()
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })

  it('exposes an Add node control and adds the selected node kind', async () => {
    const topology = createTopology()
    const { model, updateTopology, selectNode } = createModel({ topology })
    await renderStudio(model)

    const kindSelect = testContainer.querySelector<HTMLSelectElement>(
      'select[aria-label="Add node"]',
    )
    const addButton = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Add node"]',
    )
    expect(kindSelect).not.toBeNull()
    expect(addButton).not.toBeNull()

    act(() => {
      kindSelect!.value = 'condition'
      kindSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => addButton!.click())

    expect(updateTopology).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'condition-1', kind: 'condition' }),
        ]),
      }),
    )
    expect(selectNode).toHaveBeenCalledWith('condition-1')
  })

  it('does not expose stepPath as an editable inspector field', async () => {
    const { model, updateTopology } = createModel({
      selectedNodeId: 'input',
    })
    await renderStudio(model)

    const stepPath = testContainer.querySelector<HTMLInputElement>(
      'input[value="steps/input/STEP.md"]',
    )
    expect(stepPath).not.toBeNull()
    expect(stepPath!.readOnly).toBe(true)

    act(() => {
      stepPath!.value = 'steps/changed/STEP.md'
      stepPath!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(updateTopology).not.toHaveBeenCalled()
  })

  it.each(['pointercancel', 'lostpointercapture'])(
    'clears an in-progress connection on %s',
    async (eventName) => {
      const { model } = createModel()
      await renderGraph(model.getSnapshot().topology!)

      const sourceHandle = testContainer.querySelector<HTMLButtonElement>(
        'button[aria-label="Add node: Input"]',
      )
      const graph = testContainer.querySelector<HTMLDivElement>(
        '[role="application"]',
      )
      expect(sourceHandle).not.toBeNull()
      expect(graph).not.toBeNull()

      act(() => dispatchPointer(sourceHandle!, 'pointerdown', 7))
      expect(
        testContainer.querySelector('.yolo-workflow-graph__hint'),
      ).not.toBeNull()

      act(() => dispatchPointer(graph!, eventName, 7))
      expect(
        testContainer.querySelector('.yolo-workflow-graph__hint'),
      ).toBeNull()
    },
  )

  it('focuses the target node when an edge finding is selected', async () => {
    const { model, selectNode } = createModel({
      issues: [{ code: 'cycle', edgeId: 'input-agent' }],
    })
    await renderStudio(model)

    const finding = testContainer.querySelector<HTMLButtonElement>(
      '.yolo-workflow-finding',
    )
    expect(finding).not.toBeNull()

    act(() => finding!.click())

    expect(selectNode).toHaveBeenCalledWith('agent')
  })

  it('keeps compact panels hidden initially but reopens them from the toolbar', async () => {
    restoreMatchMedia = mockCompactViewport()
    const { model } = createModel()
    await renderStudio(model)

    expect(testContainer.querySelector('.yolo-workflow-rail')).toBeNull()
    expect(testContainer.querySelector('.yolo-workflow-inspector')).toBeNull()

    const railToggle = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Workflows"]',
    )
    const inspectorToggle = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Node properties"]',
    )
    expect(railToggle).not.toBeNull()
    expect(inspectorToggle).not.toBeNull()

    act(() => railToggle!.click())
    act(() => inspectorToggle!.click())

    expect(testContainer.querySelector('.yolo-workflow-rail')).not.toBeNull()
    expect(
      testContainer.querySelector('.yolo-workflow-inspector'),
    ).not.toBeNull()
    expect(
      testContainer.querySelector<HTMLElement>('.yolo-workflow-rail')!.style
        .display,
    ).toBe('flex')
    expect(
      testContainer.querySelector<HTMLElement>('.yolo-workflow-inspector')!
        .style.display,
    ).toBe('flex')
  })

  it('surfaces workflow load failures through the notice callback', async () => {
    const { model } = createModel()
    const notice = jest.fn()
    ;(model.load as jest.Mock).mockRejectedValueOnce(new Error('load failed'))

    await renderStudio(model, notice)
    await act(async () => {
      await Promise.resolve()
    })

    expect(notice).toHaveBeenCalledWith('load failed')
  })

  it('surfaces workflow save failures through the notice callback', async () => {
    const { model } = createModel({ dirty: true })
    const notice = jest.fn()
    ;(model.apply as jest.Mock).mockRejectedValueOnce(new Error('save failed'))
    await renderStudio(model, notice)

    await act(async () => {
      testContainer
        .querySelector<HTMLButtonElement>('button[aria-label="Apply changes"]')
        ?.click()
      await Promise.resolve()
    })

    expect(notice).toHaveBeenCalledWith('save failed')
  })
})

async function renderStudio(
  model: WorkflowEditorModel,
  notice: jest.Mock = jest.fn(),
): Promise<void> {
  await act(async () => {
    testRoot.render(
      <WorkflowStudio
        model={model}
        copy={createWorkflowCopy('en')}
        openFile={jest.fn()}
        notice={notice}
      />,
    )
    await Promise.resolve()
  })
}

async function renderGraph(topology: WorkflowTopology): Promise<void> {
  await act(async () => {
    testRoot.render(
      <WorkflowGraph
        topology={topology}
        selectedNodeId={null}
        copy={createWorkflowCopy('en')}
        onSelectNode={jest.fn()}
        onMoveNode={jest.fn()}
        onConnect={jest.fn()}
      />,
    )
    await Promise.resolve()
  })
}

function createModel(
  overrides: Partial<WorkflowEditorSnapshot> = {},
): Readonly<{
  model: WorkflowEditorModel
  updateTopology: jest.Mock
  selectNode: jest.Mock
}> {
  const snapshot = createSnapshot(overrides)
  const updateTopology = jest.fn(() => true)
  const selectNode = jest.fn()
  const model = {
    getSnapshot: () => snapshot,
    subscribe: jest.fn(() => () => undefined),
    load: jest.fn(async () => ({ ok: true as const })),
    selectNode,
    updateTopology,
    apply: jest.fn(async () => ({ ok: true as const })),
    undo: jest.fn(() => false),
    redo: jest.fn(() => false),
    autoLayout: jest.fn(() => false),
    create: jest.fn(async () => ({
      ok: false as const,
      reason: 'invalid-input' as const,
    })),
    trashCurrent: jest.fn(async () => false),
    dispose: jest.fn(),
  } as unknown as WorkflowEditorModel
  return { model, updateTopology, selectNode }
}

function createSnapshot(
  overrides: Partial<WorkflowEditorSnapshot> = {},
): WorkflowEditorSnapshot {
  return {
    status: 'ready',
    workflows: [{ path: 'demo/WORKFLOW.md', title: 'Demo' }],
    path: 'demo/WORKFLOW.md',
    bundle: null,
    topology: createTopology(),
    selectedNodeId: 'input',
    dirty: false,
    canUndo: false,
    canRedo: false,
    issues: [],
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

function dispatchPointer(
  element: Element,
  type: string,
  pointerId: number,
): void {
  const event = new Event(type, { bubbles: true })
  Object.defineProperties(event, {
    button: { configurable: true, value: 0 },
    clientX: { configurable: true, value: 120 },
    clientY: { configurable: true, value: 120 },
    pointerId: { configurable: true, value: pointerId },
    pointerType: { configurable: true, value: 'mouse' },
  })
  element.dispatchEvent(event)
}

function mockCompactViewport(): () => void {
  const original = window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn(() => ({
      matches: true,
      media: '(max-width: 760px)',
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(() => false),
    })),
  })
  return () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: original,
    })
  }
}

function restorePrototypeMethod(
  prototype: HTMLElement,
  name: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(prototype, name, descriptor)
  else Reflect.deleteProperty(prototype, name)
}
