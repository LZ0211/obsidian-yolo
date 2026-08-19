import { extractWorkflowExecutionContext } from '../domain/workflow-document'
import type { WorkflowTopology } from '../domain/workflow-model'
import type { WorkflowBundle } from '../domain/workflow-repository'

import { canonicalJsonStringify } from './workflow-run-graph'
import type {
  WorkflowDefinitionSnapshot,
  WorkflowExecutionPolicy,
  WorkflowModelSnapshot,
  WorkflowRunError,
} from './workflow-run-types'
import { isJsonSchema } from './workflow-schema'

export type WorkflowDefinitionBuildResult =
  | Readonly<{ ok: true; definition: WorkflowDefinitionSnapshot }>
  | Readonly<{ ok: false; error: WorkflowRunError }>

export async function createWorkflowDefinition(
  bundle: WorkflowBundle,
  modelSnapshot: WorkflowModelSnapshot,
): Promise<WorkflowDefinitionBuildResult> {
  const invalid = (
    message: string,
    nodeId?: string,
  ): WorkflowDefinitionBuildResult => ({
    ok: false,
    error: {
      code: 'invalid-definition',
      message,
      ...(nodeId ? { nodeId } : {}),
    },
  })
  const unavailable = (
    message: string,
    nodeId?: string,
  ): WorkflowDefinitionBuildResult => ({
    ok: false,
    error: {
      code: 'model-unavailable',
      message,
      ...(nodeId ? { nodeId } : {}),
    },
  })

  if (bundle.document.issues.length > 0)
    return invalid(
      `Workflow "${bundle.path}" has issues: ${bundle.document.issues.join(', ')}`,
    )
  const topology = bundle.document.topology
  if (!topology)
    return invalid(`Workflow "${bundle.path}" has no valid topology`)
  if (bundle.path.trim().length === 0)
    return invalid('Workflow path must be non-empty')

  const fileByNodeId = new Map<string, string>()
  for (const file of bundle.files) {
    if (file.nodeId === 'workflow') continue
    if (file.nodeId.trim().length === 0)
      return invalid('Workflow step file node ids must be non-empty')
    if (fileByNodeId.has(file.nodeId))
      return invalid(`Duplicate step content for node "${file.nodeId}"`)
    fileByNodeId.set(file.nodeId, file.snapshot.content)
  }
  const stepContents: Record<string, string> = {}
  for (const node of topology.nodes) {
    const content = fileByNodeId.get(node.id)
    if (content === undefined)
      return invalid(`Workflow step content is missing for node "${node.id}"`)
    stepContents[node.id] = content
  }
  for (const nodeId of fileByNodeId.keys()) {
    if (!topology.nodes.some((node) => node.id === nodeId))
      return invalid(`Step content exists for unknown node "${nodeId}"`)
  }

  for (const node of topology.nodes) {
    if (node.outputSchema === undefined) continue
    if (!isJsonSchema(node.outputSchema))
      return invalid(`Node "${node.id}" has an invalid JSON Schema`, node.id)
  }

  if (modelSnapshot.defaultModelId.trim().length === 0)
    return unavailable('The run default model id must be non-empty')
  const modelIds = new Set(modelSnapshot.models.map((model) => model.id))
  if (!modelIds.has(modelSnapshot.defaultModelId))
    return unavailable(
      `The run default model "${modelSnapshot.defaultModelId}" is unavailable`,
    )
  const modelByNodeId: Record<string, string> = {}
  for (const node of topology.nodes) {
    const requested = node.modelId ?? ''
    const resolved = requested === '' ? modelSnapshot.defaultModelId : requested
    if (!modelIds.has(resolved))
      return unavailable(`Model "${resolved}" is unavailable`, node.id)
    modelByNodeId[node.id] = resolved
  }

  const mergeStrategy = deriveMergeStrategy(topology)
  if (!mergeStrategy.ok) return invalid(mergeStrategy.message)
  const policy: WorkflowExecutionPolicy = Object.freeze({
    capability: 'vault-write',
    mapConcurrency: 3,
    mergeStrategy: mergeStrategy.strategy,
  })

  const workflowContextMarkdown = extractWorkflowExecutionContext(
    bundle.document.content,
  )
  const topologyWithoutPositions = {
    revision: 1,
    nodes: topology.nodes.map(({ position: _position, ...node }) => node),
    edges: topology.edges,
  }
  const canonical = canonicalJsonStringify({
    workflowPath: bundle.path,
    workflowContextMarkdown,
    topology: topologyWithoutPositions,
    stepContents,
    modelByNodeId,
    policy,
  })
  const definitionHash = await sha256Hex(canonical)

  const frozenTopology = deepFreeze(
    JSON.parse(
      JSON.stringify({ ...topology, nodes: [...topology.nodes] }),
    ) as WorkflowTopology,
  )
  const frozenStepContents = Object.freeze({ ...stepContents })
  const frozenModelByNodeId = Object.freeze({ ...modelByNodeId })
  const definition: WorkflowDefinitionSnapshot = Object.freeze({
    workflowPath: bundle.path,
    workflowContextMarkdown,
    topology: frozenTopology,
    stepContents: frozenStepContents,
    modelByNodeId: frozenModelByNodeId,
    policy,
    definitionHash,
  })
  return { ok: true, definition }
}

function deriveMergeStrategy(
  topology: WorkflowTopology,
):
  | Readonly<{ ok: true; strategy: 'concat' | 'dedupe' }>
  | Readonly<{ ok: false; message: string }> {
  const declared = new Set(
    topology.nodes
      .filter(
        (node) => node.kind === 'merge' && node.mergeStrategy !== undefined,
      )
      .map((node) => node.mergeStrategy as 'concat' | 'dedupe'),
  )
  if (declared.size > 1)
    return {
      ok: false,
      message:
        'Workflow merge nodes declare conflicting merge strategies: ' +
        [...declared].join(', '),
    }
  return {
    ok: true,
    strategy: declared.size === 1 ? [...declared][0] : 'concat',
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child, seen)
  }
  return value
}
