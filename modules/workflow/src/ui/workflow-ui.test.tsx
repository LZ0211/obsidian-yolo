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
import type { WorkflowBundle } from '../domain/workflow-repository'
import {
  parseWorkflowDocument,
  updateWorkflowManagedBlocks,
} from '../domain/workflow-document'
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
    const { model, addNode, selectNode } = createModel({ topology })
    await renderStudio(model)

    const addButton = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Add node: Condition"]',
    )
    expect(addButton).not.toBeNull()

    await act(async () => {
      addButton!.click()
      await Promise.resolve()
    })

    expect(addNode).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'condition-1', kind: 'condition' }),
      '# Condition\n',
    )
    expect(selectNode).toHaveBeenCalledWith('condition-1')
  })

  it('renders the dsh workbench regions and markdown inspector', async () => {
    const { model } = createModel({ bundle: createBundle() })
    await renderStudio(model)

    expect(
      testContainer.querySelector('.yolo-workflow-add-node-bar'),
    ).not.toBeNull()
    for (const label of [
      'Input',
      'Agent',
      'Map agent',
      'Condition',
      'Merge',
      'Output',
    ])
      expect(
        testContainer.querySelector(`button[aria-label="Add node: ${label}"]`),
      ).not.toBeNull()
    expect(
      testContainer.querySelector('.yolo-workflow-assistant'),
    ).not.toBeNull()
    expect(
      testContainer.querySelector('textarea[aria-label="Markdown content"]'),
    ).not.toBeNull()
    expect(testContainer.textContent).toContain(
      'Run workflows from the current session.',
    )
  })

  it('keeps workflow lifecycle controls in the canvas toolbar', async () => {
    const { model, trashCurrent } = createModel({ bundle: createBundle() })
    await renderStudio(model)

    const canvasToolbar = testContainer.querySelector(
      '.yolo-workflow-canvas-toolbar',
    )
    expect(canvasToolbar).not.toBeNull()
    expect(findButton(canvasToolbar!, 'New workflow')).not.toBeNull()
    expect(findButton(canvasToolbar!, 'Delete workflow')).not.toBeNull()
    expect(
      testContainer.querySelector('.yolo-workflow-toolbar__legacy-actions'),
    ).toBeNull()

    await act(async () => {
      findButton(canvasToolbar!, 'New workflow')!.click()
      await Promise.resolve()
    })
    expect(
      testContainer.querySelector('input[placeholder="New workflow"]'),
    ).not.toBeNull()

    await act(async () => {
      findButton(canvasToolbar!, 'Delete workflow')!.click()
      await Promise.resolve()
    })
    expect(trashCurrent).toHaveBeenCalled()
  })

  it('keeps imported STEP markdown when creating a workflow', async () => {
    const { model } = createModel()
    await renderStudio(model)

    const topology = {
      ...createTopology(),
      nodes: [
        ...createTopology().nodes,
        {
          id: 'output',
          kind: 'output' as const,
          label: 'Output',
          stepPath: 'steps/output/STEP.md',
          position: { x: 560, y: 90 },
        },
      ],
      edges: [
        ...createTopology().edges,
        { id: 'agent-output', source: 'agent', target: 'output' },
      ],
    }
    const stepContents = {
      input: '# Input instructions\n\nKeep this text.\n',
      agent: '# Agent instructions\n',
      output: '# Output instructions\n',
    }
    const fileContent = JSON.stringify({
      name: 'Imported',
      workflowContent: '# Imported\n',
      nodes: topology.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        position: node.position,
        data: { label: node.label },
      })),
      edges: topology.edges,
      docs: Object.fromEntries(
        topology.nodes.map((node) => [node.id, node.stepPath]),
      ),
      stepContents,
    })
    const file = {
      text: async () => fileContent,
    } as unknown as File
    const input =
      testContainer.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    Object.defineProperty(input!, 'files', {
      configurable: true,
      value: [file],
    })

    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stepFiles: expect.arrayContaining([
          {
            relativePath: 'steps/input/STEP.md',
            content: stepContents.input,
          },
        ]),
      }),
    )
  })

  it('updates the selected markdown file from the inspector', async () => {
    const { model, updateFile } = createModel({ bundle: createBundle() })
    await renderStudio(model)

    const editor = testContainer.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Markdown content"]',
    )
    expect(editor).not.toBeNull()

    await act(async () => {
      editor!.value = '# Updated workflow\n'
      editor!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(updateFile).toHaveBeenCalledWith('workflow', '# Updated workflow\n')
  })

  it('selects an edge from the canvas for inspection', async () => {
    const onSelectEdge = jest.fn()
    await renderGraph(createTopology(), onSelectEdge)

    const edge = testContainer.querySelector<SVGPathElement>(
      '.yolo-workflow-graph__edge-hitbox',
    )
    expect(edge).not.toBeNull()
    expect(edge!.closest('svg')?.getAttribute('aria-hidden')).toBeNull()

    act(() => edge!.dispatchEvent(new Event('pointerdown', { bubbles: true })))

    expect(onSelectEdge).toHaveBeenCalledWith('input-agent')
  })

  it('accepts a local workflow optimization proposal through updateFile', async () => {
    const { model, updateFile } = createModel({ bundle: createBundle() })
    await renderStudio(model)

    const optimize = Array.from(testContainer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Optimize workflow',
    )
    expect(optimize).not.toBeUndefined()
    act(() => optimize!.click())

    const accept = Array.from(testContainer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Accept',
    )
    expect(accept).not.toBeUndefined()
    act(() => accept!.click())

    expect(updateFile).toHaveBeenCalledWith('workflow', expect.any(String))
  })

  it('clears workflow-local assistant state when another workflow starts loading', async () => {
    const { model, setSnapshot } = createModel({
      bundle: createBundle(),
      selectedNodeId: 'agent',
    })
    await renderStudio(model)

    const optimize = Array.from(testContainer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Optimize workflow',
    )
    expect(optimize).not.toBeUndefined()
    act(() => optimize!.click())
    expect(
      testContainer.querySelector(
        'textarea[aria-label="Proposal"]',
      ),
    ).not.toBeNull()

    act(() =>
      setSnapshot({
        ...model.getSnapshot(),
        status: 'loading',
        path: 'second/WORKFLOW.md',
        bundle: null,
        topology: null,
        selectedNodeId: null,
        dirty: false,
        canUndo: false,
        canRedo: false,
        issues: [],
      }),
    )

    expect(
      testContainer.querySelector(
        'textarea[aria-label="Proposal"]',
      ),
    ).toBeNull()
  })

  it('renders draft topology labels in the workflow rail before apply', async () => {
    const { model, setSnapshot } = createModel({ bundle: createBundle() })
    await renderStudio(model)
    const review: WorkflowNode = {
      id: 'review',
      kind: 'agent',
      label: 'Review',
      stepPath: 'steps/review/STEP.md',
      position: { x: 560, y: 90 },
    }
    const topology = model.getSnapshot().topology!
    act(() => {
      setSnapshot({
        ...model.getSnapshot(),
        topology: {
          ...topology,
          nodes: [...topology.nodes, review],
          edges: [
            ...topology.edges,
            { id: 'agent-review', source: 'agent', target: 'review' },
          ],
        },
        dirty: true,
      })
    })

    expect(findButton(testContainer, 'Review')).not.toBeNull()
  })

  it('recreates the canvas when switching workflows', async () => {
    const { model, setSnapshot } = createModel({ bundle: createBundle() })
    await renderStudio(model)
    const previousGraph = testContainer.querySelector('.yolo-workflow-graph')
    expect(previousGraph).not.toBeNull()

    act(() =>
      setSnapshot({
        ...model.getSnapshot(),
        path: 'second/WORKFLOW.md',
        workflows: [
          { path: 'demo/WORKFLOW.md', title: 'Demo' },
          { path: 'second/WORKFLOW.md', title: 'Second' },
        ],
      }),
    )

    expect(testContainer.querySelector('.yolo-workflow-graph')).not.toBe(
      previousGraph,
    )
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

  it('exposes node deletion through the inspector for editable nodes', async () => {
    const { model, removeNode } = createModel({ selectedNodeId: 'agent' })
    await renderStudio(model)

    const deleteButton = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete node"]',
    )
    expect(deleteButton).not.toBeNull()

    await act(async () => {
      deleteButton!.click()
      await Promise.resolve()
    })

    expect(removeNode).toHaveBeenCalledWith('agent')
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

async function renderGraph(
  topology: WorkflowTopology,
  onSelectEdge: jest.Mock = jest.fn(),
): Promise<void> {
  await act(async () => {
    testRoot.render(
      <WorkflowGraph
        topology={topology}
        selectedNodeId={null}
        copy={createWorkflowCopy('en')}
        onSelectNode={jest.fn()}
        onSelectEdge={onSelectEdge}
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
  updateFile: jest.Mock
  addNode: jest.Mock
  selectNode: jest.Mock
  removeNode: jest.Mock
  trashCurrent: jest.Mock
  setSnapshot(next: WorkflowEditorSnapshot): void
}> {
  let snapshot = createSnapshot(overrides)
  const listeners = new Set<() => void>()
  const updateTopology = jest.fn(() => true)
  const updateFile = jest.fn(() => true)
  const addNode = jest.fn(async () => true)
  const selectNode = jest.fn()
  const removeNode = jest.fn(async () => true)
  const trashCurrent = jest.fn(async () => false)
  const model = {
    getSnapshot: () => snapshot,
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    load: jest.fn(async () => ({ ok: true as const })),
    selectNode,
    updateTopology,
    updateFile,
    saveFile: jest.fn(async () => ({ ok: true as const })),
    addNode,
    removeNode,
    apply: jest.fn(async () => ({ ok: true as const })),
    undo: jest.fn(() => false),
    redo: jest.fn(() => false),
    autoLayout: jest.fn(() => false),
    create: jest.fn(async () => ({
      ok: false as const,
      reason: 'invalid-input' as const,
    })),
    trashCurrent,
    dispose: jest.fn(),
  } as unknown as WorkflowEditorModel
  return {
    model,
    updateTopology,
    updateFile,
    addNode,
    selectNode,
    removeNode,
    trashCurrent,
    setSnapshot: (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

function findButton(
  container: Element,
  label: string,
): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes(label),
    ) ?? null
  )
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

function createBundle(): WorkflowBundle {
  const copy = createWorkflowCopy('en')
  const topology = createTopology()
  const content = updateWorkflowManagedBlocks('# Demo\n', topology, copy)
  const document = parseWorkflowDocument(content, copy)
  return {
    path: 'demo/WORKFLOW.md',
    document,
    files: [
      {
        nodeId: 'workflow',
        relativePath: 'demo/WORKFLOW.md',
        snapshot: {
          path: 'managed/workflows/demo/WORKFLOW.md',
          content,
        },
      },
      ...topology.nodes.map((node) => ({
        nodeId: node.id,
        relativePath: `demo/${node.stepPath}`,
        snapshot: {
          path: `managed/workflows/demo/${node.stepPath}`,
          content: `# ${node.label}\n`,
        },
      })),
    ],
  } as WorkflowBundle
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
