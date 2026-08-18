import {
  type ChatAssistantMessage,
  type ChatConversationCompaction,
  type ChatConversationCompactionState,
  type ChatMessage,
  type ChatToolMessage,
  getLatestChatConversationCompaction,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
import type { LLMProvider } from '../../types/provider.types'
import type { ReasoningLevel } from '../../types/reasoning'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'
import { isRequestErrorNonRetryable } from '../ai/requestRetry'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

import {
  type LoadedDeferredToolSchema,
  extractLoadedDeferredToolNames,
  extractLoadedDeferredToolSchemas,
} from './tool-disclosure'

export const CONTEXT_COMPACT_TOOL_NAME = 'context_compact'

/**
 * Per-schema token ceiling for the compaction registry. Schemas bigger than
 * this are intentionally dropped — they bloat every post-compaction request,
 * and the model can always re-disclose them via `load_tool_schemas`. The injected
 * prompt in `requestContextBuilder` tells the model about this fallback.
 */
const LOADED_DEFERRED_TOOL_SCHEMA_TOKEN_LIMIT = 2000

const filterPersistableLoadedDeferredToolSchemas = async (
  schemas: LoadedDeferredToolSchema[],
): Promise<LoadedDeferredToolSchema[]> => {
  const survivors: LoadedDeferredToolSchema[] = []
  for (const schema of schemas) {
    let tokens: number
    try {
      tokens = await estimateJsonTokens(schema)
    } catch (error) {
      console.warn(
        '[YOLO][Compact] failed to estimate schema tokens; dropping',
        schema.name,
        error,
      )
      continue
    }
    if (tokens <= LOADED_DEFERRED_TOOL_SCHEMA_TOKEN_LIMIT) {
      survivors.push(schema)
    } else {
      console.debug(
        '[YOLO][Compact] dropping oversized on-demand tool schema from compaction registry',
        { name: schema.name, tokens },
      )
    }
  }
  return survivors
}

export type AutoContextCompactionChatOptions = {
  autoContextCompactionEnabled: boolean
  autoContextCompactionThresholdMode: 'tokens' | 'ratio'
  autoContextCompactionThresholdTokens: number
  autoContextCompactionThresholdRatio: number
}

export const resolveAutoContextCompactionChatOptions = (chatOptions: {
  autoContextCompactionEnabled?: boolean
  autoContextCompactionThresholdMode?: 'tokens' | 'ratio'
  autoContextCompactionThresholdTokens?: number
  autoContextCompactionThresholdRatio?: number
}): AutoContextCompactionChatOptions => {
  return {
    autoContextCompactionEnabled:
      chatOptions.autoContextCompactionEnabled ?? false,
    autoContextCompactionThresholdMode:
      chatOptions.autoContextCompactionThresholdMode ?? 'tokens',
    autoContextCompactionThresholdTokens:
      chatOptions.autoContextCompactionThresholdTokens ?? 100000,
    autoContextCompactionThresholdRatio:
      chatOptions.autoContextCompactionThresholdRatio ?? 0.8,
  }
}

export type ShouldTriggerAutoContextCompactionInput = {
  previousMessages: ChatMessage[]
  chatOptions: AutoContextCompactionChatOptions
  maxContextTokens: number | undefined
  compactionState: ChatConversationCompactionState
  isConversationRunActive: boolean
}

export type LatestAssistantContextUsage = {
  assistantMessage: ChatAssistantMessage
  promptTokens: number
  maxContextTokens: number | null
  ratio: number | null
  cacheHitRate?: number
}

/**
 * Notice strength tiers for automatic context compaction, derived as
 * proportions of the user's configured threshold (ACP three-tier nudge):
 * - `soft` — reached 50% of the threshold; consider compacting soon.
 * - `warn` — reached 75% of the threshold; compacting is strongly advised.
 * - `must` — reached the configured threshold; compact before substantial new
 *   work (the historical single-threshold behavior).
 */
export type AutoContextCompactionNoticeTier = 'soft' | 'warn' | 'must'

export const AUTO_COMPACTION_SOFT_TIER_RATIO = 0.5
export const AUTO_COMPACTION_WARN_TIER_RATIO = 0.75

/**
 * Absorbs IEEE-754 drift when comparing `usage.ratio` against a multiplied
 * threshold (e.g. 0.8 * 0.75 === 0.6000000000000001), so exact boundary hits
 * resolve to the intended tier.
 */
const AUTO_COMPACTION_TIER_EPSILON = 1e-9

export const AUTO_COMPACTION_TIER_RANK: Record<
  AutoContextCompactionNoticeTier,
  number
> = {
  soft: 1,
  warn: 2,
  must: 3,
}

export type AutoContextCompactionPromptTrigger = LatestAssistantContextUsage & {
  tier: AutoContextCompactionNoticeTier
}

/**
 * Resolve the notice tier for the latest assistant usage, derived
 * proportionally from the user's configured threshold. Returns null below the
 * soft tier.
 */
export const resolveAutoContextCompactionNoticeTier = ({
  latestContextUsage,
  chatOptions,
}: {
  latestContextUsage: LatestAssistantContextUsage
  chatOptions: AutoContextCompactionChatOptions
}): AutoContextCompactionNoticeTier | null => {
  if (chatOptions.autoContextCompactionThresholdMode === 'tokens') {
    const threshold = chatOptions.autoContextCompactionThresholdTokens
    if (latestContextUsage.promptTokens >= threshold) return 'must'
    if (
      latestContextUsage.promptTokens >=
      threshold * AUTO_COMPACTION_WARN_TIER_RATIO
    ) {
      return 'warn'
    }
    if (
      latestContextUsage.promptTokens >=
      threshold * AUTO_COMPACTION_SOFT_TIER_RATIO
    ) {
      return 'soft'
    }
    return null
  }

  if (latestContextUsage.ratio === null) {
    return null
  }

  const ratio = chatOptions.autoContextCompactionThresholdRatio
  if (latestContextUsage.ratio >= ratio) return 'must'
  if (
    latestContextUsage.ratio >=
    ratio * AUTO_COMPACTION_WARN_TIER_RATIO - AUTO_COMPACTION_TIER_EPSILON
  ) {
    return 'warn'
  }
  if (
    latestContextUsage.ratio >=
    ratio * AUTO_COMPACTION_SOFT_TIER_RATIO - AUTO_COMPACTION_TIER_EPSILON
  ) {
    return 'soft'
  }
  return null
}

/**
 * Per-run notice dedup: once a tier has been injected and the model has not
 * compacted, only a strictly higher tier re-notifies; equal or lower tiers
 * stay silent so the notice does not repeat on every LLM turn. Compaction
 * completion resets the prompted tier (the caller owns that reset).
 */
export const shouldPromptAutoContextCompactionTier = ({
  tier,
  promptedTier,
}: {
  tier: AutoContextCompactionNoticeTier
  promptedTier: AutoContextCompactionNoticeTier | null
}): boolean => {
  if (promptedTier === null) {
    return true
  }
  return (
    AUTO_COMPACTION_TIER_RANK[tier] > AUTO_COMPACTION_TIER_RANK[promptedTier]
  )
}

export const getLatestAssistantContextUsage = ({
  messages,
  maxContextTokens,
}: {
  messages: ChatMessage[]
  maxContextTokens: number | undefined
}): LatestAssistantContextUsage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }

    const usage = message.metadata?.usage
    const promptTokens = usage?.prompt_tokens
    if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens)) {
      continue
    }

    const resolvedMaxContextTokens =
      typeof maxContextTokens === 'number' &&
      maxContextTokens > 0 &&
      Number.isFinite(maxContextTokens)
        ? maxContextTokens
        : null
    const cacheReadTokens = usage?.cache_read_input_tokens
    const cacheHitRate =
      typeof cacheReadTokens === 'number' &&
      Number.isFinite(cacheReadTokens) &&
      cacheReadTokens >= 0 &&
      promptTokens > 0
        ? Math.min(1, cacheReadTokens / promptTokens)
        : null

    return {
      assistantMessage: message,
      promptTokens,
      maxContextTokens: resolvedMaxContextTokens,
      ratio:
        resolvedMaxContextTokens === null
          ? null
          : promptTokens / resolvedMaxContextTokens,
      ...(cacheHitRate !== null ? { cacheHitRate } : {}),
    }
  }

  return null
}

export const getAutoContextCompactionPromptTrigger = ({
  messages,
  chatOptions,
  maxContextTokens,
  compactionState,
  promptedAssistantMessageIds,
}: {
  messages: ChatMessage[]
  chatOptions: AutoContextCompactionChatOptions
  maxContextTokens: number | undefined
  compactionState: ChatConversationCompactionState
  promptedAssistantMessageIds?: ReadonlySet<string>
}): AutoContextCompactionPromptTrigger | null => {
  if (!chatOptions.autoContextCompactionEnabled) {
    return null
  }

  const latestContextUsage = getLatestAssistantContextUsage({
    messages,
    maxContextTokens,
  })
  if (!latestContextUsage) {
    return null
  }

  const assistantMessageId = latestContextUsage.assistantMessage.id
  const latestCompaction = getLatestChatConversationCompaction(compactionState)
  const latestCompactionAnchorIndex = latestCompaction
    ? messages.findIndex(
        (message) => message.id === latestCompaction.anchorMessageId,
      )
    : -1
  const latestCompactionAssistantId =
    latestCompactionAnchorIndex > 0 &&
    messages[latestCompactionAnchorIndex - 1]?.role === 'assistant'
      ? messages[latestCompactionAnchorIndex - 1]?.id
      : undefined
  if (
    latestCompaction?.anchorMessageId === assistantMessageId ||
    latestCompactionAssistantId === assistantMessageId
  ) {
    return null
  }
  if (promptedAssistantMessageIds?.has(assistantMessageId)) {
    return null
  }

  const tier = resolveAutoContextCompactionNoticeTier({
    latestContextUsage,
    chatOptions,
  })
  if (tier === null) {
    return null
  }

  return { ...latestContextUsage, tier }
}

/**
 * Whether the latest assistant usage crosses the automatic compaction
 * **must** tier (the configured threshold). Keeps the submit-time active-run
 * guard for callers that need the old boolean shape; the softer nudge tiers
 * (soft/warn) do not count as a must-compact guard.
 */
export const shouldTriggerAutoContextCompaction = ({
  previousMessages,
  chatOptions,
  maxContextTokens,
  compactionState,
  isConversationRunActive,
}: ShouldTriggerAutoContextCompactionInput): boolean => {
  if (!chatOptions.autoContextCompactionEnabled) {
    return false
  }

  if (isConversationRunActive) {
    return false
  }

  const trigger = getAutoContextCompactionPromptTrigger({
    messages: previousMessages,
    chatOptions,
    maxContextTokens,
    compactionState,
  })
  return trigger !== null && trigger.tier === 'must'
}

const buildTierLeadSentence = ({
  tier,
  currentUsageDescription,
  thresholdDescription,
}: {
  tier: AutoContextCompactionNoticeTier
  currentUsageDescription: string
  thresholdDescription: string
}): string => {
  switch (tier) {
    case 'soft':
      return `The previous assistant turn reported ${currentUsageDescription}, which is at least 50% of the user's automatic context compaction threshold (${thresholdDescription}). Consider compacting in the near future to keep the context window healthy.`
    case 'warn':
      return `The previous assistant turn reported ${currentUsageDescription}, which is at least 75% of the user's automatic context compaction threshold (${thresholdDescription}). Compacting soon is strongly recommended — continuing without it may exhaust the context window mid-task.`
    case 'must':
      return `The previous assistant turn reported ${currentUsageDescription}, which has reached the user's automatic context compaction threshold (${thresholdDescription}). Please compact before starting substantial new work.`
  }
}

export const buildAutoContextCompactionNoticeMessage = ({
  trigger,
  chatOptions,
}: {
  trigger: AutoContextCompactionPromptTrigger
  chatOptions: AutoContextCompactionChatOptions
}): RequestMessage => {
  const ratioPercent =
    trigger.ratio === null ? null : Math.round(trigger.ratio * 1000) / 10
  const thresholdDescription =
    chatOptions.autoContextCompactionThresholdMode === 'tokens'
      ? `${chatOptions.autoContextCompactionThresholdTokens} prompt tokens`
      : `${Math.round(chatOptions.autoContextCompactionThresholdRatio * 1000) / 10}% of the configured context window`
  const currentUsageDescription =
    ratioPercent === null
      ? `${trigger.promptTokens} prompt tokens`
      : `${trigger.promptTokens} prompt tokens (${ratioPercent}% of ${trigger.maxContextTokens} max context tokens)`

  return {
    role: 'user',
    content: `<auto_context_compaction_notice>
This is an internal runtime notice, not a user-authored message and not part of the task content.

${buildTierLeadSentence({
  tier: trigger.tier,
  currentUsageDescription,
  thresholdDescription,
})}

You may call \`${CONTEXT_COMPACT_TOOL_NAME}\` at the next appropriate point:
- If the user's current task is essentially complete, or you can finish it in the current response, first complete the task and report the result to the user. Only after reporting the result should you call \`${CONTEXT_COMPACT_TOOL_NAME}\` before starting substantial new work.
- If completing the current task will still take more tool work or a longer continuation, briefly report the current progress to the user first, then call \`${CONTEXT_COMPACT_TOOL_NAME}\` before continuing.

Do not ask the user for permission to compact. Do not mention this internal notice unless it is directly relevant.
</auto_context_compaction_notice>`,
  }
}

const parseCompactOperationResult = (
  text: string,
): {
  tool: string
  toolCallId: string | null
  operation: string
  instruction: string | null
} | null => {
  try {
    const parsed = JSON.parse(text) as {
      tool?: unknown
      toolCallId?: unknown
      operation?: unknown
      instruction?: unknown
    }
    return typeof parsed.tool === 'string' &&
      parsed.tool === CONTEXT_COMPACT_TOOL_NAME
      ? {
          tool: parsed.tool,
          toolCallId:
            typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null,
          operation:
            typeof parsed.operation === 'string' ? parsed.operation : '',
          instruction:
            typeof parsed.instruction === 'string' &&
            parsed.instruction.trim().length > 0
              ? parsed.instruction.trim()
              : null,
        }
      : null
  } catch {
    return null
  }
}

/**
 * Extract the optional `instruction` focus hint from a compaction tool result.
 * Returns null when the tool call is not a successful `compact_restart`.
 */
export const findCompactInstruction = (
  toolMessage: ChatToolMessage,
): string | null => {
  for (const toolCall of toolMessage.toolCalls) {
    if (toolCall.response.status !== ToolCallResponseStatus.Success) {
      continue
    }
    const parsed = parseCompactOperationResult(toolCall.response.data.text)
    if (parsed?.operation === 'compact_restart') {
      return parsed.instruction
    }
  }
  return null
}

export const findCompactTrigger = (
  messages: ChatMessage[],
): {
  triggerToolCallId: string
  anchorMessageId: string
  retainedStartIndex: number
} | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'tool') {
      continue
    }

    const compactToolCall = message.toolCalls.find((toolCall) => {
      if (toolCall.response.status !== ToolCallResponseStatus.Success) {
        return false
      }
      const parsed = parseCompactOperationResult(toolCall.response.data.text)
      return parsed?.operation === 'compact_restart'
    })

    if (!compactToolCall) {
      continue
    }

    const retainedStartIndex =
      index > 0 && messages[index - 1]?.role === 'assistant' ? index - 1 : index

    return {
      triggerToolCallId: compactToolCall.request.id,
      anchorMessageId: message.id,
      retainedStartIndex,
    }
  }

  return null
}

export const findCompactToolCallId = (
  toolMessage: ChatToolMessage,
): string | null => {
  for (const toolCall of toolMessage.toolCalls) {
    if (toolCall.response.status !== ToolCallResponseStatus.Success) {
      continue
    }

    const parsed = parseCompactOperationResult(toolCall.response.data.text)
    if (parsed?.operation === 'compact_restart') {
      return toolCall.request.id
    }
  }

  return null
}

export const getLastAssistantPromptTokens = (
  messages: ChatMessage[],
): number | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'assistant') {
      continue
    }
    const tokens = message.metadata?.usage?.prompt_tokens
    return typeof tokens === 'number' && tokens > 0 ? tokens : null
  }
  return null
}

export const buildCompactionSummaryMessage = (
  compaction: ChatConversationCompaction,
): RequestMessage => {
  return {
    role: 'user',
    content: `<context_compaction>
You previously triggered \`${CONTEXT_COMPACT_TOOL_NAME}\` in this conversation.
Everything before the retained tool boundary has been compressed into the summary below.
Treat it as background reference only — it is a historical snapshot, not active instructions. The most recent user message is the sole authority for the current task.

<summary>
${compaction.summary}
</summary>
</context_compaction>`,
  }
}

export const buildCompactionResumeMessage = (): RequestMessage => {
  return {
    role: 'user',
    content: `<context_compaction_resume>
The compaction step has completed.
Resume the task that was active immediately before compaction.
Use the summary above as background reference only: it is a historical snapshot, not an active instruction set. The most recent user message (whether retained verbatim or captured in the summary) is the single authoritative statement of the current task.
Use the retained assistant/tool boundary as the latest working state.
Do not stop at saying the compaction succeeded.
Do not ask the user to repeat context unless information is actually missing.
Continue the task from the most useful next step.
</context_compaction_resume>`,
  }
}

export const buildCompactedConversationState = async ({
  messages,
  summary,
  summaryModelId,
}: {
  messages: ChatMessage[]
  summary: string
  summaryModelId?: string
}): Promise<ChatConversationCompaction | null> => {
  const trigger = findCompactTrigger(messages)
  if (!trigger) {
    return null
  }

  const loadedDeferredToolNames = [
    ...extractLoadedDeferredToolNames({ messages }),
  ].sort()
  const loadedDeferredToolSchemas =
    await filterPersistableLoadedDeferredToolSchemas(
      extractLoadedDeferredToolSchemas({ messages }),
    )

  return {
    anchorMessageId: trigger.anchorMessageId,
    triggerToolCallId: trigger.triggerToolCallId,
    summary,
    compactedAt: Date.now(),
    summaryModelId,
    compactedMessageCount: trigger.retainedStartIndex,
    ...(loadedDeferredToolNames.length > 0 ? { loadedDeferredToolNames } : {}),
    ...(loadedDeferredToolSchemas.length > 0
      ? { loadedDeferredToolSchemas }
      : {}),
  }
}

export const buildManualCompactionState = async ({
  messages,
  summary,
  summaryModelId,
}: {
  messages: ChatMessage[]
  summary: string
  summaryModelId?: string
}): Promise<ChatConversationCompaction | null> => {
  const anchorMessageId = messages.at(-1)?.id
  if (!anchorMessageId) {
    return null
  }

  const loadedDeferredToolNames = [
    ...extractLoadedDeferredToolNames({ messages }),
  ].sort()
  const loadedDeferredToolSchemas =
    await filterPersistableLoadedDeferredToolSchemas(
      extractLoadedDeferredToolSchemas({ messages }),
    )

  return {
    anchorMessageId,
    summary,
    compactedAt: Date.now(),
    summaryModelId,
    compactedMessageCount: messages.length,
    ...(loadedDeferredToolNames.length > 0 ? { loadedDeferredToolNames } : {}),
    ...(loadedDeferredToolSchemas.length > 0
      ? { loadedDeferredToolSchemas }
      : {}),
  }
}

/**
 * How many of the most recent user messages must be kept verbatim in the
 * summary. Earlier user messages are distilled to intent with only KEEP-list
 * sentences preserved verbatim (see the instruction below).
 */
const VERBATIM_RECENT_USER_MESSAGE_COUNT = 3

/**
 * Build the structured compaction instruction appended after the cache-warm
 * prefix. The model is told to pause the task and emit a fixed-section summary
 * wrapped in `<summary>`. Only model-facing instructions live here.
 *
 * User-message retention is selective (ACP "HOW TO COMPRESS" style): the most
 * recent messages stay verbatim, older ones are distilled with explicit
 * KEEP/DROP rules and a space-constrained priority order.
 */
export const buildCompactionInstructionMessage = (
  focusInstruction: string | null,
): RequestMessage => {
  const focusBlock = focusInstruction
    ? `\n<focus_instruction>${focusInstruction}</focus_instruction>\n`
    : ''
  return {
    role: 'user',
    content: `CRITICAL: You are now in COMPACTION MODE. The task above is paused.
- Do NOT continue the task. Do NOT call any tools — tool calls are rejected.
- Respond with PLAIN TEXT ONLY: a <summary> block with the fixed sections below.
- Write in the same language the conversation is currently using.
- Summarize only the CONVERSATION facts needed to resume. Ignore the system
  prompt, tool schemas, and tool-disclosure boilerplate — do not summarize them.

0. 保护集 (PROTECTED) — 以下内容永不压缩，必须完整保留、不得省略或改写：
   - 当前正在执行的步骤与未完成的操作（进行中的工具调用、待续任务）。
   - 用户最近 ${VERBATIM_RECENT_USER_MESSAGE_COUNT} 条消息，逐字保留。
   - 用户显式约束、偏好覆盖与更正。
   - 关键文件路径、版本号、ID、错误串，原样保留。
   其余内容才进入下面的固定 section。

Produce a high-signal summary that loses nothing needed to resume. Sections:

1. 当前目标 (Current Goal) — 用户最新的显式意图，逐字引用关键句。
2. 已做决策与理由 (Decisions & Rationale) — 拍板了什么、为什么。
3. 尝试与失败记录 (Trial & Error Log) — 每个试过的方案 + 失败/放弃的具体原因。不得省略。
4. 用户消息 (User Messages) — 选择性保留：
   - 最近 ${VERBATIM_RECENT_USER_MESSAGE_COUNT} 条 user 消息按时间逐字保留（含中途的更正、偏好覆盖、意图变化）。
   - 更早的 user 消息提炼意图；仅对 KEEP 清单关键句逐字保留：显式约束、硬性要求、拍板决定、不可重述的数字/版本/名称。
   - 可丢弃 (DROP)：重复读取、状态轮询、已提取结论的日志——只留结论 + 引用（路径/文件名），模型需要时可用工具再读原文。
5. 关键实体 (Key Entities) — 文件路径、版本号、ID、关键工具结果，精确。
6. 已完成工作 (Work Completed)
7. 未解决项 (Unresolved) — 悬而未决、待确认、已知风险。
8. 下一步 (Next Step) — 与最近显式请求直接对齐；附最近对话的逐字引用以防漂移。

空间不足时按优先级取舍：用户约束 > 决策与理由 > 错误与失败 > 路径与实体 > 过程细节。
${focusBlock}
Output format: <summary> ... </summary>`,
  }
}

const SUMMARY_TAG_RE = /<summary>([\s\S]*?)<\/summary>/i

/**
 * Extract the `<summary>...</summary>` body. When the model omits the tags,
 * fall back to the trimmed full text — this is parse robustness, not a degraded
 * business path.
 */
const parseSummaryFromResponse = (content: string): string => {
  const match = SUMMARY_TAG_RE.exec(content)
  if (match && match[1]) {
    return match[1].trim()
  }
  return content.trim()
}

/**
 * Generate a compaction summary by letting the MAIN model self-summarize on top
 * of its cache-warm prefix.
 *
 * - `requestMessages` is the provider-ready prefix the main line just sent
 *   (path 1) or a freshly rebuilt prefix (paths 2/3). It is forwarded
 *   byte-for-byte so the out-of-band request hits the same provider cache.
 * - `turnMessages` are the in-flight assistant+tool messages of the triggering
 *   turn (path 1 only); empty for paths 2/3.
 * - `focusInstruction` is the `context_compact` tool's `instruction` hint.
 *
 * Uses `purpose: 'standard'` (NOT lightweight — that strips provider features and
 * breaks prefix parity) and forwards the same `tools` with `tool_choice: 'none'`
 * so the tools block stays in the cache prefix while tool calls are forbidden.
 */
export const createConversationCompactionSummary = async ({
  providerClient,
  model,
  requestMessages,
  turnMessages = [],
  focusInstruction = null,
  tools,
  reasoningLevel,
  debugTraceId,
  signal,
}: {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  requestMessages: RequestMessage[]
  turnMessages?: RequestMessage[]
  focusInstruction?: string | null
  tools?: RequestTool[]
  reasoningLevel?: ReasoningLevel
  debugTraceId?: string
  signal?: AbortSignal
}): Promise<string> => {
  const messages: RequestMessage[] = [
    ...requestMessages,
    ...turnMessages,
    buildCompactionInstructionMessage(focusInstruction),
  ]

  console.debug('[YOLO][Compact] starting summary generation', {
    modelId: model.id,
    prefixMessageCount: requestMessages.length,
    turnMessageCount: turnMessages.length,
    hasFocusInstruction: focusInstruction !== null,
  })

  const runCompaction = async (): Promise<string> => {
    const response = await executeSingleTurn({
      providerClient,
      model,
      request: {
        model: model.model,
        messages,
        ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
      },
      tools,
      // Keep the tools block in the cache prefix but forbid calls. Only sent
      // when tools exist — some providers reject tool_choice without tools.
      tool_choice: tools && tools.length > 0 ? 'none' : undefined,
      deliveryMode: 'buffered',
      purpose: 'standard',
      debugTraceId,
      signal,
    })

    // Several providers (Gemini, OpenAI-compatible via extra_body, Bedrock) do
    // not honor tool_choice:'none'. Rather than depend on it, accept any
    // non-empty summary text and ignore stray tool calls; only empty fails.
    const summary = parseSummaryFromResponse(response.content)
    if (summary.length === 0) {
      throw new Error('[YOLO][Compact] model returned an empty summary')
    }
    return summary
  }

  let summary: string
  try {
    summary = await runCompaction()
  } catch (firstError) {
    if (
      signal?.aborted ||
      (firstError instanceof Error && firstError.name === 'AbortError') ||
      isRequestErrorNonRetryable(firstError)
    ) {
      throw firstError
    }
    console.warn(
      '[YOLO][Compact] summary generation failed; retrying once',
      firstError,
    )
    try {
      summary = await runCompaction()
    } catch (secondError) {
      const firstMsg =
        firstError instanceof Error ? firstError.message : String(firstError)
      const secondMsg =
        secondError instanceof Error ? secondError.message : String(secondError)
      throw new Error(
        `[YOLO][Compact] summary generation failed after retry. first: ${firstMsg}; second: ${secondMsg}`,
      )
    }
  }

  console.debug('[YOLO][Compact] summary generation completed', {
    modelId: model.id,
    summaryLength: summary.length,
    summary,
  })

  return summary
}
