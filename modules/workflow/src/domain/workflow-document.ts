import { type WorkflowCopy, en } from '../i18n'

import {
  type WorkflowIssueCode,
  type WorkflowNode,
  type WorkflowTopology,
  isSafeWorkflowStepPath,
  parseWorkflowTopology,
} from './workflow-model'

const YOLO_STRUCTURE = {
  start: '<!-- yolo:workflow-structure:start -->',
  end: '<!-- yolo:workflow-structure:end -->',
}
const YOLO_TOPOLOGY = {
  start: '<!-- yolo:workflow-topology:start -->',
  end: '<!-- yolo:workflow-topology:end -->',
}
const DSH_STRUCTURE = {
  start: '<!-- deepseek-flow:structure:start -->',
  end: '<!-- deepseek-flow:structure:end -->',
}
const DSH_TOPOLOGY = {
  start: '<!-- deepseek-flow:topology:start -->',
  end: '<!-- deepseek-flow:topology:end -->',
}

export type WorkflowDocumentStep = Readonly<{
  nodeId: string
  label: string
  stepPath: string
}>
export type WorkflowDocument = Readonly<{
  title: string
  content: string
  steps: readonly WorkflowDocumentStep[]
  topology: WorkflowTopology | null
  issues: readonly WorkflowIssueCode[]
}>
export type DshWorkflowBundle = Readonly<{
  title: string
  content: string
  topology: WorkflowTopology
  stepContents?: Readonly<Record<string, string>>
}>

export function parseWorkflowDocument(
  content: string,
  copy: WorkflowCopy = en,
): WorkflowDocument {
  const structureMarkers = analyzeMarkers(content, [
    YOLO_STRUCTURE,
    DSH_STRUCTURE,
  ])
  const topologyMarkers = analyzeMarkers(content, [YOLO_TOPOLOGY, DSH_TOPOLOGY])
  const structureBlock = structureMarkers.blocks[0] ?? null
  const topologyBlock = topologyMarkers.blocks[0] ?? null
  const steps = structureBlock ? parseStructure(structureBlock.body) : []
  const parsed = topologyBlock ? parseJsonTopology(topologyBlock.body) : null
  const issues: WorkflowIssueCode[] = []
  if (structureMarkers.invalid || (structureBlock && steps === null))
    issues.push('invalidStructure')
  if (topologyMarkers.invalid || (topologyBlock && !parsed))
    issues.push('invalidTopology')
  const topologyMatchesStructure =
    parsed &&
    structureBlock &&
    steps !== null &&
    !matchesTopologySteps(parsed, steps)
  if (topologyMatchesStructure) issues.push('invalidStructure')
  const topology = topologyMatchesStructure ? null : parsed
  const fallbackSteps = structureBlock
    ? (steps ?? (topology ? topology.nodes.map(toStep) : []))
    : topology
      ? topology.nodes.map(toStep)
      : []
  return Object.freeze({
    title: titleFrom(content, copy),
    content,
    steps: freezeSteps(fallbackSteps),
    topology,
    issues: Object.freeze(issues),
  })
}

export function extractWorkflowExecutionContext(content: string): string {
  const withoutFrontmatter = stripFrontmatter(content)
  const blocks = analyzeMarkers(withoutFrontmatter, [
    YOLO_STRUCTURE,
    YOLO_TOPOLOGY,
    DSH_STRUCTURE,
    DSH_TOPOLOGY,
  ]).blocks
  if (blocks.length === 0) return withoutFrontmatter
  let result = withoutFrontmatter
  for (const block of [...blocks].sort(
    (left, right) => right.start - left.start,
  )) {
    result = `${result.slice(0, block.start)}${result.slice(block.end)}`
  }
  return result
}

export function updateWorkflowManagedBlocks(
  content: string,
  topology: WorkflowTopology,
  copy: WorkflowCopy,
): string {
  const structure = renderStructure(topology, copy)
  const serializedTopology = `${YOLO_TOPOLOGY.start}\n## ${copy.document.topologyTitle}\n\n${JSON.stringify(topology, null, 2)}\n${YOLO_TOPOLOGY.end}`
  const structureMarkers = analyzeMarkers(content, [
    YOLO_STRUCTURE,
    DSH_STRUCTURE,
  ])
  const withStructure = replaceOrAppend(
    content,
    structureMarkers.blocks[0] ?? null,
    structure,
  )
  const topologyMarkers = analyzeMarkers(withStructure, [
    YOLO_TOPOLOGY,
    DSH_TOPOLOGY,
  ])
  return replaceOrAppend(
    withStructure,
    topologyMarkers.blocks[0] ?? null,
    serializedTopology,
  )
}

export function parseDshFlowJson(
  value: unknown,
  copy: WorkflowCopy = en,
): DshWorkflowBundle | null {
  const source = typeof value === 'string' ? parseJson(value) : value
  if (
    !isRecord(source) ||
    !Array.isArray(source.nodes) ||
    !Array.isArray(source.edges)
  )
    return null
  const docs = isRecord(source.docs) ? source.docs : {}
  const stepContents = parseStepContents(source.stepContents)
  if (source.stepContents !== undefined && stepContents === null) return null
  const nodes = source.nodes.map((node) => dshNode(node, docs))
  if (nodes.some((node) => node === null)) return null
  const topology = parseWorkflowTopology({
    revision: 1,
    nodes,
    edges: source.edges.map(dshEdge),
  })
  if (!topology) return null
  return Object.freeze({
    title: text(source.name) ?? copy.document.workflowTitle,
    content: text(source.workflowContent) ?? '',
    topology,
    ...(stepContents ? { stepContents } : {}),
  })
}

export function exportDshFlowJson(
  bundle: DshWorkflowBundle,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: 'workflow',
    version: 1,
    name: bundle.title,
    workflowContent: bundle.content,
    nodes: bundle.topology.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      position: { ...node.position },
      data: {
        label: node.label,
        ...(node.stage ? { stage: node.stage } : {}),
        ...(node.modelId ? { model: node.modelId } : {}),
        ...(node.gateType ? { gateType: node.gateType } : {}),
        ...(node.predicate ? { predicate: node.predicate } : {}),
        ...(node.inputPredicates
          ? { inputPredicates: { ...node.inputPredicates } }
          : {}),
        ...(node.outputSchema === undefined
          ? {}
          : { outputSchema: node.outputSchema }),
        ...(node.mergeStrategy ? { mergeStrategy: node.mergeStrategy } : {}),
        ...(node.verification === undefined
          ? {}
          : { verification: node.verification }),
      },
    })),
    edges: bundle.topology.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.branch ? { sourceHandle: edge.branch } : {}),
      ...(edge.label ? { label: edge.label } : {}),
    })),
    docs: Object.fromEntries(
      bundle.topology.nodes.map((node) => [node.id, node.stepPath]),
    ),
    ...(bundle.stepContents
      ? { stepContents: { ...bundle.stepContents } }
      : {}),
  })
}

function dshNode(
  value: unknown,
  docs: Record<string, unknown>,
): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    !isRecord(value.data) ||
    !isText(value.id) ||
    !isText(value.kind) ||
    !isRecord(value.position)
  )
    return null
  const stepPath = docs[value.id]
  if (!isSafeWorkflowStepPath(stepPath)) return null
  const model = text(value.data.model) ?? text(value.data.modelId)
  return {
    id: value.id,
    kind: value.kind,
    label: text(value.data.label) ?? value.id,
    stepPath,
    position: value.position,
    ...(text(value.data.stage) ? { stage: value.data.stage } : {}),
    ...(model ? { modelId: model } : {}),
    ...(value.data.gateType === undefined
      ? {}
      : { gateType: value.data.gateType }),
    ...(text(value.data.predicate) ? { predicate: value.data.predicate } : {}),
    ...(value.data.inputPredicates === undefined
      ? {}
      : { inputPredicates: value.data.inputPredicates }),
    ...(value.data.outputSchema === undefined
      ? {}
      : { outputSchema: value.data.outputSchema }),
    ...(value.data.mergeStrategy === 'concat' ||
    value.data.mergeStrategy === 'dedupe'
      ? { mergeStrategy: value.data.mergeStrategy }
      : {}),
    ...(value.data.verification === undefined
      ? {}
      : { verification: value.data.verification }),
  }
}

function dshEdge(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  return {
    id: value.id,
    source: value.source,
    target: value.target,
    ...((value.sourceHandle ?? value.branch ?? value.logic)
      ? { branch: value.sourceHandle ?? value.branch ?? value.logic }
      : {}),
    ...(text(value.label) ? { label: value.label } : {}),
  }
}

function stripFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/)
  if (lines.length < 2 || lines[0]?.trim() !== '---') return content
  const closing = lines.slice(1).findIndex((line) => line.trim() === '---')
  if (closing < 0) return content
  return lines.slice(closing + 2).join('\n')
}

function renderStructure(
  topology: WorkflowTopology,
  copy: WorkflowCopy,
): string {
  return [
    YOLO_STRUCTURE.start,
    `## ${copy.document.structureTitle}`,
    '',
    ...topology.nodes.flatMap((node) => [
      `- id: ${node.id}`,
      `  kind: ${node.kind}`,
      `  label: [${escapeLabel(node.label)}](${encodeStepPathForLink(node.stepPath)})`,
      `  step: ${node.stepPath}`,
    ]),
    YOLO_STRUCTURE.end,
  ].join('\n')
}

function parseStructure(body: string): WorkflowDocumentStep[] | null {
  const blocks = body
    .trim()
    .split(/\r?\n(?=- id: )/)
    .filter((block) => block.trim().startsWith('- id:'))
  const steps: WorkflowDocumentStep[] = []
  for (const block of blocks) {
    const id = field(block, 'id')
    const label = field(block, 'label')
    const stepPath = field(block, 'step')
    if (!id || !label || !isSafeWorkflowStepPath(stepPath)) return null
    const linked = parseLinkedLabel(label)
    if (linked && linked.stepPath !== stepPath) return null
    steps.push({
      nodeId: id,
      label: unescapeLabel(linked?.label ?? label),
      stepPath,
    })
  }
  return steps
}

function analyzeMarkers(
  content: string,
  pairs: readonly { start: string; end: string }[],
): MarkerAnalysis {
  const analyses = pairs.map((pair) => analyzePair(content, pair))
  return {
    blocks: analyses
      .flatMap((analysis) => analysis.blocks)
      .sort((left, right) => left.start - right.start),
    invalid: analyses.some((analysis) => analysis.invalid),
  }
}

function analyzePair(
  content: string,
  pair: { start: string; end: string },
): MarkerAnalysis {
  const events: { index: number; type: 'start' | 'end' }[] = []
  let index = content.indexOf(pair.start)
  while (index >= 0) {
    events.push({ index, type: 'start' })
    index = content.indexOf(pair.start, index + pair.start.length)
  }
  index = content.indexOf(pair.end)
  while (index >= 0) {
    events.push({ index, type: 'end' })
    index = content.indexOf(pair.end, index + pair.end.length)
  }
  events.sort((left, right) => left.index - right.index)
  const blocks: ManagedBlock[] = []
  let open: number | null = null
  let invalid = false
  for (const event of events) {
    if (event.type === 'start') {
      if (open !== null) invalid = true
      open = event.index
    } else if (open === null) {
      invalid = true
    } else {
      const bodyStart = open + pair.start.length
      blocks.push({
        start: open,
        end: event.index + pair.end.length,
        body: content.slice(bodyStart, event.index),
        pair,
      })
      open = null
    }
  }
  return { blocks, invalid: invalid || open !== null }
}

function replaceOrAppend(
  content: string,
  block: ManagedBlock | null,
  replacement: string,
): string {
  if (block)
    return `${content.slice(0, block.start)}${replacement}${content.slice(block.end)}`
  return content.length === 0
    ? replacement
    : `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${replacement}`
}

type ManagedBlock = Readonly<{
  start: number
  end: number
  body: string
  pair: { start: string; end: string }
}>
type MarkerAnalysis = Readonly<{
  blocks: readonly ManagedBlock[]
  invalid: boolean
}>
function parseJsonTopology(value: string): WorkflowTopology | null {
  return parseWorkflowTopology(
    parseJson(value.replace(/^\s*##[^\n]*\n(?:\s*\n)?/, '')),
  )
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
function titleFrom(content: string, copy: WorkflowCopy): string {
  return content.match(/^#\s+(.+)$/m)?.[1].trim() ?? copy.document.workflowTitle
}
function toStep(node: WorkflowNode): WorkflowDocumentStep {
  return { nodeId: node.id, label: node.label, stepPath: node.stepPath }
}
function matchesTopologySteps(
  topology: WorkflowTopology,
  steps: readonly WorkflowDocumentStep[],
): boolean {
  return (
    topology.nodes.length === steps.length &&
    topology.nodes.every(
      (node, index) =>
        node.id === steps[index]?.nodeId &&
        node.label === steps[index]?.label &&
        node.stepPath === steps[index]?.stepPath,
    )
  )
}
function freezeSteps(
  steps: readonly WorkflowDocumentStep[],
): readonly WorkflowDocumentStep[] {
  return Object.freeze(steps.map((step) => Object.freeze({ ...step })))
}
function field(block: string, name: string): string | null {
  return (
    block.match(new RegExp(`(?:^- |^  )${name}:\\s*(.+)$`, 'm'))?.[1].trim() ??
    null
  )
}
function escapeLabel(label: string): string {
  return label.replace(/([\\[\]])/g, '\\$1')
}
function unescapeLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, '$1')
}
function parseLinkedLabel(
  value: string,
): Readonly<{ label: string; stepPath: string }> | null {
  if (!value.startsWith('[') || !value.endsWith(')')) return null
  for (let index = 1; index < value.length - 2; index += 1) {
    if (value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] !== ']' || value[index + 1] !== '(') continue
    const stepPath = decodeStepPathFromLink(value.slice(index + 2, -1))
    return stepPath ? { label: value.slice(1, index), stepPath } : null
  }
  return null
}
function encodeStepPathForLink(stepPath: string): string {
  return stepPath
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment)
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/\[/g, '%5B')
        .replace(/\]/g, '%5D'),
    )
    .join('/')
}
function decodeStepPathFromLink(value: string): string | null {
  try {
    const stepPath = value
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
    return isSafeWorkflowStepPath(stepPath) ? stepPath : null
  } catch {
    return null
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function text(value: unknown): string | undefined {
  return isText(value) ? value : undefined
}

function parseStepContents(
  value: unknown,
): Readonly<Record<string, string>> | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.some(([, content]) => typeof content !== 'string')) return null
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>)
}
