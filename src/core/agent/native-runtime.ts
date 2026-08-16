import { v4 as uuidv4 } from 'uuid'

import {
  ChatAssistantMessage,
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
  getLatestChatConversationCompaction,
  normalizeChatConversationCompactionState,
} from '../../types/chat'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
import type { ReasoningLevel } from '../../types/reasoning'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { runWithLLMDebugTrace } from '../llm/debugCapture'

import { composeAgentInjections } from './agent-injections'
import { backgroundTaskCompletionBus } from './background-task/completion-bus'
import {
  type AutoContextCompactionNoticeTier,
  buildAutoContextCompactionNoticeMessage,
  buildCompactedConversationState,
  createConversationCompactionSummary,
  findCompactInstruction,
  findCompactToolCallId,
  getAutoContextCompactionPromptTrigger,
  getLastAssistantPromptTokens,
  shouldPromptAutoContextCompactionTier,
} from './compaction'
import { AgentLlmTurnExecutor } from './llm-turn-executor'
import { applyLoopPolicy } from './loop-policy'
import { createAgentLoopWorker } from './loop-worker'
import {
  applyRepeatedReadCallGuard,
  createRepeatedReadCallGuardState,
} from './repeated-read-call-guard'
import {
  applyRepeatedToolFailureGuard,
  createRepeatedToolFailureGuardState,
} from './repeated-tool-failure-guard'
import { estimateContinuationRequestContextTokens } from './requestContextEstimate'
import type { ResponsesContinuation } from './responsesContinuation'
import { AgentRuntime } from './runtime'
import { buildSubagentParentContext } from './subagent/parent-context'
import {
  PARENT_SUBAGENT_TIMEOUT_ERROR,
  clearParentSubagentDeadline,
  clearParentSubagentTimeoutSettled,
  hasParentSubagentDeadline,
  isParentSubagentDeadlineExpired,
  markParentSubagentTimeoutSettled,
  recordParentSubagentTimeout,
  registerParentSubagentDeadline,
} from './subagent/pending-timeout-registry'
import { subagentTaskRegistry } from './subagent/task-registry'
import { DELEGATE_SUBAGENT_TOOL_SHORT_NAME } from './subagent/tool-name-utils'
import type {
  SubagentTaskCompletionRecord,
  SubagentTaskSummary,
} from './subagent/types'
import { AgentToolGateway } from './tool-gateway'
import { shouldProceedToToolPhase } from './tool-phase'
import {
  AgentRuntimeLoopConfig,
  AgentRuntimeRunInput,
  AgentRuntimeSnapshot,
  AgentRuntimeSubscribe,
  AgentWorkerOutbound,
} from './types'

export const ASSISTANT_CONTINUATION_PROMPT =
  'The previous assistant response was interrupted before completion. Resume the same task exactly where it stopped. Do not repeat, revise, summarize, or acknowledge content already produced. Continue using tools if needed.'

/**
 * Strip the MCP server prefix (and any `/`/`:` namespace) from a fully
 * qualified tool name, mirroring the loop worker's `normalizeToolSignature`
 * short-name rule so the runtime and the worker derive identical signatures.
 */
const toShortToolName = (toolName: string): string =>
  toolName.includes('__')
    ? toolName.slice(toolName.indexOf('__') + 2)
    : (toolName.split(/[/:]/).pop() ?? toolName)

const isDelegateSubagentToolName = (toolName: string): boolean =>
  toShortToolName(toolName) === DELEGATE_SUBAGENT_TOOL_SHORT_NAME

/** Locate the child task record (if any) whose parent tool call is `toolCallId`. */
const findSubagentTaskByParentToolCall = (
  toolCallId: string,
): SubagentTaskSummary | undefined =>
  subagentTaskRegistry
    .list()
    .find(
      (record) =>
        record.source.type === 'llm_tool_call' &&
        record.source.toolCallId === toolCallId,
    )

/**
 * Synthetic completion text injected when a parent `delegate_subagent` call
 * expires without a heartbeat (pre `native-runtime.ts:183-185`).
 */
const SUBAGENT_TIMEOUT_CONTENT =
  'The delegated subagent did not respond before its deadline, so this delegation timed out and the child run was aborted. The parent agent may retry with a different approach or take over the task directly.'

/**
 * Derive the exact-duplicate-call guard signature payload from the executed
 * tool message: the executed tool name plus key-sorted arguments. Multiple
 * executed calls in one round serialize as a composite array signature so the
 * whole round must repeat identically to trip the guard. Empty when no tool
 * actually executed (e.g. approval placeholders only).
 *
 * Exported for the unit test suite. Not part of the public runtime API.
 */
export const buildExecutedToolSignature = (
  toolMessage: ChatToolMessage,
): { toolName?: string; toolArgs?: unknown } => {
  const executedToolCalls = toolMessage.toolCalls.filter(
    (toolCall) =>
      toolCall.response.status === ToolCallResponseStatus.Success ||
      toolCall.response.status === ToolCallResponseStatus.Error,
  )
  if (executedToolCalls.length === 0) {
    return {}
  }
  if (executedToolCalls.length === 1) {
    return {
      toolName: toShortToolName(executedToolCalls[0].request.name),
      toolArgs:
        getToolCallArgumentsObject(executedToolCalls[0].request.arguments) ??
        {},
    }
  }
  return {
    toolName: toShortToolName(executedToolCalls[0].request.name),
    toolArgs: executedToolCalls.map((toolCall) => ({
      name: toShortToolName(toolCall.request.name),
      args: getToolCallArgumentsObject(toolCall.request.arguments) ?? {},
    })),
  }
}

export class NativeAgentRuntime implements AgentRuntime {
  private subscribers: AgentRuntimeSubscribe[] = []
  private messages: ChatMessage[] = []
  private compactionState: ChatConversationCompactionState = []
  private pendingCompactionAnchorMessageId: string | null = null
  private runAbortController: AbortController | null = null
  /**
   * Tool call ids this runtime registered a parent subagent deadline for during
   * the current run. The run's `finally` tears these down (see
   * `teardownSubagentDeadlines`) so a stale timer cannot fire into an abandoned
   * conversation after the run ends and the module-level registry would
   * otherwise keep the entry + settled marker alive for the plugin lifetime.
   */
  private registeredSubagentDeadlineToolCallIds = new Set<string>()

  constructor(private readonly loopConfig: AgentRuntimeLoopConfig) {}

  subscribe(callback: AgentRuntimeSubscribe): () => void {
    this.subscribers.push(callback)
    return () => {
      this.subscribers = this.subscribers.filter((cb) => cb !== callback)
    }
  }

  getMessages(): ChatMessage[] {
    return this.messages
  }

  getSnapshot(): AgentRuntimeSnapshot {
    return {
      messages: [...this.messages],
      compaction: [...this.compactionState],
      pendingCompactionAnchorMessageId: this.pendingCompactionAnchorMessageId,
    }
  }

  abort(): void {
    if (this.runAbortController) {
      this.runAbortController.abort()
      this.runAbortController = null
    }
  }

  async run(input: AgentRuntimeRunInput): Promise<void> {
    const inputRequestMessages = input.requestMessages ?? input.messages
    const resumeAssistantMessage = input.continueAssistantMessageId
      ? inputRequestMessages.find(
          (message): message is ChatAssistantMessage =>
            message.role === 'assistant' &&
            message.id === input.continueAssistantMessageId,
        )
      : undefined
    if (input.continueAssistantMessageId && !resumeAssistantMessage) {
      throw new Error('Interrupted assistant message is no longer available.')
    }
    const requestMessages = resumeAssistantMessage
      ? inputRequestMessages.map((message) =>
          message.id === resumeAssistantMessage.id &&
          message.role === 'assistant'
            ? { ...message, toolCallRequests: undefined }
            : message,
        )
      : inputRequestMessages
    const ongoingRequestMessages = resumeAssistantMessage
      ? requestMessages.filter(
          (message) => message.id !== resumeAssistantMessage.id,
        )
      : requestMessages
    this.compactionState = normalizeChatConversationCompactionState(
      input.compaction,
    )
    this.pendingCompactionAnchorMessageId = null
    const localAbortController = new AbortController()
    this.runAbortController = localAbortController

    const abortSignal = this.mergeAbortSignals(
      input.abortSignal,
      localAbortController.signal,
    )

    if (this.shouldUseSingleTurnFastPath()) {
      try {
        await this.runSingleTurnFastPath(
          input,
          abortSignal,
          requestMessages,
          resumeAssistantMessage,
        )
        this.scheduleMemoryAgent(input, abortSignal)
      } finally {
        if (this.runAbortController === localAbortController) {
          this.runAbortController = null
        }
      }
      return
    }

    const toolGateway = new AgentToolGateway(input.mcpManager, {
      toolsEnabled: this.loopConfig.enableTools,
      allowedToolNames: input.allowedToolNames,
      enableToolDisclosure: input.enableToolDisclosure,
      toolPreferences: input.toolPreferences,
      builtinCapabilityPreferences: input.builtinCapabilityPreferences,
      toolServerPreferences: input.toolServerPreferences,
      workspaceAccessPolicy: input.workspaceAccessPolicy,
      allowedSkillPaths: input.allowedSkillPaths,
      apiType: input.apiType,
      subagentParentContext: input.systemPromptOverride
        ? undefined
        : buildSubagentParentContext(input, this.loopConfig),
      isSubagentChildRun: Boolean(input.systemPromptOverride),
      toolApprovalConversationId: input.toolApprovalConversationId,
      blockedCommandPrefixes: input.blockedCommandPrefixes,
      bypassToolApproval: input.bypassToolApproval,
      bashReadOnly: input.bashReadOnly,
    })
    const worker = createAgentLoopWorker()
    const runId = uuidv4()

    let pendingToolMessageId: string | null = null
    let pendingToolCallCount = 0
    let currentDebugTraceId: string | undefined
    let currentSourceUserMessageId = input.sourceUserMessageId
    // Per-turn cache-warm prefix + tools the executor actually sent, plus the
    // `this.messages` boundary before this turn's LLM request. The compaction
    // bypass reuses these to build a byte-identical out-of-band request.
    let currentTurnRequestMessages: RequestMessage[] = []
    let currentTurnRequestTools: RequestTool[] | undefined
    let currentTurnRequestReasoning: ReasoningLevel | undefined
    let currentTurnMessageBoundary = 0
    let runSettled = false
    let workerTaskQueue = Promise.resolve()
    let abortListener: (() => void) | null = null
    let repeatedReadCallGuardState = createRepeatedReadCallGuardState()
    let repeatedToolFailureGuardState = createRepeatedToolFailureGuardState()
    // Per-run auto-compaction notice dedup: the highest tier already injected
    // this run. Only a strictly higher tier re-notifies while the model has
    // not compacted; completing a compaction resets this (see below).
    let promptedAutoCompactionTier: AutoContextCompactionNoticeTier | null =
      null
    let pendingResumeAssistantMessage = resumeAssistantMessage
    // Per-run Responses continuation handle. Carries the prior response id and
    // the accumulated tool-output input items across turns; `undefined` for
    // non-Responses providers and after handle-reset fallback turns.
    let responsesContinuation: ResponsesContinuation | undefined = undefined

    /**
     * Run a continuing default decision (`llm_request`/`tool_phase`) through
     * the registered main-thread loop policy BEFORE the runtime acts on it.
     * Returns true when the policy stops the decision; the caller then sends
     * the worker a `stop` message so it settles the run as completed. Returns
     * false immediately when no policy is registered (byte-for-byte default).
     */
    const shouldStopByLoopPolicy = async (
      message: Extract<
        AgentWorkerOutbound,
        { type: 'llm_request' | 'tool_phase' }
      >,
    ): Promise<boolean> => {
      const policy = this.loopConfig.policy
      if (!policy) return false
      const result = await applyLoopPolicy({
        input: {
          conversationId: input.conversationId,
          branchId: input.branchId ?? '',
          iteration: message.type === 'llm_request' ? message.iteration : 0,
          defaultDecision:
            message.type === 'llm_request'
              ? { type: 'llm_request', nextIteration: message.iteration }
              : { type: 'tool_phase' },
        },
        policy,
      })
      return result.type === 'stop'
    }

    const runCompletion = new Promise<void>((resolve, reject) => {
      const handleWorkerMessage = (message: AgentWorkerOutbound): void => {
        if (message.runId !== runId) {
          return
        }

        workerTaskQueue = workerTaskQueue
          .then(async () => {
            switch (message.type) {
              case 'llm_request': {
                if (abortSignal.aborted) {
                  worker.postMessage({ type: 'abort', runId })
                  return
                }
                if (await shouldStopByLoopPolicy(message)) {
                  worker.postMessage({ type: 'stop', runId })
                  return
                }

                if (input.drainPendingUserMessages) {
                  const drained = input.drainPendingUserMessages()
                  if (drained) {
                    currentSourceUserMessageId = drained.sourceUserMessageId
                    for (const injectedMessage of drained.messages) {
                      this.messages.push(injectedMessage)
                    }
                    this.notifySubscribers()
                  }
                }

                const resumedMessageForTurn = pendingResumeAssistantMessage
                pendingResumeAssistantMessage = undefined
                const conversationMessages = [
                  ...(resumedMessageForTurn
                    ? requestMessages
                    : ongoingRequestMessages),
                  ...this.messages,
                ]
                const autoContextCompactionNoticeResult =
                  this.buildAutoContextCompactionNotice({
                    input,
                    messages: conversationMessages,
                    promptedTier: promptedAutoCompactionTier,
                  })
                if (autoContextCompactionNoticeResult) {
                  promptedAutoCompactionTier =
                    autoContextCompactionNoticeResult.tier
                }
                const autoContextCompactionNotice =
                  autoContextCompactionNoticeResult?.message
                const llmTurnExecutorInput: ConstructorParameters<
                  typeof AgentLlmTurnExecutor
                >[0] = {
                  providerClient: input.providerClient,
                  model: input.model,
                  requestContextBuilder: input.requestContextBuilder,
                  mcpManager: input.mcpManager,
                  conversationId: input.conversationId,
                  messages: conversationMessages,
                  branchId: input.branchId,
                  sourceUserMessageId: currentSourceUserMessageId,
                  branchLabel: input.branchLabel,
                  compaction: this.compactionState,
                  enableTools: this.loopConfig.enableTools,
                  includeBuiltinTools: this.loopConfig.includeBuiltinTools,
                  apiType: input.apiType,
                  allowedToolNames: input.allowedToolNames,
                  enableToolDisclosure: input.enableToolDisclosure,
                  toolPreferences: input.toolPreferences,
                  toolServerPreferences: input.toolServerPreferences,
                  allowedSkillPaths: input.allowedSkillPaths,
                  abortSignal,
                  reasoningLevel: input.reasoningLevel,
                  requestParams: input.requestParams,
                  contextualInjections: composeAgentInjections({
                    baseInjections: input.contextualInjections,
                    messages: conversationMessages,
                  }),
                  toolCapabilityMode: input.toolCapabilityMode,
                  modePersonaPrompt: input.modePersonaPrompt,
                  modePersonaModuleId: input.modePersonaModuleId,
                  moduleChatModeId: input.moduleChatModeId,
                  contextPolicy: input.contextPolicy,
                  transientRequestMessages: autoContextCompactionNotice
                    ? [
                        autoContextCompactionNotice,
                        ...(resumedMessageForTurn
                          ? [
                              {
                                role: 'user' as const,
                                content: ASSISTANT_CONTINUATION_PROMPT,
                              },
                            ]
                          : []),
                      ]
                    : resumedMessageForTurn
                      ? [
                          {
                            role: 'user' as const,
                            content: ASSISTANT_CONTINUATION_PROMPT,
                          },
                        ]
                      : undefined,
                  resumeAssistantMessage: resumedMessageForTurn,
                  geminiTools: input.geminiTools,
                  systemPromptOverride: input.systemPromptOverride,
                  onAssistantMessage: (assistantMessage) => {
                    this.upsertAssistantMessage(assistantMessage)
                    this.notifySubscribers()
                  },
                }

                // Record the boundary before the LLM request: messages added
                // after this point (this turn's assistant + tool) are the
                // compaction `turnMessages`.
                currentTurnMessageBoundary = this.messages.length

                /**
                 * Run the LLM turn, retrying ONCE on the full message-history
                 * path when a stateful continuation request (`previous_response_id`
                 * + accumulated `input`) is rejected/errors. The spec requires
                 * falling back to message history whenever continuation is
                 * unavailable; a provider rejection of the continuation request
                 * is exactly that.
                 */
                const runTurnWithContinuationFallback = async (): Promise<
                  Awaited<ReturnType<AgentLlmTurnExecutor['run']>>
                > => {
                  const runOnce = (
                    continuation: ResponsesContinuation | undefined,
                  ) => {
                    const executor = new AgentLlmTurnExecutor({
                      ...llmTurnExecutorInput,
                      responsesContinuation: continuation,
                    })
                    return executor.run()
                  }
                  try {
                    return await runOnce(responsesContinuation)
                  } catch (error) {
                    const continuationInFlight =
                      responsesContinuation?.previousResponseId != null
                    const isAbort =
                      abortSignal.aborted ||
                      (error instanceof Error && error.name === 'AbortError')
                    if (!continuationInFlight || isAbort) {
                      throw error
                    }
                    // The failed continuation turn may have upserted a partial
                    // assistant message after `currentTurnMessageBoundary`;
                    // truncate it so the retry starts from a clean transcript,
                    // then clear the handle so the adapter resends the full
                    // message history.
                    this.messages = this.messages.slice(
                      0,
                      currentTurnMessageBoundary,
                    )
                    responsesContinuation = undefined
                    return runOnce(undefined)
                  }
                }

                const turnResult = await runTurnWithContinuationFallback()
                pendingToolMessageId = null
                pendingToolCallCount = turnResult.toolCallRequests.length
                currentDebugTraceId = turnResult.debugTraceId
                currentTurnRequestMessages = turnResult.requestMessages
                currentTurnRequestTools = turnResult.requestTools
                currentTurnRequestReasoning = turnResult.requestReasoning
                // Carry the per-run Responses handle forward so the next turn
                // appends tool outputs and reuses the response id. `undefined`
                // for non-Responses providers and after handle-reset turns.
                responsesContinuation = turnResult.responsesContinuation

                worker.postMessage({
                  type: 'llm_result',
                  runId,
                  hasToolCalls: shouldProceedToToolPhase(turnResult),
                  hasAssistantOutput: turnResult.hasAssistantOutput,
                })
                return
              }
              case 'tool_phase': {
                if (abortSignal.aborted) {
                  worker.postMessage({ type: 'abort', runId })
                  return
                }
                if (await shouldStopByLoopPolicy(message)) {
                  worker.postMessage({ type: 'stop', runId })
                  return
                }

                const toolCallRequests =
                  this.getLatestToolCallRequests(pendingToolCallCount)
                const initialToolMessage = toolGateway.createToolMessage({
                  toolCallRequests,
                  conversationId: input.conversationId,
                  branchId: input.branchId,
                  sourceUserMessageId: currentSourceUserMessageId,
                  branchModelId: input.model.id,
                  branchLabel:
                    input.branchLabel ??
                    input.model.name ??
                    input.model.model ??
                    input.model.id,
                })
                pendingToolMessageId = initialToolMessage.id

                this.messages.push(initialToolMessage)
                this.notifySubscribers()

                // Register a wall-clock deadline for every `delegate_subagent`
                // call that enters this round in `Running` (auto-approved
                // path). The deadline is renewed by the child's observable
                // progress (live task stream heartbeats) and, if it expires,
                // settles the call as `error`, aborts the child, injects a
                // synthetic timeout result, and increments the conversation's
                // breaker. Approval-paused calls are registered by the service
                // when the user approves them (see `AgentService.approveToolCall`).
                await this.registerSubagentDeadlines({
                  toolMessage: initialToolMessage,
                  conversationId: input.conversationId,
                  toolGateway,
                })

                const completedToolMessage = await runWithLLMDebugTrace(
                  currentDebugTraceId,
                  () =>
                    toolGateway.executeAutoToolCalls({
                      toolMessage: initialToolMessage,
                      conversationId: input.conversationId,
                      conversationMessages: [
                        ...ongoingRequestMessages,
                        ...this.messages,
                      ],
                      conversationCompaction: this.compactionState,
                      signal: abortSignal,
                      chatModelId: input.model.id,
                      debugTraceId: currentDebugTraceId,
                    }),
                )
                const readGuardedToolResult = applyRepeatedReadCallGuard({
                  state: repeatedReadCallGuardState,
                  toolMessage: completedToolMessage,
                })
                repeatedReadCallGuardState = readGuardedToolResult.state

                const guardedToolResult = applyRepeatedToolFailureGuard({
                  state: repeatedToolFailureGuardState,
                  toolMessage: readGuardedToolResult.toolMessage,
                })
                repeatedToolFailureGuardState = guardedToolResult.state
                const guardedToolMessage = guardedToolResult.toolMessage
                const forceStopReason =
                  readGuardedToolResult.forceStopReason ??
                  guardedToolResult.forceStopReason

                this.replaceToolMessage(guardedToolMessage)
                this.notifySubscribers()

                // Re-assert the `error` settlement on delegated calls whose
                // deadline expired while the batch was executing, then clear
                // deadlines whose dispatch failed without admitting a child.
                this.reassertExpiredSubagentDeadlines(guardedToolMessage)
                this.cleanupSettledSubagentDeadlines(guardedToolMessage)

                const compactToolCallId =
                  findCompactToolCallId(guardedToolMessage)
                if (compactToolCallId) {
                  this.pendingCompactionAnchorMessageId = guardedToolMessage.id
                  this.notifySubscribers()

                  const conversationMessages = [
                    ...ongoingRequestMessages,
                    ...this.messages,
                  ]

                  // This turn's new assistant + tool messages (incl. the
                  // context_compact call/result), converted with the same
                  // parsing as the main request pipeline.
                  const turnMessages =
                    input.requestContextBuilder.parseTurnMessagesToRequestMessages(
                      this.messages.slice(currentTurnMessageBoundary),
                    )
                  const focusInstruction =
                    findCompactInstruction(completedToolMessage)

                  console.debug('[YOLO][Compact] compact trigger detected', {
                    conversationId: input.conversationId,
                    triggerToolCallId: compactToolCallId,
                    messageCount: conversationMessages.length,
                    prefixMessageCount: currentTurnRequestMessages.length,
                    turnMessageCount: turnMessages.length,
                  })

                  try {
                    const summary = await createConversationCompactionSummary({
                      providerClient: input.providerClient,
                      model: input.model,
                      requestMessages: currentTurnRequestMessages,
                      turnMessages,
                      focusInstruction,
                      tools: currentTurnRequestTools,
                      reasoningLevel: currentTurnRequestReasoning,
                      debugTraceId: currentDebugTraceId,
                      signal: abortSignal,
                    })
                    const nextCompaction =
                      await buildCompactedConversationState({
                        messages: conversationMessages,
                        summary,
                        summaryModelId: input.model.id,
                      })
                    if (nextCompaction) {
                      const preCompactionTokens =
                        getLastAssistantPromptTokens(conversationMessages)
                      // These token counts are presentation-only. Publish the
                      // usable compaction state immediately and estimate in the
                      // background so the next Agent LLM turn is not held behind
                      // a second full context/tokenizer pass.
                      void estimateContinuationRequestContextTokens({
                        requestContextBuilder: input.requestContextBuilder,
                        mcpManager: input.mcpManager,
                        model: input.model,
                        messages: conversationMessages,
                        conversationId: input.conversationId,
                        compaction: nextCompaction,
                        enableTools: this.loopConfig.enableTools,
                        includeBuiltinTools:
                          this.loopConfig.includeBuiltinTools,
                        apiType: input.apiType,
                        allowedToolNames: input.allowedToolNames,
                        enableToolDisclosure: input.enableToolDisclosure,
                        toolPreferences: input.toolPreferences,
                        toolServerPreferences: input.toolServerPreferences,
                        contextualInjections: composeAgentInjections({
                          baseInjections: input.contextualInjections,
                          messages: conversationMessages,
                        }),
                        toolCapabilityMode: input.toolCapabilityMode,
                        modePersonaPrompt: input.modePersonaPrompt,
                        modePersonaModuleId: input.modePersonaModuleId,
                        moduleChatModeId: input.moduleChatModeId,
                        contextPolicy: input.contextPolicy,
                      })
                        .then((estimatedNextContextTokens) => {
                          const saved =
                            typeof preCompactionTokens === 'number'
                              ? preCompactionTokens - estimatedNextContextTokens
                              : undefined
                          // Published compaction entries are immutable once
                          // notified; replace by reference instead of
                          // mutating the entry already handed to subscribers.
                          this.compactionState = this.compactionState.map(
                            (entry) =>
                              entry === nextCompaction
                                ? {
                                    ...entry,
                                    estimatedNextContextTokens,
                                    ...(saved !== undefined && saved > 0
                                      ? { estimatedTokensSaved: saved }
                                      : {}),
                                  }
                                : entry,
                          )
                          this.notifySubscribers()
                        })
                        .catch((error) => {
                          console.warn(
                            '[YOLO][Compact] failed to estimate continuation context tokens',
                            error,
                          )
                        })
                    }
                    this.compactionState = nextCompaction
                      ? [...this.compactionState, nextCompaction]
                      : this.compactionState
                    this.pendingCompactionAnchorMessageId = null
                    // The model compacted: allow fresh auto-compaction
                    // notices again (per-run tier dedup reset).
                    promptedAutoCompactionTier = null
                    this.notifySubscribers()
                  } catch (error) {
                    this.pendingCompactionAnchorMessageId = null
                    this.notifySubscribers()
                    throw error
                  }

                  const latestCompaction = getLatestChatConversationCompaction(
                    this.compactionState,
                  )
                  console.debug('[YOLO][Compact] compact state ready', {
                    conversationId: input.conversationId,
                    anchorMessageId: latestCompaction?.anchorMessageId,
                    triggerToolCallId: latestCompaction?.triggerToolCallId,
                  })

                  worker.postMessage({
                    type: 'tool_result',
                    runId,
                    hasPendingTools: false,
                    forceStopReason,
                    ...buildExecutedToolSignature(guardedToolMessage),
                  })
                  return
                }

                worker.postMessage({
                  type: 'tool_result',
                  runId,
                  hasPendingTools:
                    toolGateway.hasPendingToolCalls(guardedToolMessage),
                  forceStopReason,
                  ...buildExecutedToolSignature(guardedToolMessage),
                })
                return
              }
              case 'done': {
                runSettled = true
                resolve()
                return
              }
              case 'error': {
                runSettled = true
                reject(new Error(message.error))
                return
              }
            }
          })
          .catch((error: unknown) => {
            if (runSettled) {
              return
            }
            runSettled = true
            reject(
              error instanceof Error
                ? error
                : new Error(
                    typeof error === 'string' ? error : 'Unknown runtime error',
                  ),
            )
          })
      }

      worker.subscribe(handleWorkerMessage)

      abortListener = () => {
        worker.postMessage({ type: 'abort', runId })
        if (pendingToolMessageId) {
          this.markToolMessageAborted(pendingToolMessageId)
          this.notifySubscribers()
        }
      }
      abortSignal.addEventListener('abort', abortListener, { once: true })

      worker.postMessage({
        type: 'start',
        runId,
        maxIterations: this.loopConfig.maxAutoIterations,
        // Grace stays OFF by default (spec §6) until telemetry justifies it.
        ...(this.loopConfig.graceEnabled
          ? { graceEnabled: this.loopConfig.graceEnabled }
          : {}),
      })
    })

    try {
      await runCompletion
      this.scheduleMemoryAgent(input, abortSignal)
    } finally {
      if (abortListener) {
        abortSignal.removeEventListener('abort', abortListener)
      }
      worker.terminate()
      this.teardownSubagentDeadlines(abortSignal.aborted)
      if (this.runAbortController === localAbortController) {
        this.runAbortController = null
      }
    }
  }

  /**
   * Queue hidden memory extraction after a run settles. Subagent child runs
   * and aborted runs never extract; the hook is provided by the service layer.
   */
  private scheduleMemoryAgent(
    input: AgentRuntimeRunInput,
    signal: AbortSignal,
  ): void {
    // Subagent child runs (identified by a system-prompt override) never
    // extract memory; aborted runs skip extraction too.
    if (Boolean(input.systemPromptOverride) || signal.aborted) return

    input.enqueueMemoryExtraction?.({
      messages: [...input.messages, ...this.messages],
      providerClient: input.providerClient,
      model: input.model,
      assistantId: input.assistantId,
      requestContextBuilder: input.requestContextBuilder,
      signal,
    })
  }

  private shouldUseSingleTurnFastPath(): boolean {
    return (
      !this.loopConfig.enableTools && this.loopConfig.maxAutoIterations <= 1
    )
  }

  private buildAutoContextCompactionNotice({
    input,
    messages,
    promptedTier,
  }: {
    input: AgentRuntimeRunInput
    messages: ChatMessage[]
    promptedTier: AutoContextCompactionNoticeTier | null
  }): {
    message: RequestMessage
    tier: AutoContextCompactionNoticeTier
  } | null {
    if (!this.loopConfig.enableTools || !input.autoContextCompaction) {
      return null
    }

    const trigger = getAutoContextCompactionPromptTrigger({
      messages,
      chatOptions: input.autoContextCompaction.chatOptions,
      maxContextTokens: input.autoContextCompaction.maxContextTokens,
      compactionState: this.compactionState,
    })
    if (!trigger) {
      return null
    }

    // Per-run dedup: equal/lower tiers already prompted stay silent until the
    // model actually compacts (which resets `promptedAutoCompactionTier`).
    if (
      !shouldPromptAutoContextCompactionTier({
        tier: trigger.tier,
        promptedTier,
      })
    ) {
      return null
    }

    return {
      message: buildAutoContextCompactionNoticeMessage({
        trigger,
        chatOptions: input.autoContextCompaction.chatOptions,
      }),
      tier: trigger.tier,
    }
  }

  private async runSingleTurnFastPath(
    input: AgentRuntimeRunInput,
    abortSignal: AbortSignal,
    requestMessages: ChatMessage[],
    resumeAssistantMessage?: ChatAssistantMessage,
  ): Promise<void> {
    const llmTurnExecutor = new AgentLlmTurnExecutor({
      providerClient: input.providerClient,
      model: input.model,
      requestContextBuilder: input.requestContextBuilder,
      mcpManager: input.mcpManager,
      conversationId: input.conversationId,
      messages: [...requestMessages, ...this.messages],
      enableTools: false,
      includeBuiltinTools: false,
      apiType: input.apiType,
      allowedToolNames: input.allowedToolNames,
      toolPreferences: input.toolPreferences,
      toolServerPreferences: input.toolServerPreferences,
      allowedSkillPaths: input.allowedSkillPaths,
      abortSignal,
      reasoningLevel: input.reasoningLevel,
      requestParams: input.requestParams,
      contextualInjections: input.contextualInjections,
      toolCapabilityMode: input.toolCapabilityMode,
      modePersonaPrompt: input.modePersonaPrompt,
      modePersonaModuleId: input.modePersonaModuleId,
      moduleChatModeId: input.moduleChatModeId,
      contextPolicy: input.contextPolicy,
      geminiTools: input.geminiTools,
      systemPromptOverride: input.systemPromptOverride,
      transientRequestMessages: resumeAssistantMessage
        ? [
            {
              role: 'user',
              content: ASSISTANT_CONTINUATION_PROMPT,
            },
          ]
        : undefined,
      resumeAssistantMessage,
      onAssistantMessage: (assistantMessage) => {
        this.upsertAssistantMessage(assistantMessage)
        this.notifySubscribers()
      },
    })

    await llmTurnExecutor.run()
  }

  private notifySubscribers(): void {
    const snapshot = this.getSnapshot()
    this.subscribers.forEach((callback) => {
      callback(snapshot)
    })
  }

  private upsertAssistantMessage(message: ChatAssistantMessage): void {
    const existingIndex = this.messages.findIndex(
      (item) => item.id === message.id,
    )
    if (existingIndex >= 0) {
      this.messages[existingIndex] = message
      return
    }
    this.messages.push(message)
  }

  private getLatestToolCallRequests(expectedCount: number): ToolCallRequest[] {
    if (expectedCount <= 0) {
      return []
    }

    for (let index = this.messages.length - 1; index >= 0; index--) {
      const candidate = this.messages[index]
      if (candidate.role !== 'assistant') {
        continue
      }

      const requests = candidate.toolCallRequests ?? []
      if (requests.length === 0) {
        return []
      }
      if (requests.length !== expectedCount) {
        return requests
      }
      return requests
    }

    return []
  }

  private replaceToolMessage(message: ChatToolMessage): void {
    const index = this.messages.findIndex((item) => item.id === message.id)
    if (index === -1) {
      this.messages.push(message)
      return
    }
    this.messages[index] = message
  }

  private markToolMessageAborted(toolMessageId: string): void {
    const index = this.messages.findIndex(
      (message) => message.id === toolMessageId,
    )
    if (index === -1) {
      return
    }
    const message = this.messages[index]
    if (message.role !== 'tool') {
      return
    }
    this.messages[index] = {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) =>
        toolCall.response.status === ToolCallResponseStatus.Running
          ? {
              ...toolCall,
              response: { status: ToolCallResponseStatus.Aborted },
            }
          : toolCall,
      ),
    }
  }

  /**
   * Register a wall-clock deadline for every `delegate_subagent` tool call that
   * just entered `Running` (the auto-approved path, executed by the tool
   * gateway). The deadline is renewed by the child's observable progress (live
   * task stream heartbeats) and, if it expires, `handleSubagentDeadlineExpiry`
   * settles the call as `error`, aborts the child, injects a synthetic timeout
   * result, and increments the conversation's breaker. Approval-paused calls
   * are handled at approval time by the service (see
   * `AgentService.registerApprovedSubagentDeadline`).
   */
  private async registerSubagentDeadlines({
    toolMessage,
    conversationId,
    toolGateway,
  }: {
    toolMessage: ChatToolMessage
    conversationId: string
    toolGateway: AgentToolGateway
  }): Promise<void> {
    for (const toolCall of toolMessage.toolCalls) {
      if (toolCall.response.status !== ToolCallResponseStatus.Running) continue
      if (!isDelegateSubagentToolName(toolCall.request.name)) continue
      const toolCallId = toolCall.request.id
      if (hasParentSubagentDeadline(toolCallId)) continue
      registerParentSubagentDeadline({
        toolCallId,
        conversationId,
        onExpire: ({
          toolCallId: expiredToolCallId,
          conversationId: expiredConversationId,
        }) => {
          this.handleSubagentDeadlineExpiry({
            toolCallId: expiredToolCallId,
            conversationId: expiredConversationId,
            toolGateway,
          })
        },
      })
      this.registeredSubagentDeadlineToolCallIds.add(toolCallId)
    }
  }

  private handleSubagentDeadlineExpiry({
    toolCallId,
    conversationId,
    toolGateway,
  }: {
    toolCallId: string
    conversationId: string
    toolGateway: AgentToolGateway
  }): void {
    // 1. Abort the child run through the existing per-task abort path.
    const childTask = findSubagentTaskByParentToolCall(toolCallId)
    if (childTask) {
      subagentTaskRegistry.abort(childTask.taskId)
    }
    // 2. Settle a still-in-flight tool executor so the parent tool phase can
    //    return (the tool gateway otherwise blocks on the hung dispatch).
    toolGateway.abortToolCall(toolCallId)
    // 3. Record the timeout settlement in the survival set (independent of the
    //    deadline entry, which the service clears synchronously when it injects
    //    the synthetic result) so the re-assert path and the double-injection
    //    guard both keep working.
    markParentSubagentTimeoutSettled(toolCallId)
    // 4. Mark the tool call `error` so `hasPendingToolCalls` returns false.
    //    Master's `ToolCallResponseStatus` has no `timeout` variant, so the
    //    `PARENT_SUBAGENT_TIMEOUT_ERROR` marker on the error carries the
    //    settlement classification.
    this.setToolCallResponse(toolCallId, {
      status: ToolCallResponseStatus.Error,
      error: PARENT_SUBAGENT_TIMEOUT_ERROR,
    })
    // 5. Inject a synthetic timeout result through the same completion bus the
    //    subagent runner uses, mirroring the service's completion-injection
    //    path (`buildBackgroundTaskResultMessage`).
    const syntheticRecord = this.buildSubagentTimeoutCompletionRecord({
      toolCallId,
      childTask,
      conversationId,
    })
    backgroundTaskCompletionBus.pushCompleted({
      kind: 'subagent',
      taskId: syntheticRecord.taskId,
      conversationId: syntheticRecord.conversationId,
      record: syntheticRecord,
    })
    // 6. Increment the per-conversation breaker.
    recordParentSubagentTimeout(conversationId)
  }

  private buildSubagentTimeoutCompletionRecord({
    toolCallId,
    childTask,
    conversationId,
  }: {
    toolCallId: string
    childTask?: SubagentTaskSummary
    conversationId: string
  }): SubagentTaskCompletionRecord {
    const now = Date.now()
    const located = this.findToolCall(toolCallId)
    const requestArgs = located
      ? getToolCallArgumentsObject(located.toolCall.request.arguments)
      : undefined
    const title =
      typeof requestArgs?.description === 'string'
        ? requestArgs.description
        : 'Subagent task'
    const prompt =
      typeof requestArgs?.prompt === 'string' ? requestArgs.prompt : ''
    const taskId = childTask?.taskId ?? `sub_timeout_${toolCallId}`
    const createdAt = childTask?.createdAt ?? now
    return {
      taskId,
      conversationId,
      source: {
        type: 'llm_tool_call',
        toolCallId,
        assistantMessageId: this.findSourceAssistantMessageId(toolCallId),
      },
      title,
      status: 'aborted',
      createdAt,
      completedAt: now,
      prompt,
      activityLog: '[state] subagent timed out',
      error: PARENT_SUBAGENT_TIMEOUT_ERROR,
      result: {
        taskId,
        status: 'aborted',
        content: SUBAGENT_TIMEOUT_CONTENT,
        activityLog: '[state] subagent timed out',
        durationMs: now - createdAt,
        toolUseCount: 0,
        prompt,
        ...(childTask?.result?.modelName
          ? { modelName: childTask.result.modelName }
          : {}),
      },
    }
  }

  private findSourceAssistantMessageId(toolCallId: string): string {
    const toolMessageIndex = this.messages.findIndex(
      (message) =>
        message.role === 'tool' &&
        message.toolCalls.some(
          (toolCall) => toolCall.request.id === toolCallId,
        ),
    )
    if (toolMessageIndex === -1) return ''
    for (let index = toolMessageIndex - 1; index >= 0; index -= 1) {
      if (this.messages[index].role === 'assistant') {
        return this.messages[index].id
      }
    }
    return ''
  }

  /**
   * After the tool gateway returns, re-assert the `error` response on any
   * delegated call whose deadline expired while the batch was executing. The
   * gateway may have overwritten the expiry handler's `error` with the late
   * executor result (Success/Aborted/Error), so this keeps the settled state
   * authoritative for `hasPendingToolCalls` and the transcript.
   */
  private reassertExpiredSubagentDeadlines(toolMessage: ChatToolMessage): void {
    for (const toolCall of toolMessage.toolCalls) {
      if (!isParentSubagentDeadlineExpired(toolCall.request.id)) continue
      this.setToolCallResponse(toolCall.request.id, {
        status: ToolCallResponseStatus.Error,
        error: PARENT_SUBAGENT_TIMEOUT_ERROR,
      })
      // No child task was admitted for this call, so no child completion can
      // race in afterwards — the timeout-settled marker is no longer needed.
      // If a child WAS admitted, keep the marker so the service discards the
      // child's own (abort) completion (no double result injection).
      if (!findSubagentTaskByParentToolCall(toolCall.request.id)) {
        clearParentSubagentTimeoutSettled(toolCall.request.id)
      }
    }
  }

  /**
   * Clear deadlines whose tool call settled to a terminal non-Success outcome
   * (the dispatch failed, so no child is running). `Success` calls keep their
   * deadline so a child admitted to the background can still time out if it
   * never emits a heartbeat; the service clears it when the result lands.
   * Expired deadlines are also kept — the `error` settlement is terminal and
   * the service clears them when the synthetic timeout result is consumed.
   */
  private cleanupSettledSubagentDeadlines(toolMessage: ChatToolMessage): void {
    for (const toolCall of toolMessage.toolCalls) {
      if (!hasParentSubagentDeadline(toolCall.request.id)) continue
      if (isParentSubagentDeadlineExpired(toolCall.request.id)) continue
      const status = toolCall.response.status
      if (
        status === ToolCallResponseStatus.Running ||
        status === ToolCallResponseStatus.Success
      ) {
        continue
      }
      clearParentSubagentDeadline(toolCall.request.id)
    }
  }

  /**
   * Run-scoped teardown of the deadlines + settled markers this runtime
   * registered, invoked from `run()`'s `finally`. Without it the module-level
   * registry would keep entries alive for the plugin lifetime:
   *
   * - An aborted parent run abandons the conversation. Every registered
   *   deadline + settled marker is cleared so a stale `setTimeout` cannot fire
   *   later and `handleSubagentDeadlineExpiry` injects a synthetic timeout into
   *   the abandoned conversation and increments the breaker.
   * - A settled run keeps a background-admitted child's deadline (its tool
   *   call settled `Success`; the service clears it when the child's result
   *   lands), but tears down every other call's deadline and, when no live
   *   child task remains, its settled marker (the marker is the
   *   double-injection guard until a child's own completion lands).
   */
  private teardownSubagentDeadlines(aborted: boolean): void {
    for (const toolCallId of this.registeredSubagentDeadlineToolCallIds) {
      if (aborted) {
        clearParentSubagentDeadline(toolCallId)
        clearParentSubagentTimeoutSettled(toolCallId)
        continue
      }
      const located = this.findToolCall(toolCallId)
      if (
        located?.toolCall.response.status === ToolCallResponseStatus.Success
      ) {
        continue
      }
      clearParentSubagentDeadline(toolCallId)
      if (!findSubagentTaskByParentToolCall(toolCallId)) {
        clearParentSubagentTimeoutSettled(toolCallId)
      }
    }
    this.registeredSubagentDeadlineToolCallIds.clear()
  }

  /**
   * Locate a `tool` message that contains the given `toolCallId`. Returns the
   * containing message and the tool call entry for read access. Used by the
   * subagent approval routing path to bridge service-level approve/reject
   * actions back into a child runtime.
   */
  findToolCall(toolCallId: string): {
    toolMessage: ChatToolMessage
    toolCall: { request: ToolCallRequest; response: ToolCallResponse }
  } | null {
    for (const message of this.messages) {
      if (message.role !== 'tool') continue
      const toolCall = message.toolCalls.find(
        (entry) => entry.request.id === toolCallId,
      )
      if (toolCall) {
        return { toolMessage: message, toolCall }
      }
    }
    return null
  }

  /**
   * Replace the response on a single tool call inside this runtime's messages.
   * Notifies subscribers so the SubagentCard / parent UI re-renders.
   *
   * Used by the subagent approval routing path:
   *   - approve: flip PendingApproval → Running → Success/Error
   *   - reject: flip PendingApproval → Rejected
   *   - timeout: flip PendingApproval → Rejected with structured error
   */
  setToolCallResponse(toolCallId: string, response: ToolCallResponse): boolean {
    let didPatch = false
    this.messages = this.messages.map((message) => {
      if (message.role !== 'tool') return message
      let messageUpdated = false
      const nextToolCalls = message.toolCalls.map((toolCall) => {
        if (toolCall.request.id !== toolCallId) return toolCall
        didPatch = true
        messageUpdated = true
        return { ...toolCall, response }
      })
      return messageUpdated ? { ...message, toolCalls: nextToolCalls } : message
    })
    if (didPatch) {
      this.notifySubscribers()
    }
    return didPatch
  }

  private mergeAbortSignals(
    externalSignal: AbortSignal | undefined,
    localSignal: AbortSignal,
  ): AbortSignal {
    if (!externalSignal) {
      return localSignal
    }
    const controller = new AbortController()

    const tryAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort()
      }
    }

    if (externalSignal.aborted || localSignal.aborted) {
      tryAbort()
      return controller.signal
    }

    externalSignal.addEventListener('abort', tryAbort, { once: true })
    localSignal.addEventListener('abort', tryAbort, { once: true })

    return controller.signal
  }
}
