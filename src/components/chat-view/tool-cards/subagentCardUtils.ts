import {
  type SubagentQueueRecoveryResult,
  type SubagentRecoverResult,
  type SubagentSessionSnapshot,
  type SubagentSessionStatus,
} from '../../../core/agent/subagent/session-types'
import type { SubagentTaskSummary } from '../../../core/agent/subagent/types'
import {
  SUBAGENT_MESSAGE_INTENT_STATE,
  SUBAGENT_SESSION_STATUS,
} from '../../../core/state/statuses'
import type { LiveTaskViewSnapshot } from '../../../hooks/useLiveTaskStream'
import type {
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

/** 卡片/弹窗的 session 数据（R12：映射全在纯函数，组件只消费 props）。 */
export type SubagentCardSessionProps = {
  /** i18n 会话状态标签（无 snapshot 时为 undefined）。 */
  sessionStatus?: string
  /** 排队中的意图数（pending + recovery_required）。 */
  queuedCount?: number
  /** 排队意图明细（按 createdAt 升序）。 */
  queuedMessages?: SubagentQueuedMessage[]
  /** 会话需要手动恢复（needs_resume）。 */
  needsResume?: boolean
  /** 存在 recovery_required 意图（需要 resend/drop 决断）。 */
  recoveryRequired?: boolean
}

export function formatQueuedIntentLine({
  text,
  state,
}: Pick<SubagentQueuedMessage, 'text' | 'state'>): string {
  return `${state} · ${text}`
}

export function formatSessionStatus(
  status: SubagentSessionStatus,
  t: (key: string, fallback?: string) => string,
): string {
  switch (status) {
    case SUBAGENT_SESSION_STATUS.IDLE:
      return t('chat.subagent.sessionStatus.idle', 'Idle')
    case SUBAGENT_SESSION_STATUS.RUNNING:
      return t('chat.subagent.sessionStatus.running', 'Running')
    case SUBAGENT_SESSION_STATUS.CLOSING:
      return t('chat.subagent.sessionStatus.closing', 'Closing')
    case SUBAGENT_SESSION_STATUS.NEEDS_RESUME:
      return t('chat.subagent.sessionStatus.needsResume', 'Needs resume')
    case SUBAGENT_SESSION_STATUS.ORPHANED:
      return t('chat.subagent.sessionStatus.orphaned', 'Orphaned')
    case SUBAGENT_SESSION_STATUS.ARCHIVED:
      return t('chat.subagent.sessionStatus.archived', 'Archived')
  }
}

/**
 * session snapshot → 卡片/弹窗 props 的映射（R12）。快照缺失、task record
 * 无 sessionId 或快照 sessionId 与 record 不一致时返回空 props（组件保持
 * 无 session 的原有行为）。record 只消费 sessionId（runner.ts:1054 恒等
 * taskId === sessionId，宿主重载后 subagentResult.taskId 可作后备 record）。
 */
export function buildSubagentCardSessionProps(
  snapshot: SubagentSessionSnapshot | null | undefined,
  taskRecord: Pick<SubagentTaskSummary, 'sessionId'> | null | undefined,
  t: (key: string, fallback?: string) => string,
): SubagentCardSessionProps {
  if (!snapshot || !taskRecord?.sessionId) return {}
  if (snapshot.session.sessionId !== taskRecord.sessionId) return {}

  const liveIntents = (snapshot.intents ?? [])
    .filter(
      (intent) =>
        intent.state === SUBAGENT_MESSAGE_INTENT_STATE.PENDING ||
        intent.state === SUBAGENT_MESSAGE_INTENT_STATE.RECOVERY_REQUIRED,
    )
    .sort((a, b) => a.createdAt - b.createdAt)

  const props: SubagentCardSessionProps = {
    sessionStatus: formatSessionStatus(snapshot.session.status, t),
    queuedCount: liveIntents.length,
    needsResume:
      snapshot.session.status === SUBAGENT_SESSION_STATUS.NEEDS_RESUME,
  }
  if (liveIntents.length > 0) {
    props.queuedMessages = liveIntents.map((intent) => ({
      messageId: intent.messageId,
      text: intent.text,
      state: intent.state,
    }))
    props.recoveryRequired = liveIntents.some(
      (intent) => intent.state === 'recovery_required',
    )
  }
  return props
}

/**
 * 执行一次 session 动作并统一处理结果反馈（Task 10 审查 Important 修复）：
 * - 拒绝（revision_conflict / session_not_sendable 等）不静默——console.warn
 *   记录 errorCode/retryable；
 * - 调用本身抛错（store I/O 等）同样 warn，不产生 unhandled rejection；
 * - settle 后一律 onSettled（组件用它触发快照重查——恢复/resend/drop 只改
 *   store，registry 不感知，不重查 UI 不刷新）；
 * - recover/resend 成功（drop 不触发）后调用
 *   `getSubagentSessionService()?.deliverQueuedIntents(sessionId)`——把
 *   PENDING after_run 意图投递成续跑（UI 续跑缺口修复）。session-service
 *   以动态 import 获取（与 main.ts 同款），避免本工具模块新增对
 *   session-service 的静态边；service 未初始化时静默跳过。
 * 组件侧以 `void runSubagentSessionAction(...)` 包裹（React 异步 handler
 * 规范）。
 */
export async function runSubagentSessionAction(
  action: 'recover' | 'resend' | 'drop',
  request: Promise<SubagentRecoverResult | SubagentQueueRecoveryResult>,
  onSettled: () => void,
  sessionId: string,
): Promise<void> {
  try {
    const result = await request
    if (!result.accepted) {
      console.warn('[YOLO] Subagent session action rejected', {
        action,
        errorCode: result.errorCode,
        retryable: result.retryable,
      })
    } else if (action === 'recover' || action === 'resend') {
      const { getSubagentSessionService } = await import(
        '../../../core/agent/subagent/session-service'
      )
      void getSubagentSessionService()?.deliverQueuedIntents(sessionId)
    }
  } catch (error: unknown) {
    console.warn('[YOLO] Subagent session action failed', { action, error })
  } finally {
    onSettled()
  }
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
