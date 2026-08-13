import type { LiveTaskViewSnapshot } from '../../../hooks/useLiveTaskStream'
import type {
  ChatMessage,
  ChatSubagentResultMessage,
  SubagentResultStatus,
} from '../../../types/chat'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'
import { formatTokenCount } from '../../../utils/llm/formatTokenCount'

/** 待审批工具调用（原定义在 SubagentApprovalBlock——落位本文件避免三向环）。 */
export type SubagentPendingApproval = {
  toolCallId: string
  request: ToolCallRequest
}

export type SubagentCardArgs = {
  title?: string
}

/**
 * Collect tool calls whose response is still `PendingApproval` from a
 * transcript (the live registry-side mirror of the child runtime messages).
 * Moved here from SubagentCard so the F6 status guard below is testable as a
 * pure function.
 */
export function collectPendingSubagentApprovals(
  transcript: readonly ChatMessage[] | undefined,
): SubagentPendingApproval[] {
  const result: SubagentPendingApproval[] = []
  for (const message of transcript ?? []) {
    if (message.role !== 'tool') continue
    for (const toolCall of message.toolCalls) {
      if (toolCall.response.status !== ToolCallResponseStatus.PendingApproval) {
        continue
      }
      result.push({
        toolCallId: toolCall.request.id,
        request: toolCall.request,
      })
    }
  }
  return result
}

/**
 * F6: pending-approval collection guarded by the live task record status. A
 * subagent that was aborted (parent deadline expiry / CLI abort / abortAll)
 * keeps its final transcript — which can still hold `PendingApproval` calls —
 * but its approval gate is gone, so the card must not render an active
 * approval block (or "Awaiting approval" label) for a dead child.
 */
export function resolveSubagentPendingApprovals({
  recordStatus,
  transcript,
}: {
  recordStatus: 'running' | 'completed' | 'failed' | 'aborted' | undefined
  transcript: readonly ChatMessage[] | undefined
}): SubagentPendingApproval[] {
  if (recordStatus !== 'running') return []
  return collectPendingSubagentApprovals(transcript)
}

export type ParsedSubagentAcceptedResponse = {
  taskId?: string
  modelName?: string
  title?: string
  /** F10: the delegate_subagent gate refused the dispatch (breaker open). */
  blocked?: boolean
  blockedReason?: string
}

export function parseAcceptedSubagentResponse(
  response: ToolCallResponse,
): ParsedSubagentAcceptedResponse {
  if (response.status !== ToolCallResponseStatus.Success) {
    return {}
  }
  try {
    const parsed = JSON.parse(response.data.text) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    // F10: the breaker gate returns a Success payload shaped
    // `{ accepted: false, status: 'blocked', blocked: true, reason }`
    // (localFileTools.ts delegate_subagent case) — a normal dispatch parse
    // would otherwise render an empty success card.
    const isBlocked = record.status === 'blocked' || record.blocked === true
    return {
      taskId: typeof record.taskId === 'string' ? record.taskId : undefined,
      modelName:
        typeof record.modelName === 'string' ? record.modelName : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
      ...(isBlocked
        ? {
            blocked: true,
            blockedReason:
              typeof record.reason === 'string' ? record.reason : undefined,
          }
        : {}),
    }
  } catch {
    return {}
  }
}

export function mapSubagentResultStatus(
  status: SubagentResultStatus,
): ToolCallResponseStatus {
  switch (status) {
    case 'completed':
      return ToolCallResponseStatus.Success
    case 'aborted':
      return ToolCallResponseStatus.Aborted
    case 'failed':
    default:
      return ToolCallResponseStatus.Error
  }
}

export function resolveSubagentEffectiveStatus({
  subagentResult,
  stream,
  response,
}: {
  subagentResult?: ChatSubagentResultMessage
  stream: LiveTaskViewSnapshot | null
  response: ToolCallResponse
}): ToolCallResponseStatus {
  if (subagentResult) {
    return mapSubagentResultStatus(subagentResult.status)
  }
  if (stream?.source === 'live') {
    if (stream.status === 'starting' || stream.status === 'running') {
      return ToolCallResponseStatus.Running
    }
    if (response.status === ToolCallResponseStatus.Error) {
      return ToolCallResponseStatus.Error
    }
    if (response.status === ToolCallResponseStatus.Aborted) {
      return ToolCallResponseStatus.Aborted
    }
    return ToolCallResponseStatus.Success
  }
  return response.status
}

export function collectSubagentActivityText({
  subagentResult,
  stream,
  initialStderr,
  initialStdout,
  fallbackError,
}: {
  subagentResult?: ChatSubagentResultMessage
  stream: LiveTaskViewSnapshot | null
  initialStderr?: string
  initialStdout?: string
  fallbackError?: string
}): string {
  if (subagentResult?.activityLog) {
    return subagentResult.activityLog
  }
  if (stream !== null) {
    return [stream.stderr, stream.stdout, fallbackError]
      .filter((text): text is string => Boolean(text))
      .join('\n')
  }
  return [initialStderr, initialStdout, fallbackError]
    .filter((text): text is string => Boolean(text))
    .join('\n')
}

export function normalizeActivityLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function formatSubagentActivityLine(line: string): string {
  const toolMatch = line.match(/^\[tool\]\s+(.+?)\s+(running|success|error)$/i)
  if (toolMatch) {
    const [, toolName, status] = toolMatch
    if (status.toLowerCase() === 'running') {
      return toolName
    }
    return `${toolName} · ${status.toLowerCase()}`
  }
  if (line.startsWith('[state]')) {
    return line.slice('[state]'.length).trim()
  }
  if (line.startsWith('[error]')) {
    return line.slice('[error]'.length).trim()
  }
  return line
}

export function getLatestActivityLine(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.startsWith('[state] completed')) continue
    return formatSubagentActivityLine(line)
  }
  return undefined
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m${rest}s`
}

export function buildSubagentCompletionSummary({
  subagentResult,
  t,
}: {
  subagentResult: ChatSubagentResultMessage
  t: (key: string, fallback?: string) => string
}): string {
  const parts: string[] = []
  // F2/F11: surface the delegated role name (projected from the runner's
  // `delegatedRoleName`) so a role-driven child is identifiable at a glance.
  if (subagentResult.delegatedRoleName) {
    parts.push(
      t('chat.subagent.delegatedRole', 'Delegated role: {name}').replace(
        '{name}',
        subagentResult.delegatedRoleName,
      ),
    )
  }
  switch (subagentResult.status) {
    case 'completed':
      parts.push(t('chat.subagent.statusCompleted', 'Completed'))
      break
    case 'aborted':
      parts.push(t('chat.subagent.statusAborted', 'Aborted'))
      break
    case 'failed':
      parts.push(t('chat.subagent.statusFailed', 'Failed'))
      break
  }
  if (subagentResult.toolUseCount > 0) {
    parts.push(
      t('chat.subagent.toolUseCount', '{count} tools').replace(
        '{count}',
        String(subagentResult.toolUseCount),
      ),
    )
  }
  if (subagentResult.durationMs > 0) {
    parts.push(formatDuration(subagentResult.durationMs))
  }
  if (subagentResult.usage && subagentResult.usage.total_tokens > 0) {
    parts.push(
      t('chat.subagent.tokenCount', '{count} tokens').replace(
        '{count}',
        formatTokenCount(subagentResult.usage.total_tokens),
      ),
    )
  }
  return parts.join(' · ')
}
