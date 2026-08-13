import type { SubagentTaskSummary } from '../../../core/agent/subagent/types'
import type { LiveTaskViewSnapshot } from '../../../hooks/useLiveTaskStream'
import type {
  ChatMessage,
  ChatSubagentResultMessage,
  SubagentResultStatus,
} from '../../../types/chat'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'
import { formatTokenCount } from '../../../utils/llm/formatTokenCount'

export type SubagentCardArgs = {
  title?: string
}

export function parseAcceptedSubagentResponse(response: ToolCallResponse): {
  taskId?: string
  modelName?: string
  title?: string
} {
  if (response.status !== ToolCallResponseStatus.Success) {
    return {}
  }
  try {
    const parsed = JSON.parse(response.data.text) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    return {
      taskId: typeof record.taskId === 'string' ? record.taskId : undefined,
      modelName:
        typeof record.modelName === 'string' ? record.modelName : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
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

/** 详情弹窗里展示的一条 queued 意图（pending / recovery_required）。 */
export type SubagentQueuedMessage = {
  messageId: string
  text: string
  state: string
}

export function formatQueuedIntentLine({
  text,
  state,
}: Pick<SubagentQueuedMessage, 'text' | 'state'>): string {
  return `${state} · ${text}`
}

/** 详情弹窗的一段 transcript：历史已结算轮次（previous）或当前 live 轮次。 */
export type SubagentTranscriptSection = {
  kind: 'previous' | 'live'
  messages: ChatMessage[]
}

/**
 * 合并历史 run transcript（session snapshot 的 transcriptPage——已 settle 的
 * 轮次）与当前 live transcript（A2 历史 run transcript 回看）。历史轮次在前
 * （UI 在 previous 段上方渲染分隔条），当前 live 在后；两段皆空时返回 null
 * （组件保持无 transcript 的原有行为）。
 * 已结算轮次去重：transcriptPage 是最近一次 settle 的 transcript，与结果消息
 * 的 transcript（live）同源——与 live 重合的消息（按 messageId）从 previous
 * 段剔除，避免同一轮次整段重复。纯函数，UI 只消费结果。
 */
export function mergeSubagentTranscript(
  history: readonly ChatMessage[] | undefined,
  live: readonly ChatMessage[] | undefined,
): SubagentTranscriptSection[] | null {
  const liveIds = new Set((live ?? []).map((message) => message.id))
  const historyMessages = (history ?? []).filter(
    (message) => !liveIds.has(message.id),
  )
  const sections: SubagentTranscriptSection[] = []
  if (historyMessages.length > 0) {
    sections.push({ kind: 'previous', messages: historyMessages })
  }
  if (live && live.length > 0) {
    sections.push({ kind: 'live', messages: [...live] })
  }
  return sections.length > 0 ? sections : null
}

export function buildSubagentCompletionSummary({
  subagentResult,
  t,
}: {
  subagentResult: ChatSubagentResultMessage
  t: (key: string, fallback?: string) => string
}): string {
  const parts: string[] = []
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
