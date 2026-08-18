import { createRoot } from 'react-dom/client'

import { updateWorkflowManagedBlocks } from '../../modules/workflow/src/domain/workflow-document'
import { createWorkflowCopy } from '../../modules/workflow/src/i18n'
import type { WorkflowTopology } from '../../modules/workflow/src/domain/workflow-model'

import '../../modules/workflow/src/index'

type Snapshot = Readonly<{ path: string; content: string }>
type Entry =
  | Readonly<{
      kind: 'file'
      path: string
      name: string
      extension: string
      basename: string
      ctime: number
      mtime: number
      size: number
    }>
  | Readonly<{ kind: 'folder'; path: string; name: string }>

type E2EState = {
  files: Map<string, string>
  folders: Set<string>
  manifestPath: string
  view: {
    render(context: unknown): React.ReactElement
  } | null
  readManifest(): string
  readFile(filePath: string): string
  hasFile(filePath: string): boolean
  listFiles(): string[]
  getOpenFile(): string | null
  getNotice(): string | null
  holdAssistant: boolean
  assistantStarted(): boolean
  releaseAssistant(): void
}

let assistantRelease: (() => void) | null = null
let assistantStarted = false
const copy = createWorkflowCopy('en')
const localeSnapshot = { locale: 'en' }
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

const state: E2EState = {
  files: new Map(),
  folders: new Set(['workflows', 'workflows/demo']),
  manifestPath: 'workflows/demo/WORKFLOW.md',
  view: null,
  readManifest: () => state.files.get(state.manifestPath) ?? '',
  readFile: (filePath) => state.files.get(filePath) ?? '',
  hasFile: (filePath) => state.files.has(filePath),
  listFiles: () => [...state.files.keys()].sort(),
  getOpenFile: () => openFilePath,
  getNotice: () => noticeMessage,
  holdAssistant: false,
  assistantStarted: () => assistantStarted,
  releaseAssistant: () => {
    assistantRelease?.()
    assistantRelease = null
  },
}

let openFilePath: string | null = null
let noticeMessage: string | null = null

const manifest = updateWorkflowManagedBlocks('# Demo\n', topology, copy)
putFile(state.manifestPath, manifest)
putFile('workflows/demo/steps/input/STEP.md', '# Input\n')
putFile('workflows/demo/steps/agent/STEP.md', '# Agent\n')
putFile('workflows/demo/steps/output/STEP.md', '# Output\n')

const moduleDefinition = (
  window as unknown as {
    __workflowModuleDefinition?: { activate(host: unknown): void }
  }
).__workflowModuleDefinition
if (!moduleDefinition) throw new Error('workflow module was not registered')

const host = createHost()
moduleDefinition.activate(host)
if (!state.view) throw new Error('workflow view was not registered')

const root = document.getElementById('root')
if (!root) throw new Error('workflow root was not found')
;(window as unknown as { __workflowE2E: E2EState }).__workflowE2E = state
createRoot(root).render(
  state.view.render({
    id: 'workflow-e2e-view',
    document,
    window,
    lifecycle: { add: () => undefined },
  }),
)

function createHost(): unknown {
  const models = {
    defaultModelId: 'browser-model',
    models: [
      { id: 'browser-model', name: 'Browser model', providerId: 'browser' },
    ],
  }
  return {
    agent: {
      stream: async function* (request: {
        tools?: readonly [
          {
            handler(
              value: Record<string, unknown>,
            ): Promise<{ isError?: boolean; content: string }>
          },
        ]
        signal?: AbortSignal
      }) {
        if (state.holdAssistant) {
          assistantStarted = true
          await new Promise<void>((resolve) => {
            assistantRelease = resolve
            request.signal?.addEventListener(
              'abort',
              () => {
                assistantRelease = null
                resolve()
              },
              { once: true },
            )
          })
        }
        const tool = request.tools?.[0]
        if (!tool) {
          yield { type: 'error', message: 'proposal tool missing' }
          return
        }
        const result = await tool.handler({
          content: `${state.readManifest()}\nReviewed by browser harness.\n`,
        })
        if (result.isError) {
          yield { type: 'error', message: result.content }
          return
        }
        yield { type: 'completed', text: '' }
      },
    },
    chat: {
      registerMode: () => undefined,
    },
    lifecycle: { add: () => undefined },
    workspace: {
      registerView: (view: E2EState['view']) => {
        state.view = view
      },
      registerRibbonAction: () => undefined,
      registerCommand: () => undefined,
      openView: async () => undefined,
    },
    i18n: {
      getSnapshot: () => localeSnapshot,
      subscribe: () => () => undefined,
    },
    assets: {
      readText: async (filePath: string) => {
        if (filePath === 'style.css')
          return '.yolo-workflow-studio { color: inherit; }'
        throw new Error(`unexpected asset: ${filePath}`)
      },
    },
    ui: {
      notice: (message: string) => {
        noticeMessage = message
        ;(window as unknown as { __workflowNotice?: string }).__workflowNotice =
          message
      },
      openFileAt: async (input: string | { path: string }) => {
        openFilePath = typeof input === 'string' ? input : input.path
        return true
      },
      confirm: async () => true,
    },
    paths: {
      getSnapshot: () => ({ contentRoot: 'workflows' }),
      subscribe: () => () => undefined,
      runExclusive: async (
        _namespace: string,
        operation: () => unknown | Promise<unknown>,
      ) => operation(),
    },
    settings: {
      getModelSnapshot: () => models,
      subscribeModels: () => () => undefined,
    },
    vault: {
      listChildren: (folder: string) => listChildren(folder),
      getEntry: (filePath: string) => entry(filePath),
      exists: async (filePath: string) =>
        state.files.has(filePath) || state.folders.has(filePath),
      readTextSnapshot: async (filePath: string) => snapshot(filePath),
      ensureFolder: async (folder: string) => {
        addFolder(folder)
      },
      createTextIfAbsent: async (filePath: string, content: string) => {
        if (state.files.has(filePath)) return null
        putFile(filePath, content)
        return snapshot(filePath)
      },
      replaceTextIfUnchanged: async (expected: Snapshot, content: string) => {
        if (state.files.get(expected.path) !== expected.content) return null
        putFile(expected.path, content)
        return snapshot(expected.path)
      },
      trashPath: async (target: string) => {
        const prefix = `${target}/`
        const matches = [...state.files.keys()].filter(
          (filePath) => filePath === target || filePath.startsWith(prefix),
        )
        for (const filePath of matches) state.files.delete(filePath)
        return matches.length > 0
      },
      removeFileExact: async (filePath: string) => state.files.delete(filePath),
      subscribe: () => () => undefined,
    },
  }
}

function addFolder(folder: string): void {
  const parts = folder.split('/').filter(Boolean)
  for (let index = 1; index <= parts.length; index++)
    state.folders.add(parts.slice(0, index).join('/'))
}

function putFile(filePath: string, content: string): void {
  addFolder(filePath.slice(0, filePath.lastIndexOf('/')))
  state.files.set(filePath, content)
}

function snapshot(filePath: string): Snapshot | null {
  const content = state.files.get(filePath)
  return content === undefined ? null : { path: filePath, content }
}

function entry(filePath: string): Entry | null {
  const content = state.files.get(filePath)
  if (content !== undefined) {
    const name = filePath.split('/').at(-1) ?? ''
    const dot = name.lastIndexOf('.')
    return {
      kind: 'file',
      path: filePath,
      name,
      extension: dot > 0 ? name.slice(dot + 1) : '',
      basename: dot > 0 ? name.slice(0, dot) : name,
      ctime: 0,
      mtime: 0,
      size: content.length,
    }
  }
  if (state.folders.has(filePath))
    return {
      kind: 'folder',
      path: filePath,
      name: filePath.split('/').at(-1) ?? '',
    }
  return null
}

function listChildren(folder: string): Entry[] {
  const prefix = folder ? `${folder}/` : ''
  const children = new Set<string>()
  for (const candidate of [...state.folders, ...state.files.keys()]) {
    if (!candidate.startsWith(prefix)) continue
    const remainder = candidate.slice(prefix.length)
    if (remainder && !remainder.includes('/')) children.add(candidate)
  }
  return [...children]
    .map((filePath) => entry(filePath))
    .filter((value): value is Entry => value !== null)
}
