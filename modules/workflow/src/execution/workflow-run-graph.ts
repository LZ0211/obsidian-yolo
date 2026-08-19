import type {
  WorkflowEdge,
  WorkflowGateType,
  WorkflowNode,
  WorkflowTopology,
} from '../domain/workflow-model'

import type {
  JsonValue,
  WorkflowExecutionPolicy,
  WorkflowNodeRun,
} from './workflow-run-types'

export type WorkflowSourceValue = Readonly<{
  nodeId: string
  edgeLabel?: string
  value: JsonValue
}>

/** Incoming edges for a node sorted by edge id for deterministic ordering. */
export function stableIncomingEdges(
  topology: WorkflowTopology,
  nodeId: string,
): readonly WorkflowEdge[] {
  return Object.freeze(
    topology.edges
      .filter((edge) => edge.target === nodeId)
      .sort((left, right) => left.id.localeCompare(right.id)),
  )
}

/**
 * Selects the incoming sources whose branch is active: a non-condition
 * source is active when it succeeded, a condition source only when the
 * edge branch matches its conditionResult.
 */
export function activeIncomingSources(
  node: WorkflowNode,
  topology: WorkflowTopology,
  nodeRuns: Readonly<Record<string, WorkflowNodeRun>>,
): readonly WorkflowSourceValue[] {
  const active: WorkflowSourceValue[] = []
  for (const edge of stableIncomingEdges(topology, node.id)) {
    const sourceNode = topology.nodes.find(
      (candidate) => candidate.id === edge.source,
    )
    const sourceRun = nodeRuns[edge.source]
    if (!sourceNode || !sourceRun || sourceRun.status !== 'succeeded') continue
    if (sourceNode.kind === 'condition') {
      if (!branchMatchesResult(edge, sourceRun)) continue
    }
    if (sourceRun.output === undefined) continue
    active.push({
      nodeId: edge.source,
      ...(edge.label === undefined ? {} : { edgeLabel: edge.label }),
      value: sourceRun.output,
    })
  }
  return Object.freeze(active)
}

function branchMatchesResult(
  edge: WorkflowEdge,
  run: WorkflowNodeRun,
): boolean {
  const result = run.conditionResult ?? false
  if (edge.branch === 'true') return result
  if (edge.branch === 'false') return !result
  if (edge.branch === undefined) return false
  return result
}

/**
 * Evaluates one of the eight gates. The condition data stays separate from
 * the boolean result: a single active source is passed through unchanged,
 * multiple sources become an object keyed by source node id.
 */
export function evaluateWorkflowGate(
  gateType: WorkflowGateType,
  sources: readonly WorkflowSourceValue[],
): Readonly<{ conditionResult: boolean; value: JsonValue }> {
  const values = sources.map((source) => source.value)
  let conditionResult: boolean
  switch (gateType) {
    case 'ifElse':
      if (values.length !== 1)
        throw new Error(
          `ifElse gate requires exactly one active source, got ${values.length}`,
        )
      conditionResult = Boolean(values[0])
      break
    case 'and':
      conditionResult = values.every(Boolean)
      break
    case 'nand':
      conditionResult = !values.every(Boolean)
      break
    case 'or':
      conditionResult = values.some(Boolean)
      break
    case 'nor':
      conditionResult = !values.some(Boolean)
      break
    case 'not':
      if (values.length !== 1)
        throw new Error(
          `not gate requires exactly one active source, got ${values.length}`,
        )
      conditionResult = !values[0]
      break
    case 'xor':
      conditionResult = values.filter(Boolean).length % 2 === 1
      break
    case 'xnor':
      conditionResult = values.filter(Boolean).length % 2 === 0
      break
  }
  const value: JsonValue =
    sources.length === 1
      ? sources[0].value
      : Object.fromEntries(
          sources.map((source) => [source.nodeId, source.value]),
        )
  return { conditionResult, value }
}

/** One-level concat of active source values in stable source order. */
export function mergeWorkflowSources(
  sources: readonly WorkflowSourceValue[],
  strategy: 'concat' | 'dedupe',
): JsonValue {
  const flattened = sources.flatMap((source) =>
    Array.isArray(source.value) ? [...source.value] : [source.value],
  )
  if (strategy === 'concat') return flattened
  const seen = new Set<string>()
  const deduped: JsonValue[] = []
  for (const entry of flattened) {
    const key = canonicalJsonStringify(entry)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(entry)
  }
  return deduped
}

/**
 * Canonical JSON: object keys sorted recursively, array order preserved,
 * undefined values omitted.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort())
      if (value[key] !== undefined) result[key] = canonicalize(value[key])
    return result
  }
  return value
}

/** Aggregates the values of succeeded output nodes by node id. */
export function aggregateWorkflowOutputs(
  topology: WorkflowTopology,
  nodeRuns: Readonly<Record<string, WorkflowNodeRun>>,
  policy: WorkflowExecutionPolicy,
): Readonly<Record<string, JsonValue>> {
  const outputs: Record<string, JsonValue> = {}
  for (const node of topology.nodes) {
    if (node.kind !== 'output') continue
    const sources = activeIncomingSources(node, topology, nodeRuns)
    if (sources.length === 0) continue
    outputs[node.id] =
      sources.length === 1
        ? sources[0].value
        : mergeWorkflowSources(sources, policy.mergeStrategy)
  }
  return Object.freeze(outputs)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
