/** @jest-environment jsdom */

// eslint-disable-next-line import/no-nodejs-modules -- 测试环境 jsdom 不提供 WebCrypto subtle，store 与定义构建的哈希需要它
import { webcrypto } from 'crypto'

import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

import { updateWorkflowManagedBlocks } from './domain/workflow-document'
import type { WorkflowTopology } from './domain/workflow-model'
import { createWorkflowRepository } from './domain/workflow-repository'
import { createWorkflowDefinition } from './execution/workflow-definition'
import type { WorkflowRunCoordinatorWithNodeTests } from './execution/workflow-run-coordinator'
import { createWorkflowRunStore } from './execution/workflow-run-store'
import type { WorkflowRunSnapshot } from './execution/workflow-run-types'
import { createWorkflowCopy } from './i18n'
import type { WorkflowEditorModel } from './ui/workflow-editor-model'

// jsdom's window.crypto exposes no WebCrypto `subtle`; the run store and the
// definition builder hash with crypto.subtle, so project Node's
// implementation onto the existing (jsdom) crypto object.
if (globalThis.crypto.subtle === undefined) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    value: webcrypto.subtle,
  })
}

type WorkflowModuleDefinition = Readonly<{
  activate(host: YoloModuleHostApiV1): void | Promise<void>
}>

let moduleDefinition: WorkflowModuleDefinition | null = null

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

describe('workflow module chat mode', () => {
  it('registers one localized workflow mode with the unified tools', async () => {
    const registerModule = jest.fn()
    Object.defineProperty(globalThis, 'yolo', {
      configurable: true,
      value: { registerModule },
    })
    const globalYolo = globalThis as typeof globalThis & {
      yolo: { registerModule: jest.Mock }
    }

    await import('./index')
    const definition = registerModule.mock
      .calls[0]?.[0] as WorkflowModuleDefinition
    moduleDefinition = definition
    const host = fakeHost()

    await definition.activate(host as unknown as YoloModuleHostApiV1)

    expect(globalYolo.yolo.registerModule).toHaveBeenCalledTimes(1)
    expect(host.chat.registerMode).toHaveBeenCalledTimes(1)
    expect(host.chat.registerMode).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'workflow',
        label: {
          en: 'Workflow Studio',
          zh: '\u6d41\u7a0b\u5de5\u4f5c\u5ba4',
          it: 'Studio del flusso di lavoro',
        },
        description: {
          en: 'Design and maintain document-driven agent workflows.',
          zh: '\u8bbe\u8ba1\u5e76\u7ef4\u62a4\u7531\u6587\u6863\u9a71\u52a8\u7684 Agent \u5de5\u4f5c\u6d41\u3002',
          it: 'Progetta e gestisci flussi di agenti basati su documenti.',
        },
        icon: 'workflow',
        capability: 'vault-write',
        personaPrompt: expect.stringContaining('workflow_read'),
        skills: ['skills/workflow/SKILL.md'],
      }),
    )

    const mode = host.chat.registerMode.mock.calls[0][0] as {
      tools: readonly YoloModuleHostChatModeToolV1[]
      personaPrompt: string
    }
    expect(mode.personaPrompt).toContain('workflow_create')
    expect(mode.tools.map((tool) => tool.name)).toEqual([
      'workflow_read',
      'workflow_create',
    ])
    expect(mode.tools[0]?.requiresApproval).toBeUndefined()
    expect(mode.tools[1]?.requiresApproval).toBeUndefined()
  })

  it('registers the model tier settings contribution at activation', async () => {
    const host = fakeHost()
    await moduleDefinition!.activate(host as unknown as YoloModuleHostApiV1)

    expect(host.settings.contribute).toHaveBeenCalledTimes(1)
    const contribution = host.settings.contribute.mock.calls[0][0] as {
      id: string
      title: string
      fields: readonly { key: string; type: string; name: string }[]
      localizations?: Readonly<Record<string, unknown>>
    }
    expect(contribution.id).toBe('workflow')
    expect(contribution.title).toBe('Workflow')
    expect(contribution.fields.map((field) => field.key)).toEqual([
      'tier.fast',
      'tier.balanced',
      'tier.deep',
    ])
    expect(contribution.fields.every((field) => field.type === 'model')).toBe(
      true,
    )
    // Every locale is localized with the mandatory English fallback.
    expect(contribution.localizations?.en).toBeDefined()
    expect(contribution.localizations?.zh).toBeDefined()
    expect(contribution.localizations?.it).toBeDefined()
  })

  it('routes node tier aliases through the config tier map into the run definition', async () => {
    const host = fakeWorkflowHost(tierTopology())
    host.i18n.getSnapshot = () => enLocaleSnapshot
    // A stable snapshot reference: useSyncExternalStore loops on fresh objects.
    const models = viewModelSnapshot()
    host.settings.getModelSnapshot = () => models
    host.config = {
      getSnapshot: () =>
        fakeConfigSnapshot({
          'tier.fast': 'default-model',
          'tier.balanced': 'default-model',
          'tier.deep': 'default-model',
        }),
      replace: jest.fn(async (next: unknown) => next),
      subscribe: jest.fn(() => () => undefined),
    }
    host.agent = {
      stream: async function* () {
        yield { type: 'completed', text: 'done' }
      },
    } as YoloModuleHostApiV1['agent']
    await moduleDefinition!.activate(host as unknown as YoloModuleHostApiV1)

    const view = host.workspace.registerView.mock.calls[0]?.[0] as {
      render(context: unknown): ReactElement<{ editor: WorkflowEditorModel }>
    }
    const element = view.render(createViewContext('workflow-view-1'))
    const { editor } = element.props
    const store = createWorkflowRunStore(host.privateStorage.deviceLocal)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(element)
        await editor.load('demo/WORKFLOW.md')
      })
      await act(async () => {
        clickButton(container, 'Run')
      })
      await act(async () => {
        const input = container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Run input"]',
        )
        expect(input).not.toBeNull()
        setTextareaValue(input!, 'proceed')
        clickRunButton(container)
      })
      await act(async () => {
        await until(async () => {
          const record = await store.read('demo/WORKFLOW.md')
          return record?.status === 'succeeded'
        })
      })
      const record = await store.read('demo/WORKFLOW.md')
      // The node's `fast` alias resolved through the config tier map, not the
      // run default.
      expect(record?.definition.modelByNodeId.agent).toBe('default-model')
      expect(host.ui.notice).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('fails run start with the tier message when no tier is configured', async () => {
    const host = fakeWorkflowHost(tierTopology())
    host.i18n.getSnapshot = () => enLocaleSnapshot
    // A stable snapshot reference: useSyncExternalStore loops on fresh objects.
    const models = viewModelSnapshot()
    host.settings.getModelSnapshot = () => models
    // The default fake config data has no tier fields.
    host.agent = {
      stream: async function* () {
        yield { type: 'completed', text: 'done' }
      },
    } as YoloModuleHostApiV1['agent']
    await moduleDefinition!.activate(host as unknown as YoloModuleHostApiV1)

    const view = host.workspace.registerView.mock.calls[0]?.[0] as {
      render(context: unknown): ReactElement<{ editor: WorkflowEditorModel }>
    }
    const element = view.render(createViewContext('workflow-view-1'))
    const { editor } = element.props
    const store = createWorkflowRunStore(host.privateStorage.deviceLocal)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(element)
        await editor.load('demo/WORKFLOW.md')
      })
      await act(async () => {
        clickButton(container, 'Run')
      })
      await act(async () => {
        const input = container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Run input"]',
        )
        expect(input).not.toBeNull()
        setTextareaValue(input!, 'proceed')
        clickRunButton(container)
        await until(async () => host.ui.notice.mock.calls.length > 0)
      })
      expect(host.ui.notice).toHaveBeenCalledWith(
        createWorkflowCopy('en').run.modelTierUnavailable,
      )
      // Preflight failed: no run record was created.
      expect(await store.read('demo/WORKFLOW.md')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('passes the shared coordinator and run selection layer into every Studio view', async () => {
    expect(moduleDefinition).not.toBeNull()
    const host = fakeWorkflowHost()
    await moduleDefinition!.activate(host as unknown as YoloModuleHostApiV1)

    const view = host.workspace.registerView.mock.calls[0]?.[0] as {
      render(context: unknown): ReactElement<{
        viewId: string
        coordinator: unknown
        runs: unknown
        editor: WorkflowEditorModel
      }>
    }
    const firstElement = view.render(createViewContext('workflow-view-1'))
    const secondElement = view.render(createViewContext('workflow-view-2'))

    expect(firstElement.props.viewId).toBe('workflow-view-1')
    expect(secondElement.props.viewId).toBe('workflow-view-2')
    expect(firstElement.props.coordinator).toBeDefined()
    expect(firstElement.props.coordinator).toBe(secondElement.props.coordinator)
    // One module-level run selection layer shared by every view.
    expect(firstElement.props.runs).toBeDefined()
    expect(firstElement.props.runs).toBe(secondElement.props.runs)
    expect(host.lifecycle.onQuiesce).toHaveBeenCalledTimes(1)
  })

  it('keeps dirty editor state when the host restores the current view state', async () => {
    expect(moduleDefinition).not.toBeNull()
    const host = fakeWorkflowHost()
    await moduleDefinition!.activate(host as unknown as YoloModuleHostApiV1)

    const view = host.workspace.registerView.mock.calls[0]?.[0] as {
      render(context: unknown): ReactElement<{ editor: WorkflowEditorModel }>
      setState(
        state: Readonly<{ path?: unknown }>,
        context: unknown,
      ): Promise<void>
    }
    const viewContext = createViewContext('workflow-view-1')
    const viewElement = view.render(viewContext)
    const editor = viewElement.props.editor
    await editor.load('demo/WORKFLOW.md')
    const topology = editor.getSnapshot().topology
    expect(topology).not.toBeNull()
    editor.updateTopology({
      ...topology!,
      nodes: topology!.nodes.map((node) =>
        node.id === 'agent' ? { ...node, label: 'Changed' } : node,
      ),
    })
    expect(editor.getSnapshot().dirty).toBe(true)

    await view.setState({ path: 'demo/WORKFLOW.md' }, viewContext)

    expect(editor.getSnapshot().dirty).toBe(true)
  })

  it('creates independent editor state for independent view instances', async () => {
    expect(moduleDefinition).not.toBeNull()
    const host = fakeWorkflowHost()
    await moduleDefinition!.activate(host as unknown as YoloModuleHostApiV1)

    const view = host.workspace.registerView.mock.calls[0]?.[0] as {
      render(context: unknown): ReactElement<{ editor: WorkflowEditorModel }>
    }
    const firstElement = view.render(createViewContext('workflow-view-1'))
    const secondElement = view.render(createViewContext('workflow-view-2'))
    const firstEditor = firstElement.props.editor
    const secondEditor = secondElement.props.editor

    expect(firstEditor).not.toBe(secondEditor)
    await firstEditor.load('demo/WORKFLOW.md')
    await secondEditor.load('demo/WORKFLOW.md')
    const topology = firstEditor.getSnapshot().topology
    expect(topology).not.toBeNull()

    firstEditor.updateTopology({
      ...topology!,
      nodes: topology!.nodes.map((node) =>
        node.id === 'agent' ? { ...node, label: 'First view' } : node,
      ),
    })

    expect(firstEditor.getSnapshot().dirty).toBe(true)
    expect(secondEditor.getSnapshot().dirty).toBe(false)
  })

  it('confirms and retries a recovered paused run before resuming it', async () => {
    const host = fakeWorkflowHost()
    host.i18n.getSnapshot = () => enLocaleSnapshot
    host.ui.confirm = jest.fn(async () => true)
    host.agent = {
      stream: async function* () {
        yield { type: 'completed', text: 'done' }
      },
    } as YoloModuleHostApiV1['agent']

    // Seed a recovered running+paused record before activation: initialize()
    // publishes it into the module-level run selection layer, so the view
    // offers Resume without any in-memory run.
    const repository = createWorkflowRepository(
      host as unknown as YoloModuleHostApiV1,
    )
    const bundle = await repository.read('demo/WORKFLOW.md')
    expect(bundle).not.toBeNull()
    const built = await createWorkflowDefinition(bundle!, viewModelSnapshot())
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const store = createWorkflowRunStore(host.privateStorage.deviceLocal)
    await store.write({
      schemaVersion: 1,
      runId: 'recovered-run',
      workflowPath: 'demo/WORKFLOW.md',
      definition: built.definition,
      input: 'proceed',
      status: 'running',
      paused: true,
      nodes: {
        input: { status: 'succeeded', output: 'proceed' },
        agent: { status: 'running', startedAt: 1000 },
        output: { status: 'pending' },
      },
      outputs: {},
      startedAt: 1000,
    } satisfies WorkflowRunSnapshot)

    await moduleDefinition!.activate(host as unknown as YoloModuleHostApiV1)

    const view = host.workspace.registerView.mock.calls[0]?.[0] as {
      render(context: unknown): ReactElement<{
        editor: WorkflowEditorModel
        coordinator: WorkflowRunCoordinatorWithNodeTests
        runs: {
          getSnapshot(): Readonly<Record<string, WorkflowRunSnapshot>>
        }
      }>
    }
    const context = createViewContext('workflow-view-1')
    const element = view.render(context)
    const { editor, coordinator, runs } = element.props

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(element)
        await editor.load('demo/WORKFLOW.md')
      })
      // The recovered paused run is published as waiting in the background.
      expect(
        host.background.upsert.mock.calls.some(
          ([activity]) =>
            activity.id === 'workflow:run:demo/WORKFLOW.md' &&
            activity.status === 'waiting',
        ),
      ).toBe(true)

      await act(async () => {
        clickButton(container, 'Run')
      })
      const resume = findButton(container, 'Resume')
      expect(resume).not.toBeNull()
      await act(async () => {
        resume!.click()
      })

      // The view-level handler confirms once and retries with the
      // confirmation granted; the resumed run completes.
      await act(async () => {
        await until(async () => {
          const record = await store.read('demo/WORKFLOW.md')
          return record?.status === 'succeeded'
        })
      })

      expect(host.ui.confirm).toHaveBeenCalledTimes(1)
      expect(host.ui.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.any(String) }),
      )
      const record = await store.read('demo/WORKFLOW.md')
      expect(record?.runId).toBe('recovered-run')
      expect(record?.status).toBe('succeeded')
      expect(record?.nodes.agent.output).toBe('done')
      expect(runs.getSnapshot()['demo/WORKFLOW.md']?.status).toBe('succeeded')
      // The same coordinator surface refuses continuing a finished record.
      expect(
        await coordinator.continueRun('demo/WORKFLOW.md', {
          confirmSideEffects: true,
        }),
      ).toEqual({ ok: false, reason: 'not-continuable' })
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('rejects rename while a run is active and re-keys the run layer on success', async () => {
    const host = fakeWorkflowHost()
    host.i18n.getSnapshot = () => enLocaleSnapshot
    host.ui.confirm = jest.fn(async () => true)
    // The first agent call completes immediately; later calls (the fresh run
    // after the rename) hold until released, so the run is genuinely active
    // when the rename is attempted against it.
    let agentCalls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    host.agent = {
      stream: async function* () {
        agentCalls += 1
        if (agentCalls > 1) await gate
        yield { type: 'completed', text: 'done' }
      },
    } as YoloModuleHostApiV1['agent']
    await moduleDefinition!.activate(host as unknown as YoloModuleHostApiV1)

    const view = host.workspace.registerView.mock.calls[0]?.[0] as {
      render(context: unknown): ReactElement<{
        editor: WorkflowEditorModel
        coordinator: WorkflowRunCoordinatorWithNodeTests
        runs: {
          getSnapshot(): Readonly<Record<string, WorkflowRunSnapshot>>
        }
      }>
    }
    const context = createViewContext('workflow-view-1')
    const element = view.render(context)
    const { editor, coordinator, runs } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const store = createWorkflowRunStore(host.privateStorage.deviceLocal)

    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: viewModelSnapshot(),
      input: 'proceed',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await until(async () => {
      const record = await store.read('demo/WORKFLOW.md')
      return record?.status === 'succeeded'
    })
    expect(runs.getSnapshot()['demo/WORKFLOW.md']?.status).toBe('succeeded')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(element)
      })
      await act(async () => {
        clickButton(container, 'Rename workflow')
      })
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Rename workflow"]',
      )
      expect(input).not.toBeNull()
      await act(async () => {
        setInputValue(input!, 'renamed')
      })
      await act(async () => {
        container
          .querySelector<HTMLFormElement>('form.yolo-workflow-create-bar')
          ?.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.click()
      })
      // The lease wraps the file move and the record migration; the form
      // closes only after the migration lands under the new path.
      await act(async () => {
        await until(async () => {
          const record = await store.read('renamed/WORKFLOW.md')
          return record !== null
        })
      })

      expect(editor.getSnapshot().path).toBe('renamed/WORKFLOW.md')
      expect(await store.read('demo/WORKFLOW.md')).toBeNull()
      expect(runs.getSnapshot()['renamed/WORKFLOW.md']?.status).toBe(
        'succeeded',
      )
      // The stale old-path key was dropped from the shared run layer.
      expect(runs.getSnapshot()['demo/WORKFLOW.md']).toBeUndefined()
      expect(host.background.remove).toHaveBeenCalledWith(
        'workflow:run:demo/WORKFLOW.md',
      )
      // The lease was released and the coordinator surfaces the new path.
      expect(coordinator.isRenaming('demo/WORKFLOW.md')).toBe(false)
      expect(
        await coordinator.continueRun('renamed/WORKFLOW.md', {
          confirmSideEffects: true,
        }),
      ).toEqual({ ok: false, reason: 'not-continuable' })

      // Rename while a run is active is rejected up front. The Studio already
      // disables the rename button once the running snapshot publishes, so
      // the wiring-level check is exercised in the reservation window: the
      // run is reserved synchronously but not yet published, leaving the
      // toolbar enabled while `coordinator.isActive` is already true.
      const fresh = coordinator.start({
        workflowPath: 'renamed/WORKFLOW.md',
        bundle: {
          ...bundle!,
          path: 'renamed/WORKFLOW.md',
          files: bundle!.files.map((file) => ({
            ...file,
            relativePath: file.relativePath.replace('demo/', 'renamed/'),
            snapshot: {
              ...file.snapshot,
              path: file.snapshot.path.replace('demo/', 'renamed/'),
            },
          })),
        },
        modelSnapshot: viewModelSnapshot(),
        input: 'again',
      })
      // Each act flushes its own state updates; the run's reservation stays
      // unpublished because no await runs between the two acts.
      act(() => {
        clickButton(container, 'Rename workflow')
      })
      act(() => {
        const input = container.querySelector<HTMLInputElement>(
          'input[aria-label="Rename workflow"]',
        )
        expect(input).not.toBeNull()
        setInputValue(input!, 'blocked')
        container
          .querySelector<HTMLFormElement>('form.yolo-workflow-create-bar')
          ?.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.click()
      })
      // The active run refuses the rename with the running notice; the lease
      // is never taken and the editor path is untouched.
      expect(host.ui.notice).toHaveBeenCalledWith(
        createWorkflowCopy('en').run.cannotRenameWhileRunning,
      )
      expect(editor.getSnapshot().path).toBe('renamed/WORKFLOW.md')
      expect(coordinator.isRenaming('renamed/WORKFLOW.md')).toBe(false)
      await act(async () => {
        await fresh
        await until(async () => {
          const record = await store.read('renamed/WORKFLOW.md')
          return record?.nodes.agent.status === 'running'
        })
        release()
        await until(async () => {
          const record = await store.read('renamed/WORKFLOW.md')
          return record?.status === 'succeeded'
        })
      })
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})

function createViewContext(id: string) {
  return {
    id,
    document: {} as Document,
    window: {} as Window,
    lifecycle: { add: jest.fn() },
  }
}

const viewModelSnapshot = (): YoloModuleHostModelSnapshotV1 => ({
  defaultModelId: 'default-model',
  models: [
    { id: 'default-model', name: 'Default model', providerId: 'provider' },
  ],
})

/** Same demo workflow as fakeWorkflowHost with the agent node on the `fast` tier. */
const tierTopology = (): WorkflowTopology => ({
  revision: 1,
  nodes: [
    {
      id: 'input',
      kind: 'input',
      label: 'Input',
      stepPath: 'steps/input/STEP.md',
      position: { x: 70, y: 90 },
    },
    {
      id: 'agent',
      kind: 'agent',
      label: 'Agent',
      stepPath: 'steps/agent/STEP.md',
      position: { x: 315, y: 90 },
      modelId: 'fast',
    },
    {
      id: 'output',
      kind: 'output',
      label: 'Output',
      stepPath: 'steps/output/STEP.md',
      position: { x: 560, y: 90 },
    },
  ],
  edges: [
    { id: 'input-agent', source: 'input', target: 'agent' },
    { id: 'agent-output', source: 'agent', target: 'output' },
  ],
})

function findButton(
  container: HTMLElement,
  text: string,
): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  )
}

function clickButton(container: HTMLElement, text: string): void {
  const button = findButton(container, text)
  expect(button).not.toBeNull()
  button!.click()
}

/** The Run panel's start button; `findButton('Run')` would match the tab. */
function clickRunButton(container: HTMLElement): void {
  const button = container.querySelector<HTMLButtonElement>(
    '.yolo-workflow-run-controls__run',
  )
  expect(button).not.toBeNull()
  button!.click()
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.bind(input)
  setValue?.(value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set?.bind(textarea)
  setValue?.(value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

const until = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// useSyncExternalStore callers (the view's locale and model stores) require
// stable snapshot references, exactly like the real host's cached snapshots.
const zhLocaleSnapshot = Object.freeze({ locale: 'zh-CN' })
const enLocaleSnapshot = Object.freeze({ locale: 'en' })
const emptyModelSnapshot: YoloModuleHostModelSnapshotV1 = Object.freeze({
  defaultModelId: '',
  models: Object.freeze([]),
})

function fakeHost(): RegistrationHost {
  return {
    agent: { stream: jest.fn() },
    assets: { readText: jest.fn(async () => '') },
    background: { upsert: jest.fn(), remove: jest.fn() },
    chat: { registerMode: jest.fn() },
    lifecycle: {
      add: jest.fn(),
      whenActive: jest.fn(),
      onQuiesce: jest.fn(),
    },
    workspace: {
      registerView: jest.fn(),
      registerRibbonAction: jest.fn(),
      registerCommand: jest.fn(),
      openView: jest.fn(async () => undefined),
    },
    i18n: {
      getSnapshot: () => zhLocaleSnapshot,
      subscribe: jest.fn(() => () => undefined),
    },
    ui: {
      notice: jest.fn(),
      confirm: jest.fn(async () => true),
      openFileAt: jest.fn(async () => true),
    },
    paths: {
      getSnapshot: () => ({ contentRoot: 'managed/workflows' }),
      subscribe: jest.fn(() => () => undefined),
      runExclusive: jest.fn(
        async <T,>(_namespace: string, operation: () => T | PromiseLike<T>) =>
          operation(),
      ),
    },
    privateStorage: {
      synchronized: fakePrivateStorageScope(),
      deviceLocal: fakePrivateStorageScope(),
    },
    config: {
      getSnapshot: () => fakeConfigSnapshot({}),
      replace: jest.fn(async (next: unknown) => next),
      subscribe: jest.fn(() => () => undefined),
    },
    settings: {
      contribute: jest.fn(),
      getModelSnapshot: () => emptyModelSnapshot,
      subscribeModels: jest.fn(() => () => undefined),
    },
    vault: {
      listChildren: jest.fn(() => []),
      subscribe: jest.fn(() => () => undefined),
    },
  } as unknown as RegistrationHost
}

const fakeConfigSnapshot = (
  data: Readonly<Record<string, unknown>>,
): Readonly<{
  schemaVersion: number
  data: Readonly<Record<string, unknown>>
}> => Object.freeze({ schemaVersion: 1, data: Object.freeze({ ...data }) })

/**
 * In-memory ModulePrivateStorageScopeV1 stand-in recording every blob. The
 * module's run store only uses `list`/`readText`/`writeText`/`removeFile`;
 * the rest exists so the fixture matches the real scope shape.
 */
function fakePrivateStorageScope() {
  const blobs = new Map<string, string>()
  return {
    blobs,
    list: jest.fn(async (directoryPrefix?: string) => {
      const prefix = directoryPrefix === undefined ? '' : `${directoryPrefix}/`
      return [...blobs.keys()].filter((key) => key.startsWith(prefix)).sort()
    }),
    stat: jest.fn(async (key: string) =>
      blobs.has(key)
        ? { type: 'file' as const, size: blobs.get(key)!.length }
        : null,
    ),
    readJson: jest.fn(async (key: string) => {
      const raw = blobs.get(key)
      return raw === undefined ? null : (JSON.parse(raw) as unknown)
    }),
    readText: jest.fn(async (key: string) => blobs.get(key) ?? null),
    writeJson: jest.fn(async (key: string, value: unknown) => {
      blobs.set(key, JSON.stringify(value))
    }),
    writeText: jest.fn(async (key: string, value: string) => {
      blobs.set(key, value)
    }),
    mkdir: jest.fn(async () => undefined),
    removeFile: jest.fn(async (key: string) => blobs.delete(key)),
  }
}

type RegistrationHost = Omit<
  YoloModuleHostApiV1,
  | 'agent'
  | 'background'
  | 'chat'
  | 'config'
  | 'i18n'
  | 'settings'
  | 'ui'
  | 'workspace'
> & {
  agent: YoloModuleHostApiV1['agent']
  background: { upsert: jest.Mock; remove: jest.Mock }
  chat: { registerMode: jest.Mock }
  config: {
    getSnapshot(): FakeConfigSnapshot
    replace: jest.Mock
    subscribe: jest.Mock
  }
  workspace: {
    registerView: jest.Mock
    registerRibbonAction: jest.Mock
    registerCommand: jest.Mock
    openView: jest.Mock
  }
  lifecycle: {
    add: jest.Mock
    whenActive: jest.Mock
    onQuiesce: jest.Mock
  }
  i18n: {
    getSnapshot(): { locale: string }
    subscribe: jest.Mock
  }
  settings: {
    contribute: jest.Mock
    getModelSnapshot(): YoloModuleHostModelSnapshotV1
    subscribeModels: jest.Mock
  }
  ui: { notice: jest.Mock; confirm: jest.Mock; openFileAt: jest.Mock }
}

type FakeConfigSnapshot = Readonly<{
  schemaVersion: number
  data: Readonly<Record<string, unknown>>
}>

function fakeWorkflowHost(
  topologyOverride?: WorkflowTopology,
): RegistrationHost {
  const copy = createWorkflowCopy('en')
  const topology: WorkflowTopology = topologyOverride ?? {
    revision: 1,
    nodes: [
      {
        id: 'input',
        kind: 'input',
        label: 'Input',
        stepPath: 'steps/input/STEP.md',
        position: { x: 70, y: 90 },
      },
      {
        id: 'agent',
        kind: 'agent',
        label: 'Agent',
        stepPath: 'steps/agent/STEP.md',
        position: { x: 315, y: 90 },
      },
      {
        id: 'output',
        kind: 'output',
        label: 'Output',
        stepPath: 'steps/output/STEP.md',
        position: { x: 560, y: 90 },
      },
    ],
    edges: [
      { id: 'input-agent', source: 'input', target: 'agent' },
      { id: 'agent-output', source: 'agent', target: 'output' },
    ],
  }
  const manifestPath = 'managed/workflows/demo/WORKFLOW.md'
  const manifestSnapshot = {
    path: manifestPath,
    content: updateWorkflowManagedBlocks('# Demo\n', topology, copy),
  }
  const files = new Map<string, { path: string; content: string }>()
  files.set(manifestPath, manifestSnapshot)
  for (const node of topology.nodes) {
    const path = `managed/workflows/demo/${node.stepPath}`
    files.set(path, { path, content: `# ${node.label}\n` })
  }
  const host = fakeHost()
  return {
    ...host,
    vault: {
      ...host.vault,
      listChildren: jest.fn((folder: string) => {
        const prefix = `${folder}/`
        const children: Array<{
          kind: 'folder' | 'file'
          path: string
          name: string
        }> = []
        const seenFolders = new Set<string>()
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue
          const rest = path.slice(prefix.length)
          const slash = rest.indexOf('/')
          if (slash < 0) {
            children.push({ kind: 'file', path, name: rest })
          } else {
            const name = rest.slice(0, slash)
            if (!seenFolders.has(name)) {
              seenFolders.add(name)
              children.push({ kind: 'folder', path: `${folder}/${name}`, name })
            }
          }
        }
        return children
      }),
      readTextSnapshot: jest.fn(
        async (path: string) => files.get(path) ?? null,
      ),
      exists: jest.fn(
        async (path: string) =>
          files.has(path) ||
          [...files.keys()].some((candidate) =>
            candidate.startsWith(`${path}/`),
          ),
      ),
      ensureFolder: jest.fn(async () => undefined),
      renamePath: jest.fn(async (oldPath: string, newPath: string) => {
        const snapshot = files.get(oldPath)
        if (!snapshot) return
        files.delete(oldPath)
        files.set(newPath, { ...snapshot, path: newPath })
      }),
      removeEmptyFolderExact: jest.fn(async () => false),
    },
  } as unknown as RegistrationHost
}
