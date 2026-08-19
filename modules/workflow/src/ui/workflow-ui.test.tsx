/** @jest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import {
  parseWorkflowDocument,
  updateWorkflowManagedBlocks,
} from '../domain/workflow-document'
import type { WorkflowNode, WorkflowTopology } from '../domain/workflow-model'
import type { WorkflowBundle } from '../domain/workflow-repository'
import type { WorkflowRunSnapshot } from '../execution/workflow-run-types'
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
    expect(testContainer.textContent).not.toContain(
      'Run workflows from the current session.',
    )
    expect(testContainer.textContent).toContain('Checks & suggestions')
  })

  it('keeps workflow lifecycle controls in the canvas toolbar', async () => {
    const { model, trashCurrent } = createModel({ bundle: createBundle() })
    const confirm = jest.fn(async () => true)
    await renderStudio(model, jest.fn(), confirm)

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

  it('exposes Rename and refuses while dirty or running', async () => {
    const { model, setSnapshot } = createModel({ bundle: createBundle() })
    await renderStudio(model)

    const renameButton = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename workflow"]',
    )
    expect(renameButton).not.toBeNull()
    expect(renameButton!.disabled).toBe(false)

    act(() => setSnapshot({ ...model.getSnapshot(), dirty: true }))
    expect(renameButton!.disabled).toBe(true)

    act(() => setSnapshot({ ...model.getSnapshot(), dirty: false }))
    expect(renameButton!.disabled).toBe(false)

    act(() => testRoot.unmount())
    testRoot = createRoot(testContainer)
    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      {
        run: createRunSnapshot({ status: 'running' }),
      },
    )
    const runningRename = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename workflow"]',
    )
    expect(runningRename).not.toBeNull()
    expect(runningRename!.disabled).toBe(true)
  })

  it('renames the workflow through the inline input and delegates the result', async () => {
    const { model } = createModel({ bundle: createBundle() })
    const notice = jest.fn()
    const onRename = jest.fn(async () => true)
    await renderStudio(
      model,
      notice,
      jest.fn(async () => true),
      { onRename },
    )

    const renameButton = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename workflow"]',
    )
    await act(async () => {
      renameButton!.click()
      await Promise.resolve()
    })
    const input = testContainer.querySelector<HTMLInputElement>(
      'input[aria-label="Rename workflow"]',
    )
    expect(input).not.toBeNull()
    expect(input!.placeholder).toBe('New workflow name')

    await act(async () => {
      setInputValue(input!, 'renamed-flow')
      testContainer
        .querySelector<HTMLButtonElement>(
          '.yolo-workflow-create-bar button[type="submit"]',
        )
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onRename).toHaveBeenCalledWith('renamed-flow')
    expect(notice).not.toHaveBeenCalled()

    // A rejected rename keeps the inline input open; the view-level wiring
    // owns the failure notice.
    onRename.mockResolvedValueOnce(false)
    await act(async () => {
      renameButton!.click()
      await Promise.resolve()
    })
    const reopenedInput = testContainer.querySelector<HTMLInputElement>(
      'input[aria-label="Rename workflow"]',
    )
    expect(reopenedInput).not.toBeNull()
    await act(async () => {
      setInputValue(reopenedInput!, 'second-name')
      testContainer
        .querySelector<HTMLButtonElement>(
          '.yolo-workflow-create-bar button[type="submit"]',
        )
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onRename).toHaveBeenLastCalledWith('second-name')
    expect(notice).not.toHaveBeenCalled()
    expect(
      testContainer.querySelector('input[aria-label="Rename workflow"]'),
    ).not.toBeNull()
  })

  it('requires confirmation before deleting the current workflow', async () => {
    const { model, trashCurrent } = createModel({ bundle: createBundle() })
    const confirm = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    await renderStudio(model, jest.fn(), confirm)

    await act(async () => {
      testContainer
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete workflow"]',
        )
        ?.click()
      await Promise.resolve()
    })

    expect(confirm).toHaveBeenCalledWith({
      title: 'Delete this workflow?',
      message: 'demo/WORKFLOW.md',
      ctaText: 'Delete workflow',
      cancelText: 'Cancel',
    })
    expect(trashCurrent).not.toHaveBeenCalled()

    await act(async () => {
      testContainer
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete workflow"]',
        )
        ?.click()
      await Promise.resolve()
    })

    expect(trashCurrent).toHaveBeenCalledTimes(1)
  })

  it('reports a failed workflow deletion', async () => {
    const { model } = createModel({ bundle: createBundle() })
    const notice = jest.fn()
    await renderStudio(model, notice)

    await act(async () => {
      testContainer
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete workflow"]',
        )
        ?.click()
      await Promise.resolve()
    })

    expect(notice).toHaveBeenCalledWith('The workflow could not be deleted.')
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
    const { model, updateFile } = createModel({ bundle: createValidBundle() })
    await renderStudio(model)

    const optimize = Array.from(testContainer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Optimize workflow',
    )
    expect(optimize).not.toBeUndefined()
    await act(async () => {
      optimize!.click()
      await flushAssistant()
    })

    const accept = Array.from(testContainer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Accept',
    )
    expect(accept).not.toBeUndefined()
    act(() => accept!.click())

    expect(updateFile).toHaveBeenCalledWith('workflow', expect.any(String))
  })

  it('runs an assistant review with the selected model and keeps it as a draft', async () => {
    const { model, updateFile } = createModel({ bundle: createValidBundle() })
    const source = model.getSnapshot().bundle!.document.content
    const notice = jest.fn()
    const stream = jest.fn(async function* (request: AgentRequest) {
      expect(request.modelId).toBe('provider/slow')
      expect(request.prompt).toContain('Tighten the instructions')
      const result = await request.tools![0].handler({
        content: `${source}\nReviewed by the assistant.\n`,
      })
      expect(result.isError).toBeUndefined()
      yield { type: 'completed' as const, text: '' }
    })
    const modelSelect = {
      defaultModelId: 'provider/fast',
      models: [
        { id: 'provider/fast', name: 'Fast', providerId: 'provider' },
        { id: 'provider/slow', name: 'Slow', providerId: 'provider' },
      ],
    }
    await renderStudio(
      model,
      notice,
      jest.fn(async () => true),
      {
        agent: { stream },
        models: modelSelect,
      },
    )

    const select = testContainer.querySelector<HTMLSelectElement>(
      'select[aria-label="Assistant model"]',
    )
    const instruction = testContainer.querySelector<HTMLInputElement>(
      'input[aria-label="Instruction"]',
    )
    expect(select).not.toBeNull()
    expect(instruction).not.toBeNull()
    await act(async () => {
      select!.value = 'provider/slow'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      setInputValue(instruction!, 'Tighten the instructions')
      await Promise.resolve()
    })
    await act(async () => {
      findButton(testContainer, 'Optimize workflow')!.click()
      await flushAssistant()
    })

    expect(stream).toHaveBeenCalledTimes(1)
    expect(
      testContainer.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Proposal"]',
      )?.value,
    ).toContain('Reviewed by the assistant.')
    expect(updateFile).not.toHaveBeenCalled()

    await act(async () => {
      findButton(testContainer, 'Accept')!.click()
      await Promise.resolve()
    })
    expect(updateFile).toHaveBeenCalledWith(
      'workflow',
      expect.stringContaining('Reviewed by the assistant.'),
    )
  })

  it('does not cancel a running assistant review on ordinary rerenders', async () => {
    const { model } = createModel({ bundle: createValidBundle() })
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let signal: AbortSignal | undefined
    const agent = {
      stream: jest.fn(async function* (request: AgentRequest) {
        signal = request.signal
        await pending
        await request.tools![0].handler({
          content: model.getSnapshot().bundle!.document.content,
        })
        yield { type: 'completed' as const, text: '' }
      }),
    }

    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      { agent },
    )

    await act(async () => {
      findButton(testContainer, 'Optimize workflow')!.click()
      await flushAssistant()
    })

    expect(signal?.aborted).toBe(false)

    await act(async () => {
      release()
      await pending
      await Promise.resolve()
    })
  })

  it('reports when no assistant model is configured', async () => {
    const { model } = createModel({ bundle: createBundle() })
    const notice = jest.fn()
    await renderStudio(
      model,
      notice,
      jest.fn(async () => true),
      {
        models: { defaultModelId: '', models: [] },
      },
    )

    await act(async () => {
      findButton(testContainer, 'Optimize workflow')!.click()
      await Promise.resolve()
      await flushAssistant()
    })

    expect(notice).toHaveBeenCalledWith('No assistant model is configured.')
  })

  it('ignores a late proposal after the assistant review is cancelled', async () => {
    const { model } = createModel({ bundle: createValidBundle() })
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const agent = {
      stream: jest.fn(async function* (request: AgentRequest) {
        await pending
        await request.tools![0].handler({
          content: model.getSnapshot().bundle!.document.content,
        })
        yield { type: 'completed' as const, text: '' }
      }),
    }
    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      { agent },
    )

    await act(async () => {
      findButton(testContainer, 'Optimize workflow')!.click()
      await flushAssistant()
    })
    expect(findButton(testContainer, 'Cancel')).not.toBeNull()

    await act(async () => {
      findButton(testContainer, 'Cancel')!.click()
      release()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      testContainer.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Proposal"]',
      ),
    ).toBeNull()
  })

  it('uses graph order when proposing an execution-order document section', async () => {
    const { model, setSnapshot } = createModel({ bundle: createValidBundle() })
    const agent = {
      stream: jest.fn(async function* (request: AgentRequest) {
        const content = `${model.getSnapshot().bundle!.document.content}\n1. Input\n2. Agent\n3. Output\n`
        await request.tools![0].handler({ content })
        yield { type: 'completed' as const, text: '' }
      }),
    }
    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      { agent },
    )
    const source = createTopology()
    const output: WorkflowNode = {
      id: 'output',
      kind: 'output',
      label: 'Output',
      stepPath: 'steps/output/STEP.md',
      position: { x: 560, y: 90 },
    }
    const shuffled: WorkflowTopology = {
      revision: 1,
      nodes: [output, source.nodes[1], source.nodes[0]],
      edges: [
        ...source.edges,
        { id: 'agent-output', source: 'agent', target: 'output' },
      ],
    }
    act(() => setSnapshot({ ...model.getSnapshot(), topology: shuffled }))

    const optimize = Array.from(testContainer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Optimize doc',
    )
    expect(optimize).not.toBeUndefined()
    await act(async () => {
      optimize!.click()
      await flushAssistant()
    })

    const proposal = testContainer.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Proposal"]',
    )
    expect(proposal?.value).toContain('1. Input\n2. Agent\n3. Output')
  })

  it('clears workflow-local assistant state when another workflow starts loading', async () => {
    const { model, setSnapshot } = createModel({
      bundle: createValidBundle(),
      selectedNodeId: 'agent',
    })
    await renderStudio(model)

    const optimize = Array.from(testContainer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Optimize workflow',
    )
    expect(optimize).not.toBeUndefined()
    await act(async () => {
      optimize!.click()
      await flushAssistant()
    })
    expect(
      testContainer.querySelector('textarea[aria-label="Proposal"]'),
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
      testContainer.querySelector('textarea[aria-label="Proposal"]'),
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

  it('offers to discard dirty edits before switching workflows', async () => {
    const { model } = createModel({
      dirty: true,
      workflows: [
        { path: 'demo/WORKFLOW.md', title: 'Demo' },
        { path: 'second/WORKFLOW.md', title: 'Second' },
      ],
    })
    const confirm = jest.fn(async () => true)
    await renderStudio(model, jest.fn(), confirm)
    ;(model.load as jest.Mock).mockClear()
    ;(model.load as jest.Mock).mockResolvedValueOnce({
      ok: false as const,
      reason: 'dirty' as const,
    })

    const flow = testContainer.querySelector<HTMLSelectElement>(
      'select[aria-label="Open workflow"]',
    )
    expect(flow).not.toBeNull()
    await act(async () => {
      flow!.value = 'second/WORKFLOW.md'
      flow!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirm).toHaveBeenCalledWith({
      title: 'Discard unsaved changes?',
      message: 'second/WORKFLOW.md',
      ctaText: 'Discard',
      cancelText: 'Cancel',
    })
    expect(model.load).toHaveBeenLastCalledWith('second/WORKFLOW.md', {
      discardDirty: true,
    })
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

    expect(testContainer.querySelector('.yolo-workflow-rail')).toBeNull()
    expect(
      testContainer.querySelector('.yolo-workflow-inspector'),
    ).not.toBeNull()
    expect(
      testContainer.querySelector<HTMLElement>('.yolo-workflow-inspector')!
        .style.display,
    ).toBe('flex')
  })

  it('surfaces a conflict while local changes are still dirty', async () => {
    const { model } = createModel({
      bundle: createBundle(),
      status: 'conflict',
      dirty: true,
    })
    await renderStudio(model)

    expect(
      testContainer.querySelector('.yolo-workflow-toolbar__status')
        ?.textContent,
    ).toContain('This workflow changed elsewhere.')
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

  it('renders loading and error states instead of presenting an empty workflow', async () => {
    const { model: loadingModel } = createModel({
      status: 'loading',
      topology: null,
      bundle: null,
    })
    await renderStudio(loadingModel)

    const loadingState = testContainer.querySelector(
      '.yolo-workflow-empty-state',
    )
    expect(loadingState?.textContent).toContain('Loading workflow…')
    expect(loadingState?.textContent).not.toContain('No workflow yet')

    act(() => testRoot.unmount())
    testRoot = createRoot(testContainer)

    const { model: errorModel } = createModel({
      status: 'error',
      topology: null,
      bundle: null,
    })
    await renderStudio(errorModel)
    ;(errorModel.load as jest.Mock).mockClear()

    const errorState = testContainer.querySelector('.yolo-workflow-empty-state')
    expect(errorState?.textContent).toContain('Workflow error')
    expect(errorState?.textContent).not.toContain('No workflow yet')
    const retry = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry"]',
    )
    expect(retry).not.toBeNull()

    await act(async () => {
      retry!.click()
      await Promise.resolve()
    })
    expect(errorModel.load).toHaveBeenCalledWith('demo/WORKFLOW.md')
  })

  it('shows validation when a workflow name cannot become a safe slug', async () => {
    const { model } = createModel()
    await renderStudio(model)

    await act(async () => {
      findButton(testContainer, 'New workflow')!.click()
      await Promise.resolve()
    })
    const input = testContainer.querySelector<HTMLInputElement>(
      'input[placeholder="New workflow"]',
    )
    expect(input).not.toBeNull()

    await act(async () => {
      input!.value = '调试流程'
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      testContainer
        .querySelector<HTMLButtonElement>(
          '.yolo-workflow-create-bar button[type="submit"]',
        )
        ?.click()
      await Promise.resolve()
    })

    expect(testContainer.textContent).toContain('Enter a valid workflow name.')
    expect(model.create).not.toHaveBeenCalled()
  })

  it('disables duplicate apply actions while a save is pending', async () => {
    const { model } = createModel({ dirty: true })
    let resolveApply: (value: { ok: true }) => void = () => undefined
    const pending = new Promise<{ ok: true }>((resolve) => {
      resolveApply = resolve
    })
    ;(model.apply as jest.Mock).mockReturnValueOnce(pending)
    await renderStudio(model)

    const apply = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Apply changes"]',
    )
    expect(apply).not.toBeNull()

    await act(async () => {
      apply!.click()
      await Promise.resolve()
    })

    expect(apply!.disabled).toBe(true)
    expect(testContainer.textContent).toContain('Saving…')

    await act(async () => {
      resolveApply({ ok: true })
      await pending
    })

    expect(apply!.disabled).toBe(false)
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

  it('surfaces STEP cleanup failures after the manifest save succeeds', async () => {
    const { model, setSnapshot } = createModel({
      bundle: createBundle(),
      dirty: true,
    })
    const notice = jest.fn()
    ;(model.apply as jest.Mock).mockImplementationOnce(async () => {
      setSnapshot({
        ...model.getSnapshot(),
        status: 'error',
        error: 'workflow-step-cleanup-failed',
        dirty: true,
      })
      return { ok: true as const }
    })
    await renderStudio(model, notice)

    await act(async () => {
      testContainer
        .querySelector<HTMLButtonElement>('button[aria-label="Apply changes"]')
        ?.click()
      await Promise.resolve()
    })

    expect(notice).toHaveBeenCalledWith('workflow-step-cleanup-failed')
  })

  it('keeps the Run tab reachable while Assistant remains available', async () => {
    const { model } = createModel({ bundle: createValidBundle() })
    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      {
        run: createRunSnapshot({ status: 'running' }),
      },
    )

    expect(
      testContainer.querySelector('.yolo-workflow-assistant'),
    ).not.toBeNull()
    expect(testContainer.querySelector('.yolo-workflow-run-panel')).toBeNull()

    const tabButtons = Array.from(
      testContainer.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
    )
    const runTab = tabButtons.find((button) => button.textContent === 'Run')
    const assistantTab = tabButtons.find(
      (button) => button.textContent === 'Assistant',
    )
    expect(runTab).not.toBeUndefined()
    expect(assistantTab).not.toBeUndefined()

    act(() => runTab!.click())
    expect(
      testContainer.querySelector('.yolo-workflow-run-panel'),
    ).not.toBeNull()
    expect(testContainer.querySelector('.yolo-workflow-assistant')).toBeNull()

    act(() => assistantTab!.click())
    expect(
      testContainer.querySelector('.yolo-workflow-assistant'),
    ).not.toBeNull()
    expect(testContainer.querySelector('.yolo-workflow-run-panel')).toBeNull()
  })

  it('switches to the Run tab from the toolbar Run button and Stop cancels', async () => {
    const { model } = createModel({ bundle: createValidBundle() })
    const onCancel = jest.fn()
    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      {
        run: createRunSnapshot({ status: 'running' }),
        onCancel,
      },
    )

    let canvasToolbar = testContainer.querySelector(
      '.yolo-workflow-canvas-toolbar',
    )
    expect(canvasToolbar).not.toBeNull()
    expect(findButton(canvasToolbar!, 'Stop')).not.toBeNull()

    await act(async () => {
      findButton(canvasToolbar!, 'Stop')!.click()
      await Promise.resolve()
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(
      testContainer.querySelector('.yolo-workflow-run-panel'),
    ).not.toBeNull()

    act(() => testRoot.unmount())
    testRoot = createRoot(testContainer)

    const { model: idleModel } = createModel({ bundle: createValidBundle() })
    const idleCancel = jest.fn()
    await renderStudio(
      idleModel,
      jest.fn(),
      jest.fn(async () => true),
      {
        onCancel: idleCancel,
      },
    )
    canvasToolbar = testContainer.querySelector('.yolo-workflow-canvas-toolbar')
    expect(findButton(canvasToolbar!, 'Run')).not.toBeNull()

    await act(async () => {
      findButton(canvasToolbar!, 'Run')!.click()
      await Promise.resolve()
    })

    expect(idleCancel).not.toHaveBeenCalled()
    expect(
      testContainer.querySelector('.yolo-workflow-run-panel'),
    ).not.toBeNull()
  })

  it('makes editing controls read-only during an active run and restores them after', async () => {
    const { model, addNode } = createModel({
      bundle: createValidBundle(),
      dirty: true,
    })
    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      {
        run: createRunSnapshot({ status: 'running' }),
      },
    )

    const addButton = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Add node: Condition"]',
    )
    expect(addButton).not.toBeNull()
    expect(addButton!.disabled).toBe(true)

    const saveButton = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Save"]',
    )
    expect(saveButton!.disabled).toBe(true)

    const markdown = testContainer.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Markdown content"]',
    )
    expect(markdown).not.toBeNull()
    expect(markdown!.disabled).toBe(true)

    const labelField = testContainer.querySelector<HTMLInputElement>(
      '.yolo-workflow-node-inspector input[value="Input"]',
    )
    expect(labelField).not.toBeNull()
    expect(labelField!.disabled).toBe(true)

    await act(async () => {
      addButton!.click()
      await Promise.resolve()
    })
    expect(addNode).not.toHaveBeenCalled()

    act(() => testRoot.unmount())
    testRoot = createRoot(testContainer)

    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      {
        run: createRunSnapshot({ status: 'succeeded' }),
      },
    )
    expect(
      testContainer.querySelector<HTMLButtonElement>(
        'button[aria-label="Add node: Condition"]',
      )!.disabled,
    ).toBe(false)
    expect(
      testContainer.querySelector<HTMLButtonElement>(
        'button[aria-label="Save"]',
      )!.disabled,
    ).toBe(false)
    expect(
      testContainer.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Markdown content"]',
      )!.disabled,
    ).toBe(false)
    expect(
      testContainer.querySelector<HTMLInputElement>(
        '.yolo-workflow-node-inspector input[value="Input"]',
      )!.disabled,
    ).toBe(false)

    await act(async () => {
      testContainer
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Add node: Condition"]',
        )!
        .click()
      await Promise.resolve()
    })
    expect(addNode).toHaveBeenCalledTimes(1)
  })

  it('disables workflow deletion during an active run and restores it after', async () => {
    const { model, trashCurrent } = createModel({ bundle: createValidBundle() })
    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      {
        run: createRunSnapshot({ status: 'running' }),
      },
    )

    const deleteButton = testContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete workflow"]',
    )
    expect(deleteButton).not.toBeNull()
    expect(deleteButton!.disabled).toBe(true)

    await act(async () => {
      deleteButton!.click()
      await Promise.resolve()
    })
    expect(trashCurrent).not.toHaveBeenCalled()

    act(() => testRoot.unmount())
    testRoot = createRoot(testContainer)

    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      {
        run: createRunSnapshot({ status: 'succeeded' }),
      },
    )
    expect(
      testContainer.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete workflow"]',
      )!.disabled,
    ).toBe(false)
  })

  it('reuses the editor selection when a run node is clicked', async () => {
    const { model, selectNode } = createModel({ bundle: createValidBundle() })
    await renderStudio(
      model,
      jest.fn(),
      jest.fn(async () => true),
      {
        run: createRunSnapshot({ status: 'running' }),
      },
    )

    const runTab = Array.from(
      testContainer.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
    ).find((button) => button.textContent === 'Run')
    act(() => runTab!.click())

    const nodes = testContainer.querySelectorAll('.yolo-workflow-run-node')
    expect(nodes.length).toBe(2)
    act(() => {
      ;(nodes[1] as HTMLButtonElement).click()
    })

    expect(selectNode).toHaveBeenCalledWith('agent')
  })
})

async function renderStudio(
  model: WorkflowEditorModel,
  notice: jest.Mock = jest.fn(),
  confirm: jest.Mock = jest.fn(async () => true),
  options: Readonly<{
    agent?: YoloModuleHostApiV1['agent']
    models?: YoloModuleHostModelSnapshotV1
    run?: WorkflowRunSnapshot | null
    onStart?: jest.Mock
    onPause?: jest.Mock
    onCancel?: jest.Mock
    onContinue?: jest.Mock
    onRename?: jest.Mock
    onTestNode?: jest.Mock
  }> = {},
): Promise<void> {
  await act(async () => {
    testRoot.render(
      <WorkflowStudio
        model={model}
        copy={createWorkflowCopy('en')}
        openFile={jest.fn()}
        notice={notice}
        confirm={confirm}
        agent={options.agent ?? createDefaultReviewAgent(model)}
        models={
          options.models ?? {
            defaultModelId: 'provider/model',
            models: [
              { id: 'provider/model', name: 'Model', providerId: 'provider' },
            ],
          }
        }
        run={options.run ?? null}
        onStart={options.onStart ?? jest.fn()}
        onPause={options.onPause ?? jest.fn()}
        onCancel={options.onCancel ?? jest.fn()}
        onContinue={options.onContinue ?? jest.fn()}
        onRename={options.onRename ?? jest.fn(async () => true)}
        onTestNode={options.onTestNode}
      />,
    )
    await Promise.resolve()
  })
}

type AgentRequest = Parameters<YoloModuleHostApiV1['agent']['stream']>[0]

function createDefaultReviewAgent(
  model: WorkflowEditorModel,
): YoloModuleHostApiV1['agent'] {
  return {
    stream: async function* (request: AgentRequest) {
      const content = model.getSnapshot().bundle?.document.content
      if (content) {
        await request.tools?.[0]?.handler({
          content: `${content}\nReviewed by the assistant.\n`,
        })
      }
      yield { type: 'completed' as const, text: '' }
    },
  }
}

async function flushAssistant(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.bind(input)
  setValue?.(value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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
  rename: jest.Mock
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
  const rename = jest.fn(async () => true)
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
    rename,
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
    rename,
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

function createValidBundle(): WorkflowBundle {
  const copy = createWorkflowCopy('en')
  const source = createTopology()
  const output: WorkflowNode = {
    id: 'output',
    kind: 'output',
    label: 'Output',
    stepPath: 'steps/output/STEP.md',
    position: { x: 560, y: 90 },
  }
  const topology: WorkflowTopology = {
    revision: 1,
    nodes: [...source.nodes, output],
    edges: [
      ...source.edges,
      { id: 'agent-output', source: 'agent', target: 'output' },
    ],
  }
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
