export type WorkflowSeverity = 'error' | 'warning' | 'info'
export type WorkflowCopy = Readonly<{
  module: Readonly<{ name: string; open: string }>
  mode: Readonly<{ description: string; persona: string }>
  chatTool: Readonly<{
    readDescription: string
    createDescription: string
  }>
  studio: Readonly<{
    title: string
    editorOnly: string
    sessionBoundary: string
    synced: string
  }>
  state: Readonly<{
    loading: string
    empty: string
    error: string
    conflict: string
  }>
  toolbar: Readonly<
    Record<
      | 'create'
      | 'read'
      | 'update'
      | 'delete'
      | 'import'
      | 'export'
      | 'save'
      | 'apply'
      | 'undo'
      | 'redo'
      | 'layout'
      | 'fit'
      | 'zoomIn'
      | 'zoomOut'
      | 'flow',
      string
    >
  >
  rail: Readonly<
    Record<
      | 'workflows'
      | 'documents'
      | 'steps'
      | 'addNode'
      | 'master'
      | 'stepWorkspaces'
      | 'docsFirst'
      | 'dragHint',
      string
    >
  >
  inspector: Readonly<
    Record<
      | 'title'
      | 'id'
      | 'label'
      | 'kind'
      | 'stepPath'
      | 'stage'
      | 'model'
      | 'gate'
      | 'predicate'
      | 'inputPredicates'
      | 'outputSchema'
      | 'source'
      | 'target'
      | 'markdownContent'
      | 'deleteNode',
      string
    >
  >
  nodeKind: Readonly<
    Record<
      'input' | 'agent' | 'mapAgent' | 'condition' | 'merge' | 'output',
      string
    >
  >
  gateType: Readonly<
    Record<
      'ifElse' | 'and' | 'or' | 'not' | 'nand' | 'nor' | 'xor' | 'xnor',
      string
    >
  >
  branchLabel: Readonly<
    Record<
      'true' | 'false' | 'and' | 'or' | 'not' | 'nand' | 'nor' | 'xor' | 'xnor',
      string
    >
  >
  connection: Readonly<
    Record<
      | 'invalid'
      | 'duplicate'
      | 'branchRequired'
      | 'branchUsed'
      | 'gateMismatch'
      | 'gateLimit',
      string
    >
  >
  finding: Readonly<{
    title: string
    none: string
    severity: Readonly<Record<WorkflowSeverity, string>>
    invalidTopology: string
    invalidStructure: string
    cycle: string
    unreachable: string
  }>
  assistant: Readonly<
    Record<
      | 'title'
      | 'model'
      | 'instruction'
      | 'validate'
      | 'optimize'
      | 'cancel'
      | 'proposal'
      | 'accept'
      | 'reject'
      | 'stale'
      | 'failure'
      | 'manual'
      | 'optimizeDocument'
      | 'optimizeWorkflow'
      | 'proposalEmpty'
      | 'changes',
      string
    >
  >
  document: Readonly<
    Record<
      'workflowTitle' | 'structureTitle' | 'topologyTitle' | 'step',
      string
    >
  >
  chatToolError: Readonly<
    Record<
      | 'invalidWorkflow'
      | 'missingWorkflow'
      | 'invalidDocument'
      | 'importFailed'
      | 'applyFailed'
      | 'invalidInput'
      | 'notFound'
      | 'targetExists',
      string
    >
  >
}>

export type WorkflowLocale = 'en' | 'zh' | 'it'
export type WorkflowLocalizedTextKey =
  | 'module.name'
  | 'module.open'
  | 'mode.description'

import { en } from './en'
import { it } from './it'
import { zh } from './zh'

const copies: Readonly<Record<WorkflowLocale, WorkflowCopy>> = { en, zh, it }

export function normalizeWorkflowLocale(locale: string): WorkflowLocale {
  const normalized = locale.trim().toLowerCase()
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('it')) return 'it'
  return 'en'
}

export function createWorkflowCopy(locale: string): WorkflowCopy {
  return copies[normalizeWorkflowLocale(locale)]
}

export function createWorkflowLocalizedText(
  key: WorkflowLocalizedTextKey,
): Readonly<Record<WorkflowLocale, string>> {
  return Object.freeze({
    en: textFor(en, key),
    zh: textFor(zh, key),
    it: textFor(it, key),
  })
}

function textFor(copy: WorkflowCopy, key: WorkflowLocalizedTextKey): string {
  const [section, field] = key.split('.') as [
    'module' | 'mode',
    'name' | 'open' | 'description',
  ]
  return copy[section][field as never] as string
}

export { en, it, zh }
