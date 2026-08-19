import type { WorkflowGateType, WorkflowNode } from '../domain/workflow-model'

import {
  evaluateWorkflowGate,
  mergeWorkflowSources,
} from './workflow-run-graph'
import { WorkflowNodeExecutionError } from './workflow-run-types'
import type {
  JsonValue,
  WorkflowNodeExecutionRequest,
  WorkflowNodeExecutionResult,
  WorkflowNodeExecutor,
} from './workflow-run-types'
import { workflowSchemaValidator } from './workflow-schema'
import type { WorkflowSchemaValidator } from './workflow-schema'

// ---------------------------------------------------------------------------
// Structural port over the host Agent API. `YoloModuleHostApiV1['agent']` is
// compatible; the executor never imports host or Core types.
// ---------------------------------------------------------------------------

export type WorkflowAgentToolInput = Readonly<Record<string, unknown>>

export type WorkflowAgentToolResult = Readonly<{
  content: string
  isError?: boolean
}>

export type WorkflowAgentTool = Readonly<{
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  handler(
    input: WorkflowAgentToolInput,
  ): Promise<WorkflowAgentToolResult> | WorkflowAgentToolResult
}>

export type WorkflowAgentEvent =
  | Readonly<{ type: 'text'; text: string; delta: string }>
  | Readonly<{
      type: 'tool'
      name: string
      status: string
      arguments?: Readonly<Record<string, unknown>>
    }>
  | Readonly<{ type: 'completed'; text: string }>
  | Readonly<{ type: 'aborted' }>
  | Readonly<{ type: 'error'; message: string }>

export type WorkflowAgentRequest = Readonly<{
  prompt?: string
  modelId?: string
  systemPrompt: string
  capability: 'vault-write'
  activity?: Readonly<{ title: string; detail?: string }>
  tools?: readonly WorkflowAgentTool[]
  signal?: AbortSignal
}>

export type WorkflowAgent = Readonly<{
  stream(request: WorkflowAgentRequest): AsyncIterable<WorkflowAgentEvent>
}>

export type WorkflowNodeExecutorOptions = Readonly<{
  agent: WorkflowAgent
  validator?: WorkflowSchemaValidator
  /**
   * Observed for every agent event, including tool status changes such as
   * `awaiting_approval`. The coordinator may use it to refresh the in-memory
   * `running` detail; it never affects the executor's result.
   */
  onAgentEvent?: (nodeId: string, event: WorkflowAgentEvent) => void
}>

// ---------------------------------------------------------------------------
// Stable prompt protocol. The system prompt is identical across calls for the
// same node; run input travels only in `prompt`.
// ---------------------------------------------------------------------------

export const WORKFLOW_AGENT_SYSTEM_PROTOCOL =
  'You are executing one step of a YOLO workflow. Follow the step instructions below and deliver the step result exactly as the final instruction requires. Plain prose is never read as the step result.'

const SCHEMA_OUTPUT_INSTRUCTION =
  'Deliver the step result through the submit_workflow_output tool: exactly one submission carrying the complete result value, matching the node output schema. Do not describe the result in prose.'

const TEXT_OUTPUT_INSTRUCTION =
  'Conclude with the step result as your final plain-text answer. The completed response must contain the result value itself.'

const CONDITION_OUTPUT_INSTRUCTION =
  'For each active upstream source, judge whether its value satisfies the condition of this step and submit exactly one boolean per source with the submit_workflow_condition tool.'

const MAP_CONCURRENCY = 3

export function createWorkflowNodeExecutor(
  options: WorkflowNodeExecutorOptions,
): WorkflowNodeExecutor {
  const { agent, onAgentEvent } = options
  const validator = options.validator ?? workflowSchemaValidator

  const execute = async (
    request: WorkflowNodeExecutionRequest,
  ): Promise<WorkflowNodeExecutionResult> => {
    const context: AgentCallContext = {
      agent,
      validator,
      onAgentEvent,
      request,
    }
    switch (request.node.kind) {
      case 'input':
        return { value: request.workflowInput }
      case 'merge':
      case 'output':
        return { value: mergeValue(request) }
      case 'condition':
        return executeCondition(context)
      case 'mapAgent':
        return executeMapAgent(context)
      case 'agent': {
        const prompt = JSON.stringify({
          workflowInput: request.workflowInput,
          upstream: request.upstream,
        })
        if (request.node.outputSchema === undefined)
          return {
            value: await executeTextAgentNode(context, {
              prompt,
              signal: request.signal,
              outputInstruction: TEXT_OUTPUT_INSTRUCTION,
            }),
          }
        const submission = createOutputSubmissionTool(
          validator,
          request.node.outputSchema,
        )
        await executeAgentStream(context, {
          prompt,
          signal: request.signal,
          tool: submission.tool,
          outputInstruction: SCHEMA_OUTPUT_INSTRUCTION,
        })
        const value = submission.getSubmitted()
        if (value === undefined)
          throw new WorkflowNodeExecutionError(
            'agent-failed',
            `Agent finished without a valid submit_workflow_output submission`,
          )
        return { value }
      }
    }
  }

  return Object.freeze({
    execute,
    // Task 5 gives testNode its preview semantics; until then it runs the
    // node through the same real execution path without persisting anything.
    testNode: (request: WorkflowNodeExecutionRequest) => execute(request),
  })
}

// ---------------------------------------------------------------------------
// Non-agent node kinds: deterministic, no Agent calls.
// ---------------------------------------------------------------------------

function mergeValue(request: WorkflowNodeExecutionRequest): JsonValue {
  const { node, upstream, definition } = request
  const strategy =
    node.kind === 'merge' && node.mergeStrategy !== undefined
      ? node.mergeStrategy
      : definition.policy.mergeStrategy
  return upstream.length === 1
    ? upstream[0].value
    : mergeWorkflowSources(upstream, strategy)
}

// ---------------------------------------------------------------------------
// One-shot agent execution.
// ---------------------------------------------------------------------------

type AgentCallContext = Readonly<{
  agent: WorkflowAgent
  validator: WorkflowSchemaValidator
  onAgentEvent?: (nodeId: string, event: WorkflowAgentEvent) => void
  request: WorkflowNodeExecutionRequest
}>

type AgentCallOptions = Readonly<{
  prompt: string
  signal: AbortSignal
  tool?: WorkflowAgentTool
  outputInstruction: string
}>

/** A text-mode call: the completed message text is the node value. */
async function executeTextAgentNode(
  context: AgentCallContext,
  options: AgentCallOptions,
): Promise<JsonValue> {
  const text = await executeAgentStream(context, options)
  if (text === undefined)
    throw new WorkflowNodeExecutionError(
      'agent-failed',
      'Agent stream ended without a completion',
    )
  return text
}

/**
 * Streams one agent call and returns the completed message text (undefined
 * when the stream ended without a completion). Tool-mode callers read their
 * run-scoped submission state afterwards; schema/condition modes never parse
 * model text.
 */
async function executeAgentStream(
  context: AgentCallContext,
  options: AgentCallOptions,
): Promise<string | undefined> {
  if (options.signal.aborted)
    throw new WorkflowNodeExecutionError('cancelled', 'Agent call cancelled')
  const request = buildAgentRequest(context, options)
  let completed: string | undefined
  for await (const event of context.agent.stream(request)) {
    context.onAgentEvent?.(context.request.node.id, event)
    if (event.type === 'error')
      throw new WorkflowNodeExecutionError(
        'agent-failed',
        `Agent failed: ${event.message}`,
      )
    if (event.type === 'aborted') {
      if (options.signal.aborted)
        throw new WorkflowNodeExecutionError(
          'cancelled',
          'Agent stream aborted by cancellation',
        )
      throw new WorkflowNodeExecutionError(
        'agent-failed',
        'Agent stream aborted',
      )
    }
    if (event.type === 'completed') completed = event.text
  }
  if (options.signal.aborted)
    throw new WorkflowNodeExecutionError('cancelled', 'Agent call cancelled')
  return completed
}

function buildAgentRequest(
  context: AgentCallContext,
  options: AgentCallOptions,
): WorkflowAgentRequest {
  const { request } = context
  const modelId = request.definition.modelByNodeId[request.node.id]
  if (modelId === undefined)
    throw new WorkflowNodeExecutionError(
      'invalid-definition',
      `Node "${request.node.id}" has no resolved model`,
    )
  const systemPrompt = [
    WORKFLOW_AGENT_SYSTEM_PROTOCOL,
    request.definition.workflowContextMarkdown,
    request.definition.stepContents[request.node.id],
    options.outputInstruction,
  ].join('\n\n')
  return {
    modelId,
    systemPrompt,
    prompt: options.prompt,
    capability: 'vault-write',
    activity: {
      title: request.definition.workflowPath,
      detail: request.node.label,
    },
    ...(options.tool ? { tools: [options.tool] } : {}),
    signal: options.signal,
  }
}

/**
 * The run-scoped `submit_workflow_output` tool. The host invokes handlers
 * serially per run; only the first valid submission is stored.
 */
function createOutputSubmissionTool(
  validator: WorkflowSchemaValidator,
  schema: unknown,
): Readonly<{
  tool: WorkflowAgentTool
  getSubmitted: () => JsonValue | undefined
}> {
  const toolSchema = {
    type: 'object',
    properties: { value: schema },
    required: ['value'],
    additionalProperties: false,
  }
  let submitted: JsonValue | undefined
  let accepted = false
  const tool: WorkflowAgentTool = {
    name: 'submit_workflow_output',
    description:
      'Submit the complete step result as a single JSON value. The value must satisfy the node output schema; exactly one valid submission is accepted per step.',
    inputSchema: toolSchema,
    handler: (input) => {
      const check = validator.validateValue(toolSchema, input)
      if (!check.ok)
        return {
          isError: true,
          content: `Invalid submission: ${check.message}`,
        }
      if (accepted)
        return {
          isError: true,
          content:
            'submit_workflow_output was already accepted; the workflow ignores further submissions',
        }
      accepted = true
      submitted = input.value as JsonValue
      return { content: 'The step result was accepted.' }
    },
  }
  return { tool, getSubmitted: () => submitted }
}

// ---------------------------------------------------------------------------
// Condition nodes: the model judges each active source; the gate is computed
// deterministically and the source data is preserved as the node output.
// This model-judged path is a contract-complete executor capability, but the
// coordinator evaluates condition nodes locally for full runs and node tests,
// so neither runtime path reaches it.
// ---------------------------------------------------------------------------

async function executeCondition(
  context: AgentCallContext,
): Promise<WorkflowNodeExecutionResult> {
  const { request } = context
  const { node, upstream, signal } = request
  if (upstream.length === 0)
    throw new WorkflowNodeExecutionError(
      'invalid-output',
      `Condition node "${node.id}" requires at least one active source`,
    )
  const gateType: WorkflowGateType = node.gateType ?? 'ifElse'
  const sourceIds = upstream.map((source) => source.nodeId)
  const submission = createConditionSubmissionTool(context.validator, sourceIds)
  await executeAgentStream(context, {
    prompt: JSON.stringify({ workflowInput: request.workflowInput, upstream }),
    signal,
    tool: submission.tool,
    outputInstruction: CONDITION_OUTPUT_INSTRUCTION,
  })
  const booleans = submission.getSubmitted()
  if (booleans === undefined)
    throw new WorkflowNodeExecutionError(
      'agent-failed',
      `Agent finished without a valid submit_workflow_condition submission`,
    )
  const booleanSources = upstream.map((source) => ({
    nodeId: source.nodeId,
    value: booleans[source.nodeId],
  }))
  let conditionResult: boolean
  try {
    conditionResult = evaluateWorkflowGate(
      gateType,
      booleanSources,
    ).conditionResult
  } catch (error) {
    throw new WorkflowNodeExecutionError(
      'invalid-output',
      error instanceof Error ? error.message : String(error),
    )
  }
  const value: JsonValue =
    upstream.length === 1
      ? upstream[0].value
      : Object.fromEntries(
          upstream.map((source) => [source.nodeId, source.value]),
        )
  return { value, conditionResult }
}

/** The run-scoped `submit_workflow_condition` tool: one boolean per source. */
function createConditionSubmissionTool(
  validator: WorkflowSchemaValidator,
  sourceIds: readonly string[],
): Readonly<{
  tool: WorkflowAgentTool
  getSubmitted: () => Readonly<Record<string, boolean>> | undefined
}> {
  const toolSchema = {
    type: 'object',
    properties: Object.fromEntries(
      sourceIds.map((id) => [id, { type: 'boolean' }]),
    ),
    required: sourceIds,
    additionalProperties: false,
  }
  let submitted: Record<string, boolean> | undefined
  let accepted = false
  const tool: WorkflowAgentTool = {
    name: 'submit_workflow_condition',
    description:
      'Submit exactly one boolean per active upstream source id, judging whether each source value satisfies the step condition.',
    inputSchema: toolSchema,
    handler: (input) => {
      const check = validator.validateValue(toolSchema, input)
      if (!check.ok)
        return {
          isError: true,
          content: `Invalid submission: ${check.message}`,
        }
      if (accepted)
        return {
          isError: true,
          content:
            'submit_workflow_condition was already accepted; the workflow ignores further submissions',
        }
      accepted = true
      submitted = input as Record<string, boolean>
      return { content: 'The condition inputs were accepted.' }
    },
  }
  return { tool, getSubmitted: () => submitted }
}

// ---------------------------------------------------------------------------
// mapAgent: three workers over a local index cursor, results stored at their
// original indices, shared abort; the first failure aborts the sibling
// controller and rejects the whole node.
// ---------------------------------------------------------------------------

async function executeMapAgent(
  context: AgentCallContext,
): Promise<WorkflowNodeExecutionResult> {
  const { request } = context
  const { node, upstream, workflowInput, signal } = request
  if (upstream.length !== 1)
    throw new WorkflowNodeExecutionError(
      'invalid-output',
      `mapAgent node "${node.id}" requires exactly one active upstream, got ${upstream.length}`,
    )
  const items = upstream[0].value
  if (!Array.isArray(items))
    throw new WorkflowNodeExecutionError(
      'invalid-output',
      `mapAgent node "${node.id}" input must be an array, got ${valueKind(items)}`,
    )
  if (signal.aborted)
    throw new WorkflowNodeExecutionError('cancelled', 'mapAgent call cancelled')
  if (items.length === 0)
    return {
      value: validateMapResult(node, context.validator, Object.freeze([])),
    }
  const results: JsonValue[] = new Array(items.length)
  let cursor = 0
  let failure: unknown
  const siblingController = new AbortController()
  const combinedSignal = AbortSignal.any([signal, siblingController.signal])
  const worker = async (): Promise<void> => {
    while (!combinedSignal.aborted) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await executeTextAgentNode(context, {
          prompt: JSON.stringify({ workflowInput, index, item: items[index] }),
          signal: combinedSignal,
          outputInstruction: TEXT_OUTPUT_INSTRUCTION,
        })
      } catch (error) {
        if (failure === undefined) failure = error
        siblingController.abort()
        return
      }
    }
  }
  await Promise.all(Array.from({ length: MAP_CONCURRENCY }, () => worker()))
  if (failure !== undefined) throw toError(failure)
  if (signal.aborted)
    throw new WorkflowNodeExecutionError('cancelled', 'mapAgent call cancelled')
  return {
    value: validateMapResult(node, context.validator, Object.freeze(results)),
  }
}

function validateMapResult(
  node: WorkflowNode,
  validator: WorkflowSchemaValidator,
  value: JsonValue,
): JsonValue {
  if (node.outputSchema === undefined) return value
  const check = validator.validateValue(node.outputSchema, value)
  if (!check.ok)
    throw new WorkflowNodeExecutionError(
      'invalid-output',
      `mapAgent node "${node.id}" result failed its schema: ${check.message}`,
    )
  return value
}

function valueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
