export type WorkflowNodeKind =
  | 'input'
  | 'agent'
  | 'mapAgent'
  | 'condition'
  | 'merge'
  | 'output'
export type WorkflowGateType =
  | 'ifElse'
  | 'and'
  | 'or'
  | 'not'
  | 'nand'
  | 'nor'
  | 'xor'
  | 'xnor'
export type WorkflowBranch =
  | 'true'
  | 'false'
  | Exclude<WorkflowGateType, 'ifElse'>

export type WorkflowNode = Readonly<{
  id: string
  kind: WorkflowNodeKind
  label: string
  stepPath: string
  position: Readonly<{ x: number; y: number }>
  stage?: string
  modelId?: string
  gateType?: WorkflowGateType
  predicate?: string
  inputPredicates?: Readonly<Record<string, string>>
  outputSchema?: unknown
}>

export type WorkflowEdge = Readonly<{
  id: string
  source: string
  target: string
  branch?: WorkflowBranch
  label?: string
}>

export type WorkflowTopology = Readonly<{
  revision: 1
  nodes: readonly WorkflowNode[]
  edges: readonly WorkflowEdge[]
}>

export type WorkflowIssueCode =
  | 'invalidTopology'
  | 'invalidStructure'
  | 'duplicateNodeId'
  | 'duplicateEdgeId'
  | 'duplicateConnection'
  | 'danglingEdge'
  | 'selfEdge'
  | 'invalidBranch'
  | 'branchUsed'
  | 'gateLimit'
  | 'invalidGateArity'
  | 'missingInput'
  | 'missingOutput'
  | 'unreachable'
  | 'cycle'

export type WorkflowIssue = Readonly<{
  code: WorkflowIssueCode
  nodeId?: string
  edgeId?: string
}>
export type WorkflowConnectionProblem = Readonly<{
  code:
    | 'invalidConnection'
    | 'duplicateConnection'
    | 'branchRequired'
    | 'branchUsed'
    | 'gateMismatch'
    | 'gateLimit'
  gateType?: WorkflowGateType
  available?: readonly WorkflowBranch[]
}>
export type WorkflowConnectionCandidate = Readonly<{
  id?: string
  source: string
  target: string
  branch?: WorkflowBranch
}>

const NODE_KINDS = new Set<WorkflowNodeKind>([
  'input',
  'agent',
  'mapAgent',
  'condition',
  'merge',
  'output',
])
const GATE_TYPES = new Set<WorkflowGateType>([
  'ifElse',
  'and',
  'or',
  'not',
  'nand',
  'nor',
  'xor',
  'xnor',
])
const AUTO_FAN_OUT_GATES = new Set<WorkflowGateType>([
  'and',
  'or',
  'nand',
  'nor',
  'xor',
  'xnor',
])

export function parseWorkflowTopology(value: unknown): WorkflowTopology | null {
  if (
    !isRecord(value) ||
    value.revision !== 1 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    return null
  const nodes = value.nodes.map(parseNode)
  const edges = value.edges.map(parseEdge)
  if (
    nodes.some((node) => node === null) ||
    edges.some((edge) => edge === null)
  )
    return null
  const topology: WorkflowTopology = {
    revision: 1,
    nodes: nodes as WorkflowNode[],
    edges: edges as WorkflowEdge[],
  }
  return validateWorkflowTopology(topology).length === 0
    ? deepFreeze(topology)
    : null
}

export function validateWorkflowTopology(
  topology: WorkflowTopology,
): readonly WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const raw = topology as unknown
  if (
    !isRecord(raw) ||
    raw.revision !== 1 ||
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.edges)
  ) {
    return freezeIssues([{ code: 'invalidTopology' }])
  }
  const nodes = raw.nodes.filter((node): node is WorkflowNode => {
    if (isRuntimeNode(node)) return true
    issues.push({
      code: 'invalidTopology',
      ...(isRecord(node) && isText(node.id) ? { nodeId: node.id } : {}),
    })
    return false
  })
  const edges = raw.edges.filter((edge): edge is WorkflowEdge => {
    if (isRuntimeEdge(edge)) return true
    issues.push({
      code: 'invalidTopology',
      ...(isRecord(edge) && isText(edge.id) ? { edgeId: edge.id } : {}),
    })
    return false
  })
  const nodeById = new Map<string, WorkflowNode>()
  const edgeIds = new Set<string>()
  const pairs = new Set<string>()
  for (const node of nodes) {
    if (nodeById.has(node.id))
      issues.push({ code: 'duplicateNodeId', nodeId: node.id })
    nodeById.set(node.id, node)
  }
  for (const edge of edges) {
    if (edgeIds.has(edge.id))
      issues.push({ code: 'duplicateEdgeId', edgeId: edge.id })
    edgeIds.add(edge.id)
    const pair = `${edge.source}\u0000${edge.target}`
    if (pairs.has(pair))
      issues.push({ code: 'duplicateConnection', edgeId: edge.id })
    pairs.add(pair)
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target))
      issues.push({ code: 'danglingEdge', edgeId: edge.id })
    if (edge.source === edge.target)
      issues.push({ code: 'selfEdge', edgeId: edge.id })
    const source = nodeById.get(edge.source)
    if (source?.kind !== 'condition' && edge.branch !== undefined)
      issues.push({ code: 'invalidBranch', edgeId: edge.id })
  }
  const inputs = nodes.filter((node) => node.kind === 'input')
  const outputs = nodes.filter((node) => node.kind === 'output')
  if (inputs.length === 0) issues.push({ code: 'missingInput' })
  if (outputs.length === 0) issues.push({ code: 'missingOutput' })
  for (const condition of nodes.filter((node) => node.kind === 'condition')) {
    const incoming = edges.filter((edge) => edge.target === condition.id)
    const outgoing = edges.filter((edge) => edge.source === condition.id)
    const gate = condition.gateType ?? 'ifElse'
    if (
      gate === 'ifElse' || gate === 'not'
        ? incoming.length !== 1
        : incoming.length < 2
    ) {
      issues.push({ code: 'invalidGateArity', nodeId: condition.id })
    }
    const used = new Set<WorkflowBranch>()
    for (const edge of outgoing) {
      if (!edge.branch || !branchesForGate(gate).includes(edge.branch)) {
        issues.push({ code: 'invalidBranch', edgeId: edge.id })
        continue
      }
      if (!AUTO_FAN_OUT_GATES.has(gate) && used.has(edge.branch))
        issues.push({ code: 'branchUsed', edgeId: edge.id })
      used.add(edge.branch)
    }
    if (gate === 'not' && outgoing.length > 1)
      issues.push({ code: 'gateLimit', nodeId: condition.id })
  }
  const validTopology: WorkflowTopology = { revision: 1, nodes, edges }
  const graph = graphFor(validTopology, nodeById)
  if (graph.order.length !== nodes.length) issues.push({ code: 'cycle' })
  const reachable = new Set<string>()
  const pending = inputs.map((node) => node.id)
  while (pending.length) {
    const id = pending.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const target of graph.outgoing.get(id) ?? []) pending.push(target)
  }
  for (const node of nodes)
    if (!reachable.has(node.id))
      issues.push({ code: 'unreachable', nodeId: node.id })
  return freezeIssues(issues)
}

export function connectionProblem(
  topology: WorkflowTopology,
  candidate: WorkflowConnectionCandidate,
): WorkflowConnectionProblem | null {
  const source = topology.nodes.find((node) => node.id === candidate.source)
  const target = topology.nodes.find((node) => node.id === candidate.target)
  if (!source || !target || candidate.source === candidate.target)
    return freezeProblem({ code: 'invalidConnection' })
  const otherEdges = topology.edges.filter((edge) => edge.id !== candidate.id)
  if (
    otherEdges.some(
      (edge) =>
        edge.source === candidate.source && edge.target === candidate.target,
    )
  )
    return freezeProblem({ code: 'duplicateConnection' })
  if (source.kind !== 'condition')
    return candidate.branch === undefined
      ? null
      : freezeProblem({ code: 'invalidConnection' })
  const gateType = source.gateType ?? 'ifElse'
  const outgoing = otherEdges.filter((edge) => edge.source === source.id)
  const available = availableBranches(gateType, outgoing)
  if (candidate.branch === undefined)
    return freezeProblem({
      code: 'branchRequired',
      gateType,
      available,
    })
  if (!branchesForGate(gateType).includes(candidate.branch))
    return freezeProblem({
      code: 'gateMismatch',
      gateType,
      available,
    })
  if (!available.includes(candidate.branch))
    return freezeProblem({
      code: gateType === 'ifElse' ? 'branchUsed' : 'gateLimit',
      gateType,
      available,
    })
  return null
}

export function layoutWorkflowNodes(
  topology: WorkflowTopology,
): WorkflowTopology {
  const nodes = topology.nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const graph = graphFor(topology, byId)
  const level = new Map<string, number>()
  for (const id of graph.order) {
    const parents = graph.incoming.get(id) ?? []
    level.set(
      id,
      parents.length === 0
        ? 0
        : Math.max(...parents.map((parent) => (level.get(parent) ?? 0) + 1)),
    )
  }
  const rows = new Map<number, number>()
  const laidOut = nodes.map((node) => {
    const column = level.get(node.id) ?? 0
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return {
      ...node,
      position: { x: 70 + column * 245, y: 90 + row * 160 },
      ...(node.inputPredicates === undefined
        ? {}
        : {
            inputPredicates: cloneForLayout(node.inputPredicates) as Readonly<
              Record<string, string>
            >,
          }),
      ...(node.outputSchema === undefined
        ? {}
        : { outputSchema: cloneForLayout(node.outputSchema) }),
    }
  })
  return deepFreeze({
    revision: 1,
    nodes: laidOut,
    edges: topology.edges.map((edge) => ({ ...edge })),
  })
}

function parseNode(value: unknown): WorkflowNode | null {
  if (
    !isRecord(value) ||
    !isText(value.id) ||
    !isText(value.label) ||
    !isSafeWorkflowStepPath(value.stepPath) ||
    !NODE_KINDS.has(value.kind as WorkflowNodeKind) ||
    !isPosition(value.position)
  )
    return null
  if (
    value.gateType !== undefined &&
    !GATE_TYPES.has(value.gateType as WorkflowGateType)
  )
    return null
  const inputPredicates =
    value.inputPredicates === undefined
      ? undefined
      : stringRecord(value.inputPredicates)
  if (value.inputPredicates !== undefined && !inputPredicates) return null
  const hasOutputSchema = Object.prototype.hasOwnProperty.call(
    value,
    'outputSchema',
  )
  const outputSchema = hasOutputSchema
    ? cloneOutputSchema(value.outputSchema)
    : undefined
  if (hasOutputSchema && !outputSchema) return null
  return {
    id: value.id,
    kind: value.kind as WorkflowNodeKind,
    label: value.label,
    stepPath: value.stepPath,
    position: { x: value.position.x, y: value.position.y },
    ...(isText(value.stage) ? { stage: value.stage } : {}),
    ...(isText(value.modelId) ? { modelId: value.modelId } : {}),
    ...(value.gateType === undefined
      ? {}
      : { gateType: value.gateType as WorkflowGateType }),
    ...(isText(value.predicate) ? { predicate: value.predicate } : {}),
    ...(inputPredicates ? { inputPredicates } : {}),
    ...(outputSchema ?? {}),
  }
}

function parseEdge(value: unknown): WorkflowEdge | null {
  if (
    !isRecord(value) ||
    !isText(value.id) ||
    !isText(value.source) ||
    !isText(value.target)
  )
    return null
  if (value.branch !== undefined && !isBranch(value.branch)) return null
  return {
    id: value.id,
    source: value.source,
    target: value.target,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    ...(isText(value.label) ? { label: value.label } : {}),
  }
}

function graphFor(
  topology: WorkflowTopology,
  byId: ReadonlyMap<string, WorkflowNode>,
) {
  const incoming = new Map(
    topology.nodes.map((node) => [node.id, [] as string[]]),
  )
  const outgoing = new Map(
    topology.nodes.map((node) => [node.id, [] as string[]]),
  )
  for (const edge of topology.edges)
    if (byId.has(edge.source) && byId.has(edge.target)) {
      incoming.get(edge.target)!.push(edge.source)
      outgoing.get(edge.source)!.push(edge.target)
    }
  const remaining = new Map(
    [...incoming].map(([id, parents]) => [id, parents.length]),
  )
  const queue = topology.nodes
    .filter((node) => remaining.get(node.id) === 0)
    .map((node) => node.id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const target of outgoing.get(id) ?? []) {
      const next = remaining.get(target)! - 1
      remaining.set(target, next)
      if (next === 0) queue.push(target)
    }
  }
  return { incoming, outgoing, order }
}

function branchesForGate(gate: WorkflowGateType): readonly WorkflowBranch[] {
  return gate === 'ifElse' ? ['true', 'false'] : [gate]
}
function availableBranches(
  gate: WorkflowGateType,
  outgoing: readonly WorkflowEdge[],
): readonly WorkflowBranch[] {
  if (AUTO_FAN_OUT_GATES.has(gate)) return [gate as WorkflowBranch]
  if (gate === 'not') return outgoing.length === 0 ? ['not'] : []
  const used = new Set(
    outgoing
      .map((edge) => edge.branch)
      .filter((branch): branch is WorkflowBranch => branch !== undefined),
  )
  return (['true', 'false'] as const).filter((branch) => !used.has(branch))
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function isPosition(value: unknown): value is { x: number; y: number } {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  )
}
function isBranch(value: unknown): value is WorkflowBranch {
  return (
    value === 'true' ||
    value === 'false' ||
    (GATE_TYPES.has(value as WorkflowGateType) && value !== 'ifElse')
  )
}
export function isSafeWorkflowStepPath(value: unknown): value is string {
  return (
    isText(value) &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  )
}
function isRuntimeNode(value: unknown): value is WorkflowNode {
  return (
    isRecord(value) &&
    isText(value.id) &&
    NODE_KINDS.has(value.kind as WorkflowNodeKind) &&
    isText(value.label) &&
    isSafeWorkflowStepPath(value.stepPath) &&
    isPosition(value.position) &&
    (value.gateType === undefined ||
      GATE_TYPES.has(value.gateType as WorkflowGateType)) &&
    (value.stage === undefined || isText(value.stage)) &&
    (value.modelId === undefined || isText(value.modelId)) &&
    (value.predicate === undefined || isText(value.predicate)) &&
    (value.inputPredicates === undefined ||
      stringRecord(value.inputPredicates) !== null) &&
    (!Object.prototype.hasOwnProperty.call(value, 'outputSchema') ||
      cloneOutputSchema(value.outputSchema) !== null)
  )
}
function isRuntimeEdge(value: unknown): value is WorkflowEdge {
  return (
    isRecord(value) &&
    isText(value.id) &&
    isText(value.source) &&
    isText(value.target) &&
    (value.branch === undefined || isBranch(value.branch)) &&
    (value.label === undefined || isText(value.label))
  )
}
function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (
    !isRecord(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  )
    return null
  return Object.fromEntries(Object.entries(value)) as Record<string, string>
}
function cloneOutputSchema(value: unknown): { outputSchema: unknown } | null {
  const cloned = cloneAcyclic(value)
  return cloned.valid ? { outputSchema: cloned.value } : null
}
type CloneResult =
  | Readonly<{ valid: true; value: unknown }>
  | Readonly<{ valid: false }>
function cloneAcyclic(
  value: unknown,
  active = new WeakSet<object>(),
): CloneResult {
  if (value === null) return { valid: true, value }
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return { valid: true, value }
  if (typeof value !== 'object') return { valid: false }
  if (active.has(value)) return { valid: false }
  active.add(value)
  if (Array.isArray(value)) {
    const target: unknown[] = []
    for (const child of value) {
      const cloned = cloneAcyclic(child, active)
      if (!cloned.valid) return cloned
      target.push(cloned.value)
    }
    active.delete(value)
    return { valid: true, value: target }
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return { valid: false }
  const entries: [string, unknown][] = []
  for (const [key, child] of Object.entries(value)) {
    const cloned = cloneAcyclic(child, active)
    if (!cloned.valid) return cloned
    entries.push([key, cloned.value])
  }
  active.delete(value)
  return { valid: true, value: Object.fromEntries(entries) }
}
function cloneForLayout(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (!value || typeof value !== 'object') return value
  const existing = seen.get(value)
  if (existing) return existing
  if (Array.isArray(value)) {
    const target: unknown[] = []
    seen.set(value, target)
    for (const child of value) target.push(cloneForLayout(child, seen))
    return target
  }
  const target: Record<string, unknown> = {}
  seen.set(value, target)
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(target, key, {
      value: cloneForLayout(child, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return target
}
function freezeIssues(issues: WorkflowIssue[]): readonly WorkflowIssue[] {
  return Object.freeze(issues.map((issue) => Object.freeze({ ...issue })))
}
function freezeProblem(
  problem: WorkflowConnectionProblem,
): WorkflowConnectionProblem {
  return Object.freeze({
    ...problem,
    ...(problem.available
      ? { available: Object.freeze([...problem.available]) }
      : {}),
  })
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
