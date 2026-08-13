import { v4 as uuidv4 } from 'uuid'

import type {
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
import { type YoloAgentEvent, conversationStateToEvents } from '../agent-api'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import {
  CitationRegistry,
  attachSourcesToLatestAssistant,
} from '../citationRegistry'
import { liveTaskStreamBus } from '../live-stream/taskStreamBus'
import { NativeAgentRuntime } from '../native-runtime'
import type { ProjectTaskBinding } from '../project/types'
import type { AgentConversationState } from '../service'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from '../types'

import {
  SUBAGENT_DEFAULT_SYSTEM_PROMPT,
  SUBAGENT_MAX_AUTO_ITERATIONS,
} from './constants'
import type { DelegatedAssistantProfile } from './delegated-assistant-profile'
import {
  type SubagentParentContext,
  composeParentContextPrompt,
} from './parent-context'
import { truncateLiveTranscriptMessages } from './result-limit'
import { subagentRuntimeRegistry } from './runtime-registry'
import { subagentTaskRegistry } from './task-registry'
import { filterAllowedToolsForSubagent } from './tool-filter'
import type {
  SubagentAcceptedResult,
  SubagentResult,
  SubagentTaskCompletionRecord,
  SubagentTaskRecord,
} from './types'

export type RunSubagentParams = {
  description: string
  prompt: string
  conversationId: string
  source: TaskSource
  parent: SubagentParentContext
  childModel: {
    providerClient: BaseLLMProvider<LLMProvider>
    model: ChatModel
    apiType?: LLMProviderApiType | null
  }
  delegatedProfile?: DelegatedAssistantProfile
  signal?: AbortSignal
  /**
   * Project delivery binding (parent-only): the parent resolves the task,
   * composes its body + acceptance criteria into the child prompt, and binds
   * the delivery back to the task. See project/deliveryBridge.
   */
  projectTask?: ProjectTaskBinding
  /** Durable-session parity identifiers (ephemeral runner defaults below). */
  sessionId?: string
  runSequence?: number
  runKey?: string
}

/**
 * 每次结算都推送完成事件到父会话（R5：消费方按 taskId 去重/追加；subagent 为
 * 纯 ephemeral，每个 taskId 只结算一次）。移植自 backup runner.ts:158。
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
    // `result.usage` is the child's CUMULATIVE per-turn usage, summed by
    // `collectTotalAssistantUsage` over its whole transcript. Project it to the
    // `{ inputTokens, outputTokens }` shape the parent diagnostics consume.
    const cumulativeUsage = updatedRecord.result?.usage
    backgroundTaskCompletionBus.pushCompleted({
      kind: 'subagent',
      taskId: updatedRecord.taskId,
      conversationId: updatedRecord.conversationId,
      record: completionRecord,
      ...(cumulativeUsage
        ? {
            usage: {
              inputTokens: cumulativeUsage.prompt_tokens,
              outputTokens: cumulativeUsage.completion_tokens,
            },
          }
        : {}),
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

/**
 * S3: grace window after the child abort signal fires before the runner
 * force-settles a child whose `runtime.run` never returns (provider call or
 * mcp tool that ignores the abort signal). Without it the registry entry
 * stays `running` forever — the bound project task claim is never released
 * and the parent-side timeout-settled marker is never consumed. The child's
 * own abort path settles in milliseconds, so this is a rarely-reached
 * safety net, not the common path.
 */
export const SUBAGENT_ABORT_SETTLE_GRACE_MS = 10_000

/**
 * F5: cadence at which the runner renews the parent-side subagent deadline
 * while the child is paused on user approval. The parent deadline is
 * heartbeat-driven (liveTaskStreamBus events), and an approval pause produces
 * no events — without this renewal the parent deadline (default 5min) trips
 * at the same wall-clock moment as the child's own autoReject and the whole
 * child run is aborted + breaker incremented, shadowing the intended
 * autoReject fallback. Must stay well below both `APPROVAL_TIMEOUT_MS` and
 * the configured parent `timeoutMs`.
 */
const APPROVAL_PARENT_DEADLINE_RENEWAL_INTERVAL_MS = 60 * 1000

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

// F3: the former exported `buildSubagentInitialRunInput` was the only
// consumer-less duplicate of runChildAgent's inline construction, and NOT
// byte-identical to it (missing `workspaceScope`, shared citationRegistry,
// delegatedRole metadata). Deleted — the inline construction is the single
// source of truth. See the F3 决策点 in the fix report.
async function runChildAgent(
  record: SubagentTaskRecord,
  parent: SubagentParentContext,
  childModel: RunSubagentParams['childModel'],
  delegatedProfile?: DelegatedAssistantProfile,
  promptMessageId?: string,
  runInputOverride?: AgentRuntimeRunInput,
): Promise<void> {
  const startedAt = record.createdAt
  const childUserMessage: ChatUserMessage = {
    role: 'user',
    id: promptMessageId ?? uuidv4(),
    content: null,
    // Task 14 fork（F3 后为唯一构造点）：parent 携带 forkContext +
    // parentMessages（buildSubagentParentContext 从父 run input 快照），
    // none/undefined 时返回原 prompt——与迁移前逐字节一致。
    promptContent: composeParentContextPrompt({
      prompt: record.prompt,
      parentMessages: parent.parentMessages ?? [],
      forkContext: parent.forkContext,
    }),
    mentionables: [],
  }

  // 策略统一走 resolveSubagentRunPolicy：非 delegated 时产出与旧内联构造完全
  // 一致（filterAllowedToolsForSubagent + SUBAGENT_DEFAULT_SYSTEM_PROMPT +
  // SUBAGENT_MAX_AUTO_ITERATIONS），delegated 时按角色覆盖 loop/tools/系统提示。
  const policy = resolveSubagentRunPolicy({ parent, delegatedProfile })
  const loopConfig: AgentRuntimeLoopConfig = policy.loopConfig
  const delegatedRole: DelegatedRoleMetadata | undefined = delegatedProfile
    ? Object.freeze({
        assistantId: delegatedProfile.delegatedRole.id,
        assistantName: delegatedProfile.delegatedRole.name,
      })
    : undefined

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
      // S4: the registry holds the latest snapshot for the task's lifetime
      // (live UI preview), so cap oversized text pieces at the configured
      // `subagentResultMaxChars` — same window the parent-side result
      // injection uses. The final result transcript stays untruncated.
      liveTranscript: truncateLiveTranscriptMessages(snapshot.messages),
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
    runtime,
    mcpManager: parent.mcpManager,
    parentConversationId: record.conversationId,
    parentToolCallId,
    resumeRun,
  })

  try {
    let nextRunInput: AgentRuntimeRunInput = runInput
    while (true) {
      // S3: race the child run against an abort + grace window. An aborted
      // child whose `runtime.run` never returns would otherwise keep the
      // registry entry `running` forever (project claim stuck, parent
      // timeout-settled marker leaked). When the grace expires the race is
      // won below and the loop breaks into the normal settle path (aborted).
      const runPromise = runWithBackgroundExecution(() =>
        runtime.run(nextRunInput),
      )
      let forceSettle: (() => void) | undefined
      const abortSettlePromise = new Promise<void>((resolve) => {
        forceSettle = resolve
      })
      let abortGraceHandle: ReturnType<typeof setTimeout> | undefined
      const startAbortGrace = () => {
        abortGraceHandle = setTimeout(() => {
          forceSettle?.()
        }, SUBAGENT_ABORT_SETTLE_GRACE_MS)
      }
      if (abortController.signal.aborted) {
        startAbortGrace()
      } else {
        abortController.signal.addEventListener('abort', startAbortGrace, {
          once: true,
        })
      }
      await Promise.race([runPromise, abortSettlePromise])
      abortController.signal.removeEventListener('abort', startAbortGrace)
      if (abortGraceHandle !== undefined) {
        clearTimeout(abortGraceHandle)
        abortGraceHandle = undefined
      }
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
      // F5: the child produces no heartbeat while paused on approval, so the
      // parent deadline would otherwise trip at the same moment as this
      // autoReject window and abort the whole child (+ breaker increment),
      // shadowing the intended per-call fallback. Renew the parent deadline
      // while the gate is open so the child's own autoReject fires first.
      // Dynamic import keeps the madge edge dynamic (accepted repo pattern;
      // see localFileTools delegate_subagent case).
      const { renewParentSubagentDeadline } = await import(
        './pending-timeout-registry'
      )
      const renewalHandle = setInterval(() => {
        // No-op when the parent deadline is not (or no longer) registered.
        renewParentSubagentDeadline(parentToolCallId)
      }, APPROVAL_PARENT_DEADLINE_RENEWAL_INTERVAL_MS)
      try {
        await new Promise<void>((resolve) => {
          approvalResolver = resolve
        })
      } finally {
        clearTimeout(timeoutHandle)
        clearInterval(renewalHandle)
      }
      if (abortController.signal.aborted) {
        break
      }
      nextRunInput = buildSubagentContinuationInput(runInput)
    }

    const snapshot = runtime.getSnapshot()
    // The child registry collects retrieval hits during the run (bash
    // `search`); attach them to the final transcript so SubagentDetailModal's
    // message rendering shows the source cards (same shape as the main chat).
    const finalMessages = attachSourcesToLatestAssistant(
      snapshot.messages,
      citationRegistry,
    )
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
      ...(delegatedRole ? { delegatedRole } : {}),
      // F2/F11: role display name — write site (projected by the service onto
      // the parent subagent_result message).
      ...(delegatedProfile
        ? { delegatedRoleName: delegatedProfile.delegatedRole.name }
        : {}),
    }

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
      ...(delegatedRole ? { delegatedRole } : {}),
      ...(delegatedProfile
        ? { delegatedRoleName: delegatedProfile.delegatedRole.name }
        : {}),
    }
    subagentTaskRegistry.update(record.taskId, {
      status,
      completedAt,
      error: errorMessage,
      activityLog: activityLines.join('\n'),
      result,
    })
  } finally {
    subagentRuntimeRegistry.unregister(record.taskId)
    abortController.signal.removeEventListener('abort', abortListener)
    // Defensive: if the loop is still sleeping in `await new Promise(...)`,
    // ensure the gate is resolved so we don't leak the promise on the
    // exception path either.
    wakeApprovalGate()
    // Settlement must run unconditionally — the catch branch lands here too,
    // instead of relying on "no return in catch → fall through to the code
    // after try/catch/finally" (a future `return` in catch would silently
    // break the parent-side settlement). A push failure is logged and does
    // not change the run's terminal semantics.
    unsubscribe()
    try {
      publishBackgroundSubagentCompletion(record)
    } catch (settleError) {
      console.error(
        '[YOLO][Subagent] failed to publish completion',
        settleError,
      )
    }
  }
}

export async function runSubagent(
  params: RunSubagentParams,
): Promise<SubagentAcceptedResult> {
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
      projectTask,
      sessionId,
      runSequence,
      runKey,
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

    // 纯 ephemeral：每次派发都是全新子代理（无 durable session 层），taskId
    // 即唯一身份（与旧 ephemeral 路径同构：sessionId === taskId === sub_xxx）。
    const taskId = `sub_${uuidv4().replace(/-/g, '').slice(0, 12)}`
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
      conversationId,
      source,
      title,
      status: 'running',
      createdAt: Date.now(),
      prompt: taskPrompt,
      abortController,
      // 纯 ephemeral 下 sessionId/runKey/runSequence 的缺省与 backup runner
      // `record.runKey ?? ${taskId}:${runSequence ?? 1}` 同语义：
      // sessionId === taskId === sub_xxx、runKey === taskId、runSequence === 1。
      ...(projectTask ? { projectTask } : {}),
      ...(sessionId ? { sessionId } : { sessionId: taskId }),
      ...(runSequence !== undefined ? { runSequence } : { runSequence: 1 }),
      ...(runKey ? { runKey } : { runKey: taskId }),
    }

    subagentTaskRegistry.register(record)

    // fire-and-forget（Task 7 审查 #3：不得 await 子 run 阻塞父 turn——
    // runSubagent 立即返回 accepted，交付靠 pushCompleted 事件）。
    void runChildAgent(record, parent, childModel, delegatedProfile)
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
          ...(delegatedRole ? { delegatedRole } : {}),
          ...(delegatedProfile
            ? { delegatedRoleName: delegatedProfile.delegatedRole.name }
            : {}),
        }
        subagentTaskRegistry.update(record.taskId, {
          status,
          completedAt,
          error: errorMessage,
          result,
        })
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
      title,
      status: 'running',
      note: 'Subagent started asynchronously. The result will arrive as a follow-up background event when the child run completes.',
      modelName: childModel.model.name ?? childModel.model.model,
    }
  } catch (error) {
    if (params.signal && abortListener) {
      params.signal.removeEventListener('abort', abortListener)
      abortListener = undefined
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export function abortAllSubagentTasks(): void {
  subagentTaskRegistry.abortAll()
}
