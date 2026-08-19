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

type AgentRequestSnapshot = Readonly<{
  modelId?: string
  prompt?: string
  toolNames: readonly string[]
}>

type BackgroundActivitySnapshot = Readonly<{
  id: string
  title?: string
  status?: string
  detail?: string
}>

type ConfirmCallSnapshot = Readonly<{ title: string; message: string }>

/**
 * One scripted agent call on the run path. A reject entry hands the
 * run-scoped submit_workflow_output tool a value it must refuse (repair
 * round 1); an accept entry hands it the accepted value (round 2). The fake
 * agent consumes one entry per agent stream call.
 */
type RunScriptEntry = Readonly<{
  rejectValue?: unknown
  acceptValue?: unknown
}>

/** Token usage reported on the fake agent's completed events. */
type RunUsageSnapshot = Readonly<{
  inputTokens: number
  outputTokens: number
  totalTokens: number
}>

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
  // Phase-2 run harness: per-test agent behavior controls.
  holdRun: boolean
  failRun: boolean
  runErrorMessage: string
  runOutput: unknown
  confirmResult: boolean
  releaseRun(): void
  lastAgentRequest(): AgentRequestSnapshot | null
  backgroundActivities(): readonly BackgroundActivitySnapshot[]
  confirmCalls(): readonly ConfirmCallSnapshot[]
  listRunFiles(): Promise<readonly string[]>
  readRunFile(workflowPath: string): Promise<unknown>
  seedRun(
    workflowPath: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<void>
  // Phase-3 run harness: scriptable submission rounds (repair), usage, and
  // module config (tier routing).
  setRunScript(script: readonly RunScriptEntry[]): void
  setRunUsage(usage: RunUsageSnapshot | null): void
  setConfigData(partial: Readonly<Record<string, unknown>>): void
  /** Path of the seeded workflow whose agent node carries verification. */
  verifiedManifestPath: string
}

let assistantRelease: (() => void) | null = null
let assistantStarted = false
let runRelease: (() => void) | null = null
const agentRequests: AgentRequestSnapshot[] = []
const backgroundActivities = new Map<
  string,
  { title?: string; status?: string }
>()
const confirmCalls: ConfirmCallSnapshot[] = []
let runScript: readonly RunScriptEntry[] = []
const DEFAULT_RUN_USAGE: RunUsageSnapshot = Object.freeze({
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
})
let runUsage: RunUsageSnapshot | null = DEFAULT_RUN_USAGE
let configData: Record<string, unknown> = {}

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
      // The demo agent carries an output schema so full runs and node tests
      // exercise the executor's submit_workflow_output tool path.
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
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

/** The seeded alternate workflow: same shape as the demo, plus a hard
 * verification postcondition on its agent node so verification runs are
 * scriptable through the default run output. The verification schema is
 * stricter than the output schema (ok must be true), so a schema-valid
 * submission can still fail verification: `{ ok: false }` passes the output
 * schema but trips the hard postcondition. */
const VERIFIED_MANIFEST_PATH = 'workflows/verified/WORKFLOW.md'
const verifiedTopology: WorkflowTopology = {
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
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      verification: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean', const: true } },
          required: ['ok'],
        },
        mode: 'hard',
      },
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
  holdRun: false,
  failRun: false,
  runErrorMessage: 'Browser harness agent failure',
  runOutput: { ok: true },
  confirmResult: true,
  releaseRun: () => {
    runRelease?.()
    runRelease = null
  },
  lastAgentRequest: () => agentRequests.at(-1) ?? null,
  backgroundActivities: () =>
    [...backgroundActivities.entries()].map(([id, activity]) => ({
      id,
      ...activity,
    })),
  confirmCalls: () => [...confirmCalls],
  listRunFiles: () => listRunFiles(),
  readRunFile: (workflowPath) => readRunFile(workflowPath),
  seedRun: (workflowPath, patch) => seedRun(workflowPath, patch),
  setRunScript: (script) => {
    runScript = [...script]
  },
  setRunUsage: (usage) => {
    runUsage = usage
  },
  setConfigData: (partial) => {
    configData = { ...configData, ...partial }
  },
  verifiedManifestPath: VERIFIED_MANIFEST_PATH,
}

let openFilePath: string | null = null
let noticeMessage: string | null = null

// ---------------------------------------------------------------------------
// Device-local run persistence. The blobs map backs the module's run store;
// it is mirrored to localStorage so a seeded run record survives the page
// reload the recovery test relies on.
// ---------------------------------------------------------------------------

const BLOBS_STORAGE_KEY = 'yolo-workflow-e2e-device-local'
const blobs = new Map<string, string>()

function persistBlobs(): void {
  try {
    window.localStorage.setItem(
      BLOBS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(blobs)),
    )
  } catch {
    // The harness never depends on persistence succeeding.
  }
}

function hydrateBlobs(): void {
  try {
    const raw = window.localStorage.getItem(BLOBS_STORAGE_KEY)
    if (raw === null) return
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') blobs.set(key, value)
    }
  } catch {
    // A malformed store hydrates to an empty device-local scope.
  }
}

function writeBlob(key: string, value: string): void {
  blobs.set(key, value)
  persistBlobs()
}

function removeBlob(key: string): boolean {
  const removed = blobs.delete(key)
  if (removed) persistBlobs()
  return removed
}

async function runFileKey(workflowPath: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(workflowPath),
  )
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `runs/${hex}.json`
}

async function listRunFiles(): Promise<readonly string[]> {
  return [...blobs.keys()].filter((key) => key.startsWith('runs/')).sort()
}

async function readRunFile(workflowPath: string): Promise<unknown> {
  const raw = blobs.get(await runFileKey(workflowPath))
  return raw === undefined ? null : (JSON.parse(raw) as unknown)
}

/** A persisted run record for the demo workflow, valid per the run store. */
function seededDefinition(workflowPath: string): Record<string, unknown> {
  const stepContents: Record<string, string> = {}
  const modelByNodeId: Record<string, string> = {}
  for (const node of topology.nodes) {
    stepContents[node.id] = `# ${node.label}\n`
    modelByNodeId[node.id] = 'browser-model'
  }
  return {
    workflowPath,
    workflowContextMarkdown: '',
    topology,
    stepContents,
    modelByNodeId,
    policy: {
      capability: 'vault-write',
      mapConcurrency: 3,
      mergeStrategy: 'concat',
    },
    definitionHash: `seeded-${workflowPath}`,
  }
}

async function seedRun(
  workflowPath: string,
  patch: Readonly<Record<string, unknown>>,
): Promise<void> {
  const pendingNodes: Record<string, { status: string }> = {}
  for (const node of topology.nodes)
    pendingNodes[node.id] = { status: 'pending' }
  const nodes =
    patch.nodes !== undefined &&
    typeof patch.nodes === 'object' &&
    patch.nodes !== null
      ? (patch.nodes as Record<string, { status: string }>)
      : pendingNodes
  const snapshot = {
    schemaVersion: 1,
    runId:
      typeof patch.runId === 'string'
        ? patch.runId
        : `seeded-${Math.random().toString(36).slice(2)}`,
    workflowPath,
    definition: seededDefinition(workflowPath),
    input: patch.input ?? null,
    status: patch.status,
    nodes,
    outputs: patch.outputs ?? {},
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    // Carry the phase-3 run fields through: a recovered paused run (legal
    // only on a running record) and seeded token usage must survive the
    // store validator on reload.
    ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
    ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
    startedAt:
      typeof patch.startedAt === 'number' ? patch.startedAt : Date.now(),
  }
  writeBlob(await runFileKey(workflowPath), JSON.stringify(snapshot))
}

const manifest = updateWorkflowManagedBlocks('# Demo\n', topology, copy)
putFile(state.manifestPath, manifest)
putFile('workflows/demo/steps/input/STEP.md', '# Input\n')
putFile('workflows/demo/steps/agent/STEP.md', '# Agent\n')
putFile('workflows/demo/steps/output/STEP.md', '# Output\n')
const verifiedManifest = updateWorkflowManagedBlocks(
  '# Verified\n',
  verifiedTopology,
  copy,
)
putFile(VERIFIED_MANIFEST_PATH, verifiedManifest)
putFile('workflows/verified/steps/input/STEP.md', '# Input\n')
putFile('workflows/verified/steps/agent/STEP.md', '# Agent\n')
putFile('workflows/verified/steps/output/STEP.md', '# Output\n')
hydrateBlobs()

async function mount(): Promise<void> {
  const moduleDefinition = (
    window as unknown as {
      __workflowModuleDefinition?: { activate(host: unknown): Promise<void> }
    }
  ).__workflowModuleDefinition
  if (!moduleDefinition) throw new Error('workflow module was not registered')

  const host = createHost()
  await moduleDefinition.activate(host)
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
}
void mount()

function createHost(): unknown {
  const models = {
    defaultModelId: 'browser-model',
    models: [
      { id: 'browser-model', name: 'Browser model', providerId: 'browser' },
      { id: 'deepseek-model', name: 'DeepSeek model', providerId: 'deepseek' },
    ],
  }
  const deviceLocalScope = {
    list: async (directoryPrefix?: string): Promise<readonly string[]> => {
      const prefix = directoryPrefix === undefined ? '' : `${directoryPrefix}/`
      return [...blobs.keys()].filter((key) => key.startsWith(prefix)).sort()
    },
    readText: async (key: string): Promise<string | null> =>
      blobs.get(key) ?? null,
    writeText: async (key: string, value: string): Promise<void> => {
      writeBlob(key, value)
    },
    removeFile: async (key: string): Promise<boolean> => removeBlob(key),
  }
  return {
    agent: {
      stream: async function* (request: {
        modelId?: string
        prompt?: string
        systemPrompt?: string
        capability?: string
        activity?: Readonly<{ title?: string; detail?: string }>
        tools?: readonly [
          {
            name?: string
            handler(
              value: Record<string, unknown>,
            ): Promise<{ isError?: boolean; content: string }>
          },
        ]
        signal?: AbortSignal
      }) {
        agentRequests.push({
          modelId: request.modelId,
          prompt: request.prompt,
          toolNames: (request.tools ?? []).map((tool) => tool.name ?? ''),
        })
        const tool = request.tools?.[0]
        if (tool?.name === 'submit_workflow_proposal') {
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
          const result = await tool.handler({
            content: `${state.readManifest()}\nReviewed by browser harness.\n`,
          })
          if (result.isError) {
            yield { type: 'error', message: result.content }
            return
          }
          yield { type: 'completed', text: '' }
          return
        }
        // Run path: the executor submits structured results through
        // submit_workflow_output (schema nodes) or finishes in plain text
        // (text nodes and node tests); condition submissions carry one
        // boolean per active source id.
        if (tool)
          yield {
            type: 'tool',
            name: tool.name,
            status: 'awaiting_approval',
            arguments: {},
          }
        if (state.holdRun) {
          await new Promise<void>((resolve) => {
            runRelease = resolve
            request.signal?.addEventListener(
              'abort',
              () => {
                runRelease = null
                resolve()
              },
              { once: true },
            )
          })
        }
        if (request.signal?.aborted) return
        if (state.failRun) {
          yield { type: 'error', message: state.runErrorMessage }
          return
        }
        if (tool) {
          // Scripted submission rounds (phase-3 repair): one entry is
          // consumed per agent stream call. A reject entry submits a value
          // the run-scoped submit_workflow_output tool refuses, mirrors the
          // host dispatcher by surfacing a `tool` error event for that call,
          // and still ends the stream normally so the executor's repair
          // predicate sees round 1 end cleanly with rejections; an accept
          // entry submits the accepted value in the following call.
          const entry: RunScriptEntry | undefined =
            tool.name === 'submit_workflow_output' ? runScript[0] : undefined
          if (entry !== undefined) {
            runScript = runScript.slice(1)
            const value =
              'rejectValue' in entry ? entry.rejectValue : entry.acceptValue
            const scripted = await tool.handler({ value })
            yield {
              type: 'tool',
              name: tool.name,
              status: scripted.isError ? 'error' : 'completed',
            }
            yield {
              type: 'completed',
              text: '',
              ...(runUsage ? { usage: runUsage } : {}),
            }
            return
          }
          const input =
            tool.name === 'submit_workflow_condition'
              ? conditionSubmission(request.prompt)
              : { value: state.runOutput }
          const result = await tool.handler(input)
          if (result.isError) {
            yield { type: 'error', message: result.content }
            return
          }
          yield { type: 'tool', name: tool.name, status: 'completed' }
          yield {
            type: 'completed',
            text: '',
            ...(runUsage ? { usage: runUsage } : {}),
          }
          return
        }
        yield {
          type: 'completed',
          text:
            typeof state.runOutput === 'string'
              ? state.runOutput
              : JSON.stringify(state.runOutput),
          ...(runUsage ? { usage: runUsage } : {}),
        }
      },
    },
    chat: {
      registerMode: () => undefined,
    },
    lifecycle: { add: () => undefined, onQuiesce: () => undefined },
    privateStorage: { deviceLocal: deviceLocalScope },
    background: {
      upsert: (activity: {
        id: string
        title?: string
        status?: string
        detail?: string
      }) => {
        backgroundActivities.set(activity.id, {
          title: activity.title,
          status: activity.status,
          ...(activity.detail !== undefined ? { detail: activity.detail } : {}),
        })
      },
      remove: (id: string) => {
        backgroundActivities.delete(id)
      },
    },
    workspace: {
      registerView: (view: E2EState['view']) => {
        state.view = view
      },
      registerRibbonAction: () => undefined,
      registerCommand: () => undefined,
      openView: async () => undefined,
    },
    config: {
      // The run path reads the tier model map from the module config
      // document; an unconfigured document behaves exactly like a host
      // without settings. Tests configure tier routing with setConfigData.
      getSnapshot: () => ({ schemaVersion: 1, data: configData }),
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
      confirm: async (options: { title: string; message: string }) => {
        confirmCalls.push({ title: options.title, message: options.message })
        return state.confirmResult
      },
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
      // File-only move, like the real host API: the destination parent must
      // already exist (the repository ensures it before each call), and
      // putFile keeps the folder state consistent for the target side.
      renamePath: async (oldPath: string, newPath: string) => {
        const content = state.files.get(oldPath)
        if (content === undefined)
          throw new Error(`renamePath: source file not found: ${oldPath}`)
        state.files.delete(oldPath)
        putFile(newPath, content)
      },
      // Removes a folder only when it has no file or folder children.
      removeEmptyFolderExact: async (folder: string) => {
        if (!state.folders.has(folder)) return false
        const prefix = `${folder}/`
        const hasChildren = [...state.folders, ...state.files.keys()].some(
          (candidate) => candidate.startsWith(prefix) && candidate !== folder,
        )
        if (hasChildren) return false
        state.folders.delete(folder)
        return true
      },
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

/**
 * The condition submission tool requires one boolean per active upstream
 * source id; the executor embeds the sources in the prompt. The coordinator
 * judges condition nodes locally, so this path is defensive completeness.
 */
function conditionSubmission(prompt?: string): Record<string, boolean> {
  try {
    const value = JSON.parse(prompt ?? '') as {
      upstream?: readonly { nodeId?: unknown }[]
    }
    const input: Record<string, boolean> = {}
    for (const source of value.upstream ?? []) {
      if (typeof source?.nodeId === 'string') input[source.nodeId] = true
    }
    return input
  } catch {
    return {}
  }
}
