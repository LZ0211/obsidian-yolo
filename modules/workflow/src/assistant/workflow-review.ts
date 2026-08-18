import { type WorkflowCopy } from '../i18n'
import { parseWorkflowDocument } from '../domain/workflow-document'
import type { WorkflowBundle } from '../domain/workflow-repository'
import { type WorkflowTopology } from '../domain/workflow-model'

type WorkflowReviewAgent = YoloModuleHostApiV1['agent']
type AgentRequest = Parameters<WorkflowReviewAgent['stream']>[0]
type AgentTool = NonNullable<AgentRequest['tools']>[number]
type AgentToolResult = Awaited<ReturnType<AgentTool['handler']>>

export type WorkflowReviewTarget = 'document' | 'workflow'

export type WorkflowReviewResult =
  | Readonly<{ ok: true; content: string }>
  | Readonly<{
      ok: false
      reason: 'aborted' | 'failed' | 'no-proposal'
      message: string
    }>

export type WorkflowReviewInput = Readonly<{
  agent: WorkflowReviewAgent
  bundle: WorkflowBundle
  copy: WorkflowCopy
  modelId: string
  target: WorkflowReviewTarget
  instruction?: string
  signal?: AbortSignal
}>

const PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    content: { type: 'string', minLength: 1 },
  },
  required: ['content'],
  additionalProperties: false,
}

export async function runWorkflowReview(
  input: WorkflowReviewInput,
): Promise<WorkflowReviewResult> {
  if (input.signal?.aborted)
    return {
      ok: false,
      reason: 'aborted',
      message: input.copy.assistant.cancel,
    }
  if (!input.modelId.trim())
    return {
      ok: false,
      reason: 'failed',
      message: input.copy.assistant.failure,
    }

  let proposal: string | null = null
  const proposalTool: AgentTool = {
    name: 'submit_workflow_proposal',
    description:
      'Submit exactly one complete Markdown workflow proposal for review. Do not write files.',
    inputSchema: PROPOSAL_SCHEMA,
    handler: (value) => {
      const content = proposalContent(value)
      if (content === null || proposal !== null) return invalidProposal()
      const document = parseWorkflowDocument(content, input.copy)
      if (
        !document.topology ||
        document.issues.length > 0 ||
        (input.target === 'document'
          ? !sameTopology(document.topology, input.bundle.document.topology)
          : !sameStepFiles(document.topology, input.bundle.document.topology))
      )
        return invalidProposal()
      proposal = content
      return { content: JSON.stringify({ ok: true }) }
    },
  }

  try {
    for await (const event of input.agent.stream({
      prompt: buildReviewPrompt(input),
      modelId: input.modelId,
      systemPrompt: buildSystemPrompt(input),
      capability: 'none',
      tools: [proposalTool],
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      if (event.type === 'aborted')
        return {
          ok: false,
          reason: 'aborted',
          message: input.copy.assistant.cancel,
        }
      if (event.type === 'error')
        return {
          ok: false,
          reason: 'failed',
          message: event.message || input.copy.assistant.failure,
        }
    }
  } catch (error) {
    if (input.signal?.aborted)
      return {
        ok: false,
        reason: 'aborted',
        message: input.copy.assistant.cancel,
      }
    return {
      ok: false,
      reason: 'failed',
      message:
        error instanceof Error ? error.message : input.copy.assistant.failure,
    }
  }

  return proposal
    ? { ok: true, content: proposal }
    : {
        ok: false,
        reason: 'no-proposal',
        message: input.copy.assistant.failure,
      }
}

function buildSystemPrompt(input: WorkflowReviewInput): string {
  const target =
    input.target === 'document'
      ? 'Improve the document prose while preserving its canonical topology and structure.'
      : 'Improve the workflow document and topology fields, but preserve every existing node id and step path. Do not add, remove, or rename steps because step files are not part of this proposal.'
  return [
    'You review a document-driven workflow for a visual workflow editor.',
    target,
    'Never call filesystem or vault tools.',
    'Return exactly one complete proposal by calling submit_workflow_proposal.',
    'Keep the proposal inside the tool; do not put Markdown in the final prose.',
  ].join('\n')
}

function buildReviewPrompt(input: WorkflowReviewInput): string {
  const source = {
    target: input.target,
    instruction: input.instruction?.trim() || undefined,
    workflow: {
      path: input.bundle.path,
      document: input.bundle.document,
      files: input.bundle.files.map((file) => ({
        nodeId: file.nodeId,
        relativePath: file.relativePath,
        content: file.snapshot.content,
      })),
    },
  }
  return [
    'Review the following workflow snapshot.',
    'Use the supplied instruction when it is non-empty.',
    'The proposal must remain valid for the editor parser.',
    'Keep the proposal inside the tool.',
    JSON.stringify(source, null, 2),
  ].join('\n\n')
}

function proposalContent(value: Record<string, unknown>): string | null {
  if (
    Object.keys(value).length !== 1 ||
    typeof value.content !== 'string' ||
    !value.content.trim()
  )
    return null
  return value.content
}

function invalidProposal(): AgentToolResult {
  return {
    content: JSON.stringify({ ok: false, reason: 'invalid-proposal' }),
    isError: true,
  }
}

function sameTopology(
  left: WorkflowTopology | null,
  right: WorkflowTopology | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameStepFiles(
  left: WorkflowTopology | null,
  right: WorkflowTopology | null,
): boolean {
  if (!left || !right || left.nodes.length !== right.nodes.length) return false
  const rightPaths = new Map(
    right.nodes.map((node) => [node.id, node.stepPath]),
  )
  return left.nodes.every((node) => rightPaths.get(node.id) === node.stepPath)
}
