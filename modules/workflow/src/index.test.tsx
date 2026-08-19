import type { ReactElement } from 'react'

import { updateWorkflowManagedBlocks } from './domain/workflow-document'
import type { WorkflowTopology } from './domain/workflow-model'
import { createWorkflowCopy } from './i18n'
import type { WorkflowEditorModel } from './ui/workflow-editor-model'

type WorkflowModuleDefinition = Readonly<{
  activate(host: YoloModuleHostApiV1): void | Promise<void>
}>

let moduleDefinition: WorkflowModuleDefinition | null = null

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
})

function createViewContext(id: string) {
  return {
    id,
    document: {} as Document,
    window: {} as Window,
    lifecycle: { add: jest.fn() },
  }
}

function fakeHost(): RegistrationHost {
  return {
    agent: { stream: jest.fn() },
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
      getSnapshot: () => ({ locale: 'zh-CN' }),
      subscribe: jest.fn(() => () => undefined),
    },
    ui: {
      notice: jest.fn(),
      openFileAt: jest.fn(async () => true),
    },
    paths: {
      getSnapshot: () => ({ contentRoot: 'managed/workflows' }),
      subscribe: jest.fn(() => () => undefined),
    },
    privateStorage: {
      synchronized: fakePrivateStorageScope(),
      deviceLocal: fakePrivateStorageScope(),
    },
    settings: {
      getModelSnapshot: () => ({ defaultModelId: '', models: [] }),
      subscribeModels: jest.fn(() => () => undefined),
    },
    vault: {
      listChildren: jest.fn(() => []),
      subscribe: jest.fn(() => () => undefined),
    },
  } as unknown as RegistrationHost
}

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

type RegistrationHost = Omit<YoloModuleHostApiV1, 'chat' | 'workspace'> & {
  chat: { registerMode: jest.Mock }
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
}

function fakeWorkflowHost(): RegistrationHost {
  const copy = createWorkflowCopy('en')
  const topology: WorkflowTopology = {
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
  const stepSnapshots = new Map(
    topology.nodes.map((node) => [
      `managed/workflows/demo/${node.stepPath}`,
      {
        path: `managed/workflows/demo/${node.stepPath}`,
        content: `# ${node.label}\n`,
      },
    ]),
  )
  const host = fakeHost()
  return {
    ...host,
    vault: {
      ...host.vault,
      listChildren: jest.fn((path: string) => {
        if (path === 'managed/workflows')
          return [
            {
              kind: 'folder' as const,
              path: 'managed/workflows/demo',
              name: 'demo',
            },
          ]
        if (path === 'managed/workflows/demo')
          return [
            {
              kind: 'file' as const,
              path: manifestPath,
              name: 'WORKFLOW.md',
              extension: 'md',
              basename: 'WORKFLOW',
              ctime: 0,
              mtime: 0,
              size: manifestSnapshot.content.length,
            },
          ]
        return []
      }),
      readTextSnapshot: jest.fn(async (path: string) =>
        path === manifestPath
          ? manifestSnapshot
          : (stepSnapshots.get(path) ?? null),
      ),
    },
  } as unknown as RegistrationHost
}
