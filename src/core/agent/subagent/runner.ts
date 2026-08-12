import { v4 as uuidv4 } from 'uuid'

import type {
  ChatConversationCompactionLike,
  ChatMessage,
  ChatUserMessage,
  DelegatedRoleMetadata,
  TaskSource,
} from '../../../types/chat'
import type { ChatModel } from '../../../types/chat-model.types'
import type {
  LLMProvider,
  LLMProviderApiType,
} from '../../../types/provider.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { collectTotalAssistantUsage } from '../../../utils/chat/llmUsage'
import { formatErrorMessageWithCauses } from '../../../utils/error-message'
import { runWithBackgroundExecution } from '../../background/backgroundExecutionController'
import type { BaseLLMProvider } from '../../llm/base'
import {
  AGENT_SESSION_MODE,
  type AgentSessionMode,
} from '../../state/contracts'
import { SUBAGENT_SESSION_STATUS } from '../../state/statuses'
import { type YoloAgentEvent, conversationStateToEvents } from '../agent-api'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import { CitationRegistry } from '../citationRegistry'
import { liveTaskStreamBus } from '../live-stream/taskStreamBus'
import { NativeAgentRuntime } from '../native-runtime'
import type { AgentConversationState } from '../service'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from '../types'

import {
  type ResolvedCurrentSubagentParentAuthority,
  type SubagentAuthorityResolverDependencies,
  resolveCurrentSubagentParentAuthority,
} from './authority-resolver'
import {
  SUBAGENT_DEFAULT_SYSTEM_PROMPT,
  SUBAGENT_MAX_AUTO_ITERATIONS,
} from './constants'
import type { DelegatedAssistantProfile } from './delegated-assistant-profile'
import type { SubagentParentContext } from './parent-context'
import { subagentRuntimeRegistry } from './runtime-registry'
import {
  type SubagentSessionService,
  getSubagentSessionService,
} from './session-service'
import {
  type SubagentResultSummary,
  type SubagentRun,
  type SubagentSession,
  makeSubagentRunKey,
} from './session-types'
import { subagentTaskRegistry } from './task-registry'
import { filterAllowedToolsForSubagent } from './tool-filter'
import type {
  SubagentAcceptedResult,
  SubagentResult,
  SubagentTaskCompletionRecord,
  SubagentTaskRecord,
} from './types'

export type SubagentSessionGatewayLike = Pick<
  SubagentSessionService,
  'settleRun' | 'query' | 'deliverQueuedIntents'
>

export type SubagentRunSettlement = {
  sessionId: string
  runKey: string
  status: SubagentResultSummary['status']
  result: SubagentResultSummary
  transcript?: ChatMessage[]
  completedAt: number
}

export type SubagentRunSettlementFailure = {
  settlement: SubagentRunSettlement
  error: unknown
}

export type RunSubagentParams = {
  description: string
  prompt: string
  conversationId: string
  source: TaskSource
  /** Durable session identity (defaults to a fresh ephemeral session id). */
  sessionId?: string
  runSequence?: number
  mode?: AgentSessionMode
  parent: SubagentParentContext
  childModel: {
    providerClient: BaseLLMProvider<LLMProvider>
    model: ChatModel
    apiType?: LLMProviderApiType | null
  }
  delegatedProfile?: DelegatedAssistantProfile
  signal?: AbortSignal
  settleRun?: (settlement: SubagentRunSettlement) => void | Promise<void>
  onSettleFailure?: (
    failure: SubagentRunSettlementFailure,
  ) => void | Promise<void>
  sessionGateway?: SubagentSessionGatewayLike
}

/**
 * 持久化结算（backup runner.ts:110-156 移植，settlement 形状适配 master
 * SubagentSessionService.settleRun 的输入）：settle 失败仅记录诊断日志并回调
 * onSettleFailure，不中断内存态更新（任务记录照常置终态、reservation 照常释放）。
 */
const settleRunDurably = async (
  settleRun: RunSubagentParams['settleRun'],
  onSettleFailure: RunSubagentParams['onSettleFailure'],
  record: SubagentTaskRecord,
  result: SubagentResult,
  completedAt: number,
): Promise<void> => {
  if (!settleRun) return
  const settlement: SubagentRunSettlement = {
    sessionId: record.sessionId ?? record.taskId,
    runKey:
      record.runKey ??
      makeSubagentRunKey(
        record.sessionId ?? record.taskId,
        record.runSequence ?? 1,
      ),
    status: result.status,
    result: {
      status: result.status,
      content: result.content,
      durationMs: result.durationMs,
      toolUseCount: result.toolUseCount,
      ...(result.modelName ? { modelName: result.modelName } : {}),
    },
    ...(result.transcript ? { transcript: result.transcript } : {}),
    completedAt,
  }
  try {
    await settleRun(settlement)
  } catch (error) {
    console.error('[YOLO] Failed to settle subagent run durably', error)
    try {
      await onSettleFailure?.({ settlement, error })
    } catch (diagnosticError) {
      console.error(
        '[YOLO] Failed to report subagent settlement failure',
        diagnosticError,
      )
    }
  }
}

/**
 * 每次结算（含续跑）都推送完成事件到父会话（R5：消费方按 taskId 去重/追加，
 * 不带 backup 的 runSequence === 1 条件；事件 record 带 runKey 区分各 run）。
 * 移植自 backup runner.ts:158。
 */
const publishBackgroundSubagentCompletion = (
  record: SubagentTaskRecord,
): void => {
  const updatedRecord = subagentTaskRegistry.get(record.taskId)
  if (updatedRecord && updatedRecord.status !== 'running') {
    const { abortController: _abortController, ...recordWithoutAbort } = record
    const completionRecord: SubagentTaskCompletionRecord = {
      ...recordWithoutAbort,
      ...updatedRecord,
      ...(record.liveTranscript
        ? { liveTranscript: record.liveTranscript }
        : {}),
    }
    backgroundTaskCompletionBus.pushCompleted({
      kind: 'subagent',
      taskId: updatedRecord.taskId,
      conversationId: updatedRecord.conversationId,
      record: completionRecord,
    })
  }
}

function countToolUses(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.role !== 'tool') {
      return count
    }
    return (
      count +
      message.toolCalls.filter(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.Success,
      ).length
    )
  }, 0)
}

/**
 * True when the subagent's last `tool` message still has a tool call awaiting
 * user approval (or the equivalent `ask_user_question` paused state). The
 * runtime returns from `run()` in this case (loop-worker emits `done` when
 * `hasPendingTools=true`), but the work is NOT actually complete — we should
 * wait for `approveToolCall` / `rejectToolCall` to resolve it and then
 * continue, instead of pushing a (false) completion to the parent.
 */
function hasUnresolvedApproval(messages: ChatMessage[]): boolean {
  const last = messages.at(-1)
  if (!last || last.role !== 'tool') return false
  return last.toolCalls.some(
    (toolCall) =>
      toolCall.response.status === ToolCallResponseStatus.PendingApproval ||
      toolCall.response.status === ToolCallResponseStatus.AwaitingUserInput,
  )
}

/**
 * A paused parallel tool batch may contain a mixture of calls that are still
 * awaiting a decision and calls that the user already approved but are still
 * executing. The subagent must not continue until every call in that batch
 * has reached a terminal response.
 */
export function hasUnsettledApprovalBatch(messages: ChatMessage[]): boolean {
  const last = messages.at(-1)
  if (!last || last.role !== 'tool') return false
  return last.toolCalls.some(
    (toolCall) =>
      toolCall.response.status === ToolCallResponseStatus.PendingApproval ||
      toolCall.response.status === ToolCallResponseStatus.AwaitingUserInput ||
      toolCall.response.status === ToolCallResponseStatus.Running,
  )
}

/**
 * NativeAgentRuntime keeps assistant/tool messages in its own transcript
 * across repeated `run()` calls. A continuation must therefore reuse only
 * the original request-message prefix; feeding the runtime snapshot back as
 * `input.messages` would append the same transcript twice on the next LLM
 * request and produce an invalid assistant/tool sequence.
 */
export function buildSubagentContinuationInput(
  input: AgentRuntimeRunInput,
): AgentRuntimeRunInput {
  return {
    ...input,
    requestMessages: input.requestMessages ?? input.messages,
  }
}

/**
 * Auto-reject every still-pending tool call on the runtime's last tool
 * message. Used as the 5-minute timeout fallback so a paused subagent does
 * not stall forever if the user never gets around to approving. The error
 * text is intentionally explicit so the model has enough context to decide
 * whether to retry differently or surface the situation to the user.
 *
 * Exported for unit tests; production callers should let the runner's
 * approval gate trigger this on its `setTimeout`.
 */
export function autoRejectPendingApprovals(runtime: NativeAgentRuntime): void {
  const snapshot = runtime.getSnapshot()
  const last = snapshot.messages.at(-1)
  if (!last || last.role !== 'tool') return
  for (const toolCall of last.toolCalls) {
    if (toolCall.response.status === ToolCallResponseStatus.PendingApproval) {
      runtime.setToolCallResponse(toolCall.request.id, {
        status: ToolCallResponseStatus.Error,
        error:
          'Tool approval timed out: the user did not respond within 5 minutes, so this call was auto-rejected. Try a different approach or summarise the situation in your final reply so the user can take over.',
      })
    }
  }
}

/** Auto-reject window for paused subagent tool calls. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export type SubagentRuntimeLoopController = {
  run: () => Promise<ReturnType<NativeAgentRuntime['getSnapshot']>>
  resumeRun: () => Promise<void>
  dispose: () => void
}

/**
 * Runs a child runtime and waits for approval-gated tool batches to settle.
 * Both ephemeral and durable sessions use this controller so a resumed run
 * cannot accidentally grow a second approval/continuation loop.
 */
export function createSubagentRuntimeLoopController({
  runtime,
  runInput,
  abortController,
}: {
  runtime: NativeAgentRuntime
  runInput: AgentRuntimeRunInput
  abortController: AbortController
}): SubagentRuntimeLoopController {
  let approvalResolver: (() => void) | null = null
  let disposed = false

  const wakeApprovalGate = (): void => {
    if (!approvalResolver) return
    approvalResolver()
    approvalResolver = null
  }

  const resumeRun = async (): Promise<void> => {
    if (!hasUnsettledApprovalBatch(runtime.getSnapshot().messages)) {
      wakeApprovalGate()
    }
  }

  const abortListener = (): void => {
    wakeApprovalGate()
  }
  abortController.signal.addEventListener('abort', abortListener, {
    once: true,
  })

  const run = async (): Promise<
    ReturnType<NativeAgentRuntime['getSnapshot']>
  > => {
    let nextRunInput: AgentRuntimeRunInput = runInput
    while (!disposed) {
      await runWithBackgroundExecution(() => runtime.run(nextRunInput))
      const snapshotAfterRun = runtime.getSnapshot()
      if (
        abortController.signal.aborted ||
        !hasUnresolvedApproval(snapshotAfterRun.messages)
      ) {
        return snapshotAfterRun
      }

      const timeoutHandle = setTimeout(() => {
        autoRejectPendingApprovals(runtime)
        void resumeRun()
      }, APPROVAL_TIMEOUT_MS)
      try {
        await new Promise<void>((resolve) => {
          approvalResolver = resolve
        })
      } finally {
        clearTimeout(timeoutHandle)
      }
      if (abortController.signal.aborted) return runtime.getSnapshot()
      nextRunInput = buildSubagentContinuationInput(runInput)
    }
    return runtime.getSnapshot()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    abortController.signal.removeEventListener('abort', abortListener)
    wakeApprovalGate()
  }

  return { run, resumeRun, dispose }
}

function extractLastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant' && message.content.trim().length > 0) {
      return message.content.trim()
    }
  }
  return ''
}

function appendActivityLine(lines: string[], toolCallId: string, line: string) {
  lines.push(line)
  liveTaskStreamBus.push({
    type: 'stderr',
    toolCallId,
    chunk: `${line}\n`,
    ts: Date.now(),
  })
}

function projectSubagentEvent({
  event,
  parentToolCallId,
  activityLines,
}: {
  event: YoloAgentEvent
  parentToolCallId: string
  activityLines: string[]
}): string | undefined {
  if (event.type === 'state') {
    if (event.status === 'running') {
      liveTaskStreamBus.push({
        type: 'status',
        toolCallId: parentToolCallId,
        status: 'running',
      })
    }
    return undefined
  }

  if (event.type === 'tool') {
    appendActivityLine(
      activityLines,
      parentToolCallId,
      `[tool] ${event.name} ${event.status}`,
    )
    return undefined
  }

  if (event.type === 'completed') {
    if (event.text) {
      liveTaskStreamBus.push({
        type: 'stdout',
        toolCallId: parentToolCallId,
        chunk: event.text,
        ts: Date.now(),
      })
    }
    appendActivityLine(activityLines, parentToolCallId, '[state] completed')
    liveTaskStreamBus.push({
      type: 'status',
      toolCallId: parentToolCallId,
      status: 'done',
    })
    return event.text
  }

  if (event.type === 'error') {
    appendActivityLine(
      activityLines,
      parentToolCallId,
      `[error] ${event.message}`,
    )
    liveTaskStreamBus.push({
      type: 'status',
      toolCallId: parentToolCallId,
      status: 'done',
    })
  }

  return undefined
}

/**
 * Resolves the child run policy from a delegated role profile when present,
 * otherwise from the generic parent capabilities (behind the subagent
 * deny-list). Ported from backup runner.ts:254-306; fields absent from the
 * master runtime input (`rejectToolApproval` / `temporaryApprovedToolNames`)
 * and the R1-excluded `isSubagentChildRun` flag are intentionally dropped.
 */
export function resolveSubagentRunPolicy({
  parent,
  delegatedProfile,
}: {
  parent: SubagentParentContext
  delegatedProfile?: DelegatedAssistantProfile
}) {
  if (delegatedProfile) {
    return {
      loopConfig: delegatedProfile.loopConfig,
      allowedToolNames: filterAllowedToolsForSubagent(
        delegatedProfile.allowedToolNames,
      ),
      toolPreferences: delegatedProfile.toolPreferences,
      toolServerPreferences: delegatedProfile.toolServerPreferences,
      workspaceAccessPolicy: parent.workspaceAccessPolicy,
      allowedSkillPaths: delegatedProfile.allowedSkillPaths,
      enableToolDisclosure: parent.enableToolDisclosure,
      reasoningLevel: parent.reasoningLevel,
      requestParams: parent.requestParams,
      requestContextBuilder: delegatedProfile.requestContextBuilder,
      bypassToolApproval: parent.bypassToolApproval,
      systemPromptOverride: undefined,
    }
  }

  return {
    loopConfig: {
      enableTools: parent.loopConfig.enableTools,
      includeBuiltinTools: parent.loopConfig.includeBuiltinTools,
      maxAutoIterations: SUBAGENT_MAX_AUTO_ITERATIONS,
    },
    allowedToolNames: filterAllowedToolsForSubagent(parent.allowedToolNames),
    toolPreferences: parent.toolPreferences,
    toolServerPreferences: parent.toolServerPreferences,
    workspaceAccessPolicy: parent.workspaceAccessPolicy,
    allowedSkillPaths: parent.allowedSkillPaths,
    enableToolDisclosure: parent.enableToolDisclosure,
    reasoningLevel: parent.reasoningLevel,
    requestParams: parent.requestParams,
    requestContextBuilder: parent.requestContextBuilder,
    bypassToolApproval: parent.bypassToolApproval,
    systemPromptOverride: SUBAGENT_DEFAULT_SYSTEM_PROMPT,
  }
}

/** Builds the initial isolated request consumed by the child runtime. */
export function buildSubagentInitialRunInput({
  record,
  parent,
  childModel,
  delegatedProfile,
  promptMessageId,
}: {
  record: SubagentTaskRecord
  parent: SubagentParentContext
  childModel: RunSubagentParams['childModel']
  delegatedProfile?: DelegatedAssistantProfile
  promptMessageId?: string
}): {
  childUserMessage: ChatUserMessage
  runInput: AgentRuntimeRunInput
  loopConfig: AgentRuntimeLoopConfig
} {
  const childUserMessage: ChatUserMessage = {
    role: 'user',
    id: promptMessageId ?? uuidv4(),
    content: null,
    promptContent: record.prompt,
    mentionables: [],
  }
  const policy = resolveSubagentRunPolicy({ parent, delegatedProfile })

  return {
    childUserMessage,
    loopConfig: policy.loopConfig,
    runInput: {
      providerClient: childModel.providerClient,
      model: childModel.model,
      apiType: childModel.apiType,
      messages: [childUserMessage],
      requestMessages: [childUserMessage],
      conversationId: record.taskId,
      sourceUserMessageId: childUserMessage.id,
      assistantId: parent.assistantId,
      requestContextBuilder: policy.requestContextBuilder,
      mcpManager: parent.mcpManager,
      allowedToolNames: policy.allowedToolNames,
      toolPreferences: policy.toolPreferences,
      toolServerPreferences: policy.toolServerPreferences,
      workspaceAccessPolicy: policy.workspaceAccessPolicy,
      allowedSkillPaths: policy.allowedSkillPaths,
      enableToolDisclosure: policy.enableToolDisclosure,
      reasoningLevel: policy.reasoningLevel,
      requestParams: policy.requestParams,
      abortSignal: record.abortController.signal,
      systemPromptOverride: policy.systemPromptOverride,
      toolApprovalConversationId: parent.conversationId,
      bypassToolApproval: policy.bypassToolApproval,
      runContext: { citationRegistry: new CitationRegistry() },
    },
  }
}

type StructuredCloneFunction = <T>(value: T) => T

const cloneSubagentMessages = (
  messages: readonly ChatMessage[],
): ChatMessage[] => {
  const cloneValue = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(cloneValue)
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        cloneValue(child),
      ]),
    )
  }
  const clone = (
    globalThis as typeof globalThis & {
      structuredClone?: StructuredCloneFunction
    }
  ).structuredClone
  if (clone) {
    try {
      return clone(messages) as ChatMessage[]
    } catch {
      return cloneValue(messages) as ChatMessage[]
    }
  }
  return cloneValue(messages) as ChatMessage[]
}

export type SubagentSessionRunInputOptions = {
  session: Pick<SubagentSession, 'sessionId'> &
    Partial<
      Pick<
        SubagentSession,
        'parentConversationId' | 'originBranchId' | 'memoryAssistantId'
      >
    >
  run: Pick<SubagentRun, 'runKey' | 'runSequence' | 'promptMessageId'>
  canonicalMessages: readonly ChatMessage[]
  compaction?: ChatConversationCompactionLike | null
  authority: ResolvedCurrentSubagentParentAuthority
  abortController: AbortController
}

/**
 * Build an isolated child request from the durable session transcript.
 * Ported from backup runner.ts:678-735 (R1: `preparePendingUserMessages` /
 * `onSteerEvent` hooks and `isSubagentChildRun` flag not ported; next_boundary
 * intent delivery uses the master `drainPendingUserMessages` hook instead).
 */
export function buildSubagentSessionRunInput({
  session,
  run,
  canonicalMessages,
  compaction,
  authority,
  abortController,
}: SubagentSessionRunInputOptions): AgentRuntimeRunInput {
  const policySystemPrompt = authority.delegatedProfile
    ? undefined
    : SUBAGENT_DEFAULT_SYSTEM_PROMPT
  const isolatedMessages = cloneSubagentMessages(canonicalMessages)
  return {
    providerClient: authority.providerClient,
    model: authority.model,
    apiType: authority.apiType,
    messages: isolatedMessages,
    requestMessages: isolatedMessages.slice(),
    conversationId: session.sessionId,
    assistantId: authority.conversation?.assistantId ?? undefined,
    runKey: run.runKey,
    branchId: session.originBranchId,
    sourceUserMessageId: run.promptMessageId,
    requestContextBuilder: authority.requestContextBuilder,
    mcpManager: authority.mcpManager,
    compaction,
    abortSignal: abortController.signal,
    enableToolDisclosure: authority.enableToolDisclosure,
    reasoningLevel: authority.reasoningLevel,
    requestParams: authority.requestParams,
    allowedToolNames: [...authority.allowedToolNames],
    toolPreferences: authority.toolPreferences
      ? { ...authority.toolPreferences }
      : undefined,
    toolServerPreferences: authority.toolServerPreferences
      ? { ...authority.toolServerPreferences }
      : undefined,
    workspaceAccessPolicy: authority.workspaceAccessPolicy,
    allowedSkillPaths: [...authority.allowedSkillPaths],
    enqueueMemoryExtraction: undefined,
    systemPromptOverride: policySystemPrompt,
    toolApprovalConversationId:
      session.parentConversationId ?? authority.conversation?.conversationId,
    bypassToolApproval: authority.bypassToolApproval,
    blockedCommandPrefixes: authority.blockedCommandPrefixes
      ? [...authority.blockedCommandPrefixes]
      : undefined,
    runContext: { citationRegistry: new CitationRegistry() },
  }
}

async function runChildAgent(
  record: SubagentTaskRecord,
  parent: SubagentParentContext,
  childModel: RunSubagentParams['childModel'],
  delegatedProfile?: DelegatedAssistantProfile,
  settleRun?: RunSubagentParams['settleRun'],
  onSettleFailure?: RunSubagentParams['onSettleFailure'],
  promptMessageId?: string,
  runInputOverride?: AgentRuntimeRunInput,
): Promise<void> {
  const startedAt = record.createdAt
  const childUserMessage: ChatUserMessage = {
    role: 'user',
    id: promptMessageId ?? uuidv4(),
    content: null,
    promptContent: record.prompt,
    mentionables: [],
  }

  // 策略统一走 resolveSubagentRunPolicy：非 delegated 时产出与旧内联构造完全
  // 一致（filterAllowedToolsForSubagent + SUBAGENT_DEFAULT_SYSTEM_PROMPT +
  // SUBAGENT_MAX_AUTO_ITERATIONS），delegated 时按角色覆盖 loop/tools/系统提示。
  const policy = resolveSubagentRunPolicy({ parent, delegatedProfile })
  const loopConfig: AgentRuntimeLoopConfig = policy.loopConfig

  const runtime = new NativeAgentRuntime(loopConfig)
  const citationRegistry = new CitationRegistry()
  const abortController = record.abortController
  const parentToolCallId = record.source.toolCallId
  const activityLines: string[] = []
  type Tracker = Parameters<typeof conversationStateToEvents>[0]['previous']
  let previous: Tracker = {
    assistantTextById: new Map(),
    toolStatusById: new Map(),
  }

  liveTaskStreamBus.push({
    type: 'status',
    toolCallId: parentToolCallId,
    status: 'starting',
  })
  appendActivityLine(activityLines, parentToolCallId, '[state] starting')

  const runInput: AgentRuntimeRunInput =
    runInputOverride ??
    ({
      providerClient: childModel.providerClient,
      model: childModel.model,
      apiType: childModel.apiType,
      messages: [childUserMessage],
      requestMessages: [childUserMessage],
      conversationId: record.taskId,
      sourceUserMessageId: childUserMessage.id,
      assistantId: parent.assistantId,
      requestContextBuilder: policy.requestContextBuilder,
      mcpManager: parent.mcpManager,
      allowedToolNames: policy.allowedToolNames,
      toolPreferences: policy.toolPreferences,
      toolServerPreferences: policy.toolServerPreferences,
      workspaceScope: parent.workspaceScope,
      workspaceAccessPolicy: policy.workspaceAccessPolicy,
      allowedSkillPaths: policy.allowedSkillPaths,
      enableToolDisclosure: policy.enableToolDisclosure,
      reasoningLevel: policy.reasoningLevel,
      requestParams: policy.requestParams,
      abortSignal: abortController.signal,
      systemPromptOverride: policy.systemPromptOverride,
      toolApprovalConversationId: parent.conversationId,
      bypassToolApproval: policy.bypassToolApproval,
      runContext: { citationRegistry },
    } satisfies AgentRuntimeRunInput)
  const sourceUserMessageId =
    runInput.sourceUserMessageId ?? childUserMessage.id

  const unsubscribe = runtime.subscribe((snapshot) => {
    const state: AgentConversationState = {
      conversationId: record.taskId,
      status: abortController.signal.aborted ? 'aborted' : 'running',
      messages: snapshot.messages,
      compaction: snapshot.compaction,
      pendingCompactionAnchorMessageId:
        snapshot.pendingCompactionAnchorMessageId,
    }
    subagentTaskRegistry.update(record.taskId, {
      liveTranscript: snapshot.messages,
    })
    const nextEvents = conversationStateToEvents({
      state,
      sourceUserMessageId,
      previous,
    })
    previous = nextEvents.nextTracker
    for (const event of nextEvents.events) {
      projectSubagentEvent({
        event,
        parentToolCallId,
        activityLines,
      })
    }
  })

  // While the runtime is paused on a PendingApproval tool call, this promise
  // gates the next loop iteration. Resolved by `resumeRun` (called from
  // `AgentService.approveToolCall` / `rejectToolCall` after they patch the
  // runtime's tool call response). Recreated for each pause so multiple
  // sequential approvals work.
  let approvalResolver: (() => void) | null = null
  const wakeApprovalGate = (): void => {
    if (approvalResolver) {
      approvalResolver()
      approvalResolver = null
    }
  }
  const resumeRun = async (): Promise<void> => {
    if (!hasUnsettledApprovalBatch(runtime.getSnapshot().messages)) {
      wakeApprovalGate()
    }
  }

  // If the user aborts the whole subagent while it's paused on approval, wake
  // the loop so it can exit promptly.
  const abortListener = () => {
    wakeApprovalGate()
  }
  abortController.signal.addEventListener('abort', abortListener, {
    once: true,
  })

  subagentRuntimeRegistry.register({
    taskId: record.taskId,
    sessionId: record.sessionId,
    runSequence: record.runSequence,
    runKey: record.runKey,
    runtime,
    mcpManager: parent.mcpManager,
    parentConversationId: record.conversationId,
    parentToolCallId,
    resumeRun,
  })

  try {
    let nextRunInput: AgentRuntimeRunInput = runInput
    while (true) {
      await runWithBackgroundExecution(() => runtime.run(nextRunInput))
      const snapshotAfterRun = runtime.getSnapshot()
      if (
        abortController.signal.aborted ||
        !hasUnresolvedApproval(snapshotAfterRun.messages)
      ) {
        break
      }
      // Subagent paused on a tool that needs the user's approval. Wait for
      // the SubagentCard's approval block to resolve it, then resume with
      // the patched messages as the continuation input.
      const timeoutHandle = setTimeout(() => {
        // 5-minute fallback: if the user has not approved/rejected, mark every
        // still-pending tool call as Error with a structured message so the
        // model can read "why it failed" and try a different approach. We
        // reject the whole batch (rather than just one) because we cannot
        // know which call the user was on the fence about, and the model's
        // best move is usually to abandon the batch and re-plan.
        autoRejectPendingApprovals(runtime)
        void resumeRun()
      }, APPROVAL_TIMEOUT_MS)
      try {
        await new Promise<void>((resolve) => {
          approvalResolver = resolve
        })
      } finally {
        clearTimeout(timeoutHandle)
      }
      if (abortController.signal.aborted) {
        break
      }
      nextRunInput = buildSubagentContinuationInput(runInput)
    }

    const snapshot = runtime.getSnapshot()
    const finalMessages = snapshot.messages
    const content = extractLastAssistantText(finalMessages)
    const completedEventText =
      projectSubagentEvent({
        event: {
          type: 'completed',
          conversationId: record.taskId,
          text: content,
        },
        parentToolCallId,
        activityLines,
      }) ?? content
    const completedAt = Date.now()
    const result: SubagentResult = {
      taskId: record.taskId,
      status: abortController.signal.aborted ? 'aborted' : 'completed',
      content: completedEventText,
      activityLog: activityLines.join('\n'),
      durationMs: completedAt - startedAt,
      toolUseCount: countToolUses(finalMessages),
      usage: collectTotalAssistantUsage(finalMessages),
      prompt: record.prompt,
      modelName: childModel.model.name ?? childModel.model.model,
      transcript: finalMessages,
      ...(record.delegatedRole ? { delegatedRole: record.delegatedRole } : {}),
    }

    // 持久化结算先行（settle 失败仅诊断日志），再落内存态
    await settleRunDurably(
      settleRun,
      onSettleFailure,
      record,
      result,
      completedAt,
    )
    subagentTaskRegistry.update(record.taskId, {
      status: result.status,
      completedAt,
      liveTranscript: finalMessages,
      result,
    })
  } catch (error) {
    const completedAt = Date.now()
    const status = abortController.signal.aborted ? 'aborted' : 'failed'
    const errorMessage = formatErrorMessageWithCauses(error)
    appendActivityLine(
      activityLines,
      parentToolCallId,
      status === 'aborted' ? '[state] aborted' : `[error] ${errorMessage}`,
    )
    liveTaskStreamBus.push({
      type: 'status',
      toolCallId: parentToolCallId,
      status: 'done',
    })
    const result: SubagentResult = {
      taskId: record.taskId,
      status,
      content: errorMessage,
      activityLog: activityLines.join('\n'),
      durationMs: completedAt - startedAt,
      toolUseCount: 0,
      prompt: record.prompt,
      modelName: childModel.model.name ?? childModel.model.model,
      ...(record.delegatedRole ? { delegatedRole: record.delegatedRole } : {}),
    }
    await settleRunDurably(
      settleRun,
      onSettleFailure,
      record,
      result,
      completedAt,
    )
    subagentTaskRegistry.update(record.taskId, {
      status,
      completedAt,
      error: errorMessage,
      activityLog: activityLines.join('\n'),
      result,
    })
  } finally {
    subagentRuntimeRegistry.unregister(record.taskId)
    // F2：master 的 register/unregister 不会自动释放 reservation（backup 会），
    // 结算/finally 必须显式释放，否则陈旧 reservation 永久挡下一轮 reserve。
    subagentRuntimeRegistry.releaseReservation(record.runKey ?? record.taskId)
    abortController.signal.removeEventListener('abort', abortListener)
    // Defensive: if the loop is still sleeping in `await new Promise(...)`,
    // ensure the gate is resolved so we don't leak the promise on the
    // exception path either.
    wakeApprovalGate()
  }

  unsubscribe()

  // R5：每次结算（含续跑）都推送，不带 runSequence === 1 条件
  publishBackgroundSubagentCompletion(record)
}

/**
 * 简化版 session 接入（替代 backup 的 admitActorSubagent，runner.ts:1312-1426）：
 * 1) session 持久化（spawn/send）已由调用方（Task 8 的 tool / 续跑路径）在
 *    service 侧完成；2) 这里只启动 runChildAgent，settleRun 接线到
 *    service.settleRun（settlement 形状即 service.settleRun 的输入）。
 * 参数中 title/prompt/conversationId/source/sessionGateway 保留以对齐 backup
 * 语义（backup 用它们 dispatch create_session/submit_session_message 命令）。
 */
const admitSessionRun = async ({
  record,
  promptMessageId,
  parent,
  childModel,
  delegatedProfile,
  settleRun,
  onSettleFailure,
}: {
  sessionGateway: SubagentSessionGatewayLike
  record: SubagentTaskRecord
  title: string
  prompt: string
  conversationId: string
  source: TaskSource
  promptMessageId: string
  parent: SubagentParentContext
  childModel: RunSubagentParams['childModel']
  delegatedProfile?: DelegatedAssistantProfile
  settleRun?: RunSubagentParams['settleRun']
  onSettleFailure?: RunSubagentParams['onSettleFailure']
}): Promise<void> => {
  await runChildAgent(
    record,
    parent,
    childModel,
    delegatedProfile,
    settleRun,
    onSettleFailure,
    promptMessageId,
  )
}

export async function runSubagent(
  params: RunSubagentParams,
): Promise<SubagentAcceptedResult> {
  let reservedRunKey: string | undefined
  let abortListener: (() => void) | undefined
  try {
    const {
      description,
      prompt,
      conversationId,
      source,
      parent,
      childModel,
      delegatedProfile,
      signal,
      settleRun,
      onSettleFailure,
      sessionGateway,
    } = params

    if (signal?.aborted) {
      throw new Error('Subagent dispatch was aborted before start.')
    }

    const title = description.trim()
    if (!title) {
      throw new Error('description is required.')
    }
    const taskPrompt = prompt.trim()
    if (!taskPrompt) {
      throw new Error('prompt is required.')
    }

    // Durable session 身份：sessionId 缺省生成临时会话；runSequence 缺省时取
    // 会话上一个 run 的下一个序号（backup runner.ts:1427-1641 语义）。
    const generatedSessionId = `sub_${uuidv4().replace(/-/g, '').slice(0, 12)}`
    if (params.sessionId !== undefined && !params.sessionId.trim()) {
      throw new Error('sessionId is required.')
    }
    const sessionId = params.sessionId?.trim() ?? generatedSessionId
    const previousRecord = subagentTaskRegistry.get(sessionId)
    const runSequence =
      params.runSequence ?? (previousRecord?.runSequence ?? 0) + 1
    if (!Number.isSafeInteger(runSequence) || runSequence < 1) {
      throw new Error('runSequence must be a safe integer greater than zero.')
    }
    const mode = params.mode ?? AGENT_SESSION_MODE.EPHEMERAL
    const runKey = makeSubagentRunKey(sessionId, runSequence)
    if (subagentRuntimeRegistry.getActiveForSession(sessionId)) {
      throw new Error(
        `Subagent session ${sessionId} already has an active run.`,
      )
    }
    if (mode === AGENT_SESSION_MODE.PERSISTENT && !sessionGateway) {
      throw new Error('agent_session_gateway_unavailable')
    }
    if (previousRecord?.status === 'running') {
      throw new Error(
        `Subagent session ${sessionId} already has an active run.`,
      )
    }

    // 预留独占 run 权（backup runner.ts:1448-1451）；释放点在
    // runChildAgent finally / 各 catch（F2：显式 releaseReservation）。
    subagentRuntimeRegistry.reserve({ sessionId, runSequence, runKey })
    reservedRunKey = runKey

    const taskId = sessionId
    const abortController = new AbortController()
    if (signal) {
      abortListener = () => abortController.abort()
      signal.addEventListener('abort', abortListener, { once: true })
    }

    const delegatedRole: DelegatedRoleMetadata | undefined = delegatedProfile
      ? Object.freeze({
          assistantId: delegatedProfile.delegatedRole.id,
          assistantName: delegatedProfile.delegatedRole.name,
        })
      : undefined
    const record: SubagentTaskRecord = {
      taskId,
      sessionId,
      runSequence,
      runKey,
      mode,
      conversationId,
      source,
      title,
      status: 'running',
      createdAt: Date.now(),
      prompt: taskPrompt,
      abortController,
      ...(delegatedRole ? { delegatedRole } : {}),
    }

    subagentTaskRegistry.register(record)

    if (sessionGateway) {
      return admitSessionRun({
        sessionGateway,
        record,
        title,
        prompt: taskPrompt,
        conversationId,
        source,
        promptMessageId: `${runKey}:prompt`,
        parent,
        childModel,
        delegatedProfile,
        settleRun,
        onSettleFailure,
      })
        .then(() => ({
          accepted: true as const,
          taskId,
          sessionId,
          runKey,
          mode,
          title,
          status: 'running' as const,
          note: 'Subagent started asynchronously. The result will arrive as a follow-up background event when the child run completes.',
          modelName: childModel.model.name ?? childModel.model.model,
          ...(delegatedRole ? { delegatedRole } : {}),
        }))
        .catch((error: unknown) => {
          abortController.abort()
          subagentRuntimeRegistry.unregister(record.taskId)
          subagentRuntimeRegistry.releaseReservation(runKey)
          const errorMessage = formatErrorMessageWithCauses(error)
          subagentTaskRegistry.update(record.taskId, {
            status: 'failed',
            completedAt: Date.now(),
            error: errorMessage,
          })
          if (signal && abortListener) {
            signal.removeEventListener('abort', abortListener)
            abortListener = undefined
          }
          throw error instanceof Error ? error : new Error(errorMessage)
        })
    }

    // 无 sessionGateway：现有 ephemeral 路径（runChildAgent 不带 settle，
    // 行为与迁移前完全一致；reservation 由 runChildAgent finally 释放）
    void runChildAgent(
      record,
      parent,
      childModel,
      delegatedProfile,
      settleRun,
      onSettleFailure,
    )
      .catch(async (error: unknown) => {
        const completedAt = Date.now()
        const status = abortController.signal.aborted ? 'aborted' : 'failed'
        abortController.abort()
        const errorMessage = formatErrorMessageWithCauses(error)
        const result: SubagentResult = {
          taskId: record.taskId,
          status,
          content: errorMessage,
          durationMs: completedAt - record.createdAt,
          toolUseCount: 0,
          prompt: record.prompt,
          modelName: childModel.model.name ?? childModel.model.model,
          ...(record.delegatedRole
            ? { delegatedRole: record.delegatedRole }
            : {}),
        }
        await settleRunDurably(
          settleRun,
          onSettleFailure,
          record,
          result,
          completedAt,
        )
        subagentTaskRegistry.update(record.taskId, {
          status,
          completedAt,
          error: errorMessage,
          result,
        })
        subagentRuntimeRegistry.releaseReservation(runKey)
      })
      .finally(() => {
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener)
          abortListener = undefined
        }
      })

    return {
      accepted: true,
      taskId,
      sessionId,
      runKey,
      mode,
      title,
      status: 'running',
      note: 'Subagent started asynchronously. The result will arrive as a follow-up background event when the child run completes.',
      modelName: childModel.model.name ?? childModel.model.model,
      ...(delegatedRole ? { delegatedRole } : {}),
    }
  } catch (error) {
    if (params.signal && abortListener) {
      params.signal.removeEventListener('abort', abortListener)
      abortListener = undefined
    }
    if (reservedRunKey) {
      subagentRuntimeRegistry.releaseReservation(reservedRunKey)
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export function abortAllSubagentTasks(): void {
  subagentTaskRegistry.abortAll()
}

/**
 * 会话续跑入口（Task 9 的 `onIntentRunRequested` 回调）：查询 session →
 * 校验可续跑状态（IDLE/NEEDS_RESUME）→ 经 authority-resolver 重建父上下文与
 * 子模型 → 按 `buildSubagentSessionRunInput` 构造会话 transcript run input →
 * 以 session 身份启动 runChildAgent（reserve + 记录 + settleRun 接线，语义与
 * runSubagent 的 durable 分支一致）。
 *
 * ⚠️ 首 run prompt 落盘：spawn 时 prompt 文本已随 run 记录持久化
 * （session-types.SubagentRun.prompt）；transcript 为空（首 run 未结算、
 * reload 后重建）时用它重建首条 user 消息（id 对齐 run.promptMessageId）。
 * after_run 意图文本的合入与 nextRunSequence 推进属 Task 9 数据流
 * （当前 service 无 run 启动方法，nextRunSequence 恒为 1，续跑前需 Task 9 推进）。
 *
 * deps（app/settings/loadConversationMeta/createProviderClient/createMcpManager）
 * 由 Task 9 的 main.ts 注入；未注册时静默返回（回调入口允许幂等空转）。
 */
export async function runSubagentSessionContinuation(
  sessionId: string,
  deps?: SubagentAuthorityResolverDependencies,
): Promise<void> {
  const service = getSubagentSessionService()
  if (!service) return
  const snapshot = await service.query(sessionId)
  if (!snapshot) return
  const { session } = snapshot
  if (
    session.status !== SUBAGENT_SESSION_STATUS.IDLE &&
    session.status !== SUBAGENT_SESSION_STATUS.NEEDS_RESUME
  ) {
    return
  }
  const currentRun = snapshot.currentRun
  if (!currentRun) return
  if (!deps) return

  const canonicalMessages =
    snapshot.transcriptPage && snapshot.transcriptPage.length > 0
      ? snapshot.transcriptPage
      : currentRun.prompt
        ? [
            {
              role: 'user',
              id: currentRun.promptMessageId,
              content: null,
              promptContent: currentRun.prompt,
              mentionables: [],
            } satisfies ChatUserMessage,
          ]
        : []
  const authority = await resolveCurrentSubagentParentAuthority(deps, session, {
    // resolver 仅消费 parent 的 workspaceAccessPolicy?.workspaceRoot 与
    // reasoningLevel（authority-resolver.ts:139-142）；续跑时父 agent 不在
    // 内存中，目录以默认根兜底，reasoningLevel 走父会话默认。
    conversationId: session.parentConversationId,
  } as unknown as SubagentParentContext)

  const runSequence = session.nextRunSequence
  const runKey = makeSubagentRunKey(sessionId, runSequence)
  const promptMessageId = `${runKey}:prompt`
  const abortController = new AbortController()
  const runInput = buildSubagentSessionRunInput({
    session,
    run: { runKey, runSequence, promptMessageId },
    canonicalMessages,
    compaction: snapshot.compaction ?? null,
    authority,
    abortController,
  })
  const parent: SubagentParentContext = {
    providerClient: authority.providerClient,
    model: authority.model,
    apiType: authority.apiType,
    conversationId: session.parentConversationId,
    allowedToolNames: authority.allowedToolNames,
    toolPreferences: authority.toolPreferences,
    toolServerPreferences: authority.toolServerPreferences,
    workspaceAccessPolicy: authority.workspaceAccessPolicy,
    allowedSkillPaths: authority.allowedSkillPaths,
    enableToolDisclosure: authority.enableToolDisclosure,
    reasoningLevel: authority.reasoningLevel,
    requestParams: authority.requestParams,
    loopConfig: authority.loopConfig,
    requestContextBuilder: authority.requestContextBuilder,
    mcpManager: authority.mcpManager,
    assistantId: authority.conversation?.assistantId,
    bypassToolApproval: authority.bypassToolApproval,
  }
  const record: SubagentTaskRecord = {
    taskId: sessionId,
    sessionId,
    runSequence,
    runKey,
    mode: session.mode,
    conversationId: session.parentConversationId,
    source: {
      type: 'llm_tool_call',
      toolCallId: session.originToolCallId,
      assistantMessageId: session.originAssistantMessageId,
    },
    title: session.title,
    status: 'running',
    createdAt: Date.now(),
    prompt: currentRun.prompt ?? '',
    abortController,
    ...(authority.delegatedProfile
      ? {
          delegatedRole: Object.freeze({
            assistantId: authority.delegatedProfile.delegatedRole.id,
            assistantName: authority.delegatedProfile.delegatedRole.name,
          }),
        }
      : {}),
  }
  subagentTaskRegistry.register(record)
  subagentRuntimeRegistry.reserve({ sessionId, runSequence, runKey })

  try {
    await runChildAgent(
      record,
      parent,
      {
        providerClient: authority.providerClient,
        model: authority.model,
        apiType: authority.apiType,
      },
      authority.delegatedProfile,
      (settlement) => service.settleRun(settlement),
      (failure) => {
        console.error(
          '[YOLO] Failed to settle subagent continuation run durably',
          failure,
        )
      },
      promptMessageId,
      runInput,
    )
  } catch (error) {
    // runChildAgent 同步建立失败（如 reserve/register 冲突）：释放预留，
    // fail-fast 暴露给 Task 9 的调用方（onIntentRunRequested）。
    subagentRuntimeRegistry.releaseReservation(runKey)
    subagentRuntimeRegistry.unregister(record.taskId)
    throw error
  }
}
