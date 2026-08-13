import { useCallback, useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { getSubagentSessionService } from '../../../core/agent/subagent/session-service'
import { useLiveTaskStream } from '../../../hooks/useLiveTaskStream'
import { useSubagentSessionSnapshot } from '../../../hooks/useSubagentSessionSnapshot'
import {
  useSubagentLiveTranscript,
  useSubagentTask,
} from '../../../hooks/useSubagentTask'
import type {
  ChatMessage,
  ChatSubagentResultMessage,
} from '../../../types/chat'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

import {
  SubagentApprovalBlock,
  type SubagentPendingApproval,
} from './SubagentApprovalBlock'
import {
  type SubagentCardArgs,
  buildSubagentCardSessionProps,
  buildSubagentCompletionSummary,
  collectSubagentActivityText,
  getLatestActivityLine,
  mergeSubagentTranscript,
  normalizeActivityLines,
  parseAcceptedSubagentResponse,
  resolveSubagentEffectiveStatus,
  runSubagentSessionAction,
} from './subagentCardUtils'
import {
  SubagentCardView,
  type SubagentDisplayStatus,
} from './SubagentCardView'

type SubagentCardProps = {
  toolCallId: string
  response: ToolCallResponse
  /**
   * 父对话 id。转发给卡片内联审批块，让审批点击能经
   * `AgentService.approveToolCall` 以正确的 scope 路由。
   */
  conversationId: string
  args?: SubagentCardArgs
  subagentResult?: ChatSubagentResultMessage
  initialStdout?: string
  initialStderr?: string
  onAbort?: () => void
}

function toDisplayStatus(
  status: ToolCallResponseStatus,
): SubagentDisplayStatus {
  switch (status) {
    case ToolCallResponseStatus.Running:
      return 'running'
    case ToolCallResponseStatus.Success:
      return 'success'
    case ToolCallResponseStatus.Aborted:
      return 'aborted'
    case ToolCallResponseStatus.Error:
      return 'error'
    default:
      return 'dispatched'
  }
}

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

export function SubagentCard({
  toolCallId,
  response,
  conversationId,
  args,
  subagentResult,
  initialStdout,
  initialStderr,
  onAbort,
}: SubagentCardProps) {
  const { t } = useLanguage()
  const stream = useLiveTaskStream(toolCallId)
  const accepted = useMemo(
    () => parseAcceptedSubagentResponse(response),
    [response],
  )

  const effectiveStatus = resolveSubagentEffectiveStatus({
    subagentResult,
    stream,
    response,
  })
  const isRunning = effectiveStatus === ToolCallResponseStatus.Running

  const title =
    args?.title || subagentResult?.title || accepted.title || toolCallId
  const modelName = subagentResult?.modelName || accepted.modelName
  const taskId = subagentResult?.taskId || accepted.taskId
  const liveTask = useSubagentTask(taskId)
  // Task 6 把注册表改为 summary 形态后，liveTranscript 存于 registry 侧 map
  // 旁路（C1 恢复）：运行中的实时消息仍按每次运行时快照推送。
  const liveTranscript = useSubagentLiveTranscript(taskId)

  // runner.ts:1054 恒等 taskId === sessionId：registry record 优先，宿主重载/
  // registry 裁剪后 subagentResult.taskId 兜底（历史卡片仍有恢复 UI）。
  // Task 11：再退到 accepted 响应里的 taskId（spawn 派发即落盘的会话身份）——
  // 运行中崩溃重载时子代理结果消息从未写入父会话，subagentResult 恒缺，而
  // 工具消息的 Success 响应（accepted JSON）随父会话持久化，据此重建 session
  // 订阅才能让 needs_resume 状态行/恢复动作在历史卡片上出现（web 与桌面同
  // 受益：桌面重载后 run 1 中断的会话此前同样无法显示恢复 UI）。
  const sessionId = liveTask?.sessionId ?? subagentResult?.taskId ?? accepted.taskId
  const [sessionSnapshot, refreshSessionSnapshot] = useSubagentSessionSnapshot(
    sessionId,
    // status/runSequence 变化时重查 snapshot（会话服务无订阅机制）。
    `${liveTask?.status ?? ''}:${liveTask?.runSequence ?? ''}`,
  )
  const sessionTaskRecord = useMemo(
    () =>
      liveTask ??
      (subagentResult?.taskId
        ? { sessionId: subagentResult.taskId }
        : // 与 sessionId 同款兜底（Task 11）：运行中崩溃重载时结果消息可能尚未
          // 落盘，accepted 响应（随父会话持久化）里的 taskId 即会话身份——
          // buildSubagentCardSessionProps 依赖 record 才能渲染状态行/恢复条。
          accepted.taskId
          ? { sessionId: accepted.taskId }
          : null),
    [liveTask, subagentResult, accepted.taskId],
  )
  const fallbackError =
    response.status === ToolCallResponseStatus.Error
      ? response.error
      : undefined

  const activityText = useMemo(
    () =>
      collectSubagentActivityText({
        subagentResult,
        stream,
        initialStderr,
        initialStdout,
        fallbackError,
      }),
    [subagentResult, stream, initialStderr, initialStdout, fallbackError],
  )

  const activityLines = useMemo(
    () => normalizeActivityLines(activityText),
    [activityText],
  )

  // A2 历史 run transcript 回看：snapshot.transcriptPage（已 settle 的轮次，
  // session-service 每轮结算写入）在上、当前 live 在下；同一轮次（settled 结果
  // 消息的 transcript 与 transcriptPage 同源）按 messageId 去重避免整段重复。
  const transcriptSections = useMemo(
    () =>
      mergeSubagentTranscript(
        sessionSnapshot?.transcriptPage,
        subagentResult?.transcript ?? liveTranscript,
      ),
    [sessionSnapshot, subagentResult, liveTranscript],
  )

  const liveAssistantSummary = useMemo(() => {
    if (!liveTranscript) return undefined
    for (let index = liveTranscript.length - 1; index >= 0; index -= 1) {
      const message = liveTranscript[index]
      if (message.role === 'assistant' && message.content.trim().length > 0) {
        return message.content.trim().split('\n').at(-1)
      }
    }
    return undefined
  }, [liveTranscript])

  const activitySubtitle = subagentResult
    ? buildSubagentCompletionSummary({ subagentResult, t })
    : liveAssistantSummary ||
      getLatestActivityLine(activityLines) ||
      (isRunning
        ? t('chat.subagent.planningNextMoves', 'Planning next moves')
        : t('chat.subagent.noActivity', 'No activity yet.'))

  const prompt = subagentResult?.prompt ?? liveTask?.prompt

  // Surface pending tool approvals inside the card. The subagent runtime
  // pauses at PendingApproval (loop-worker emits done; runChildAgent waits
  // on a gate), and `liveTranscript` mirrors the runtime messages — so the
  // card can render approval buttons next to the running thinking output.
  const pendingApprovals = useMemo(
    () => collectPendingSubagentApprovals(liveTranscript),
    [liveTranscript],
  )
  const isAwaitingApproval = pendingApprovals.length > 0
  // A3：等待审批时状态行优先显示"等待审批"（session 状态此时为 RUNNING）。
  // 依赖 isAwaitingApproval，故在 pendingApprovals 之后计算。
  const sessionProps = useMemo(
    () =>
      buildSubagentCardSessionProps(
        sessionSnapshot,
        sessionTaskRecord,
        t,
        isAwaitingApproval,
      ),
    [sessionSnapshot, sessionTaskRecord, t, isAwaitingApproval],
  )
  const subtitle = isAwaitingApproval
    ? pendingApprovals.length > 1
      ? t(
          'chat.subagent.approval.headingMulti',
          'Awaiting approval · {count}',
        ).replace('{count}', String(pendingApprovals.length))
      : t('chat.subagent.approval.heading', 'Awaiting approval')
    : activitySubtitle

  const handleRecover = useCallback(() => {
    if (!sessionId || !sessionSnapshot) return
    const service = getSubagentSessionService()
    if (!service) return
    // settle 后主动重查快照：恢复条/queued 按钮随新状态刷新（revision_conflict
    // 时也重查——冲突结果带 current 快照，重拉拿到最新真相）；拒绝 warn 见
    // runSubagentSessionAction。
    // R14 一键恢复：recover + 把全部 RECOVERY_REQUIRED 意图置 PENDING + 投递
    // 续跑 收敛为服务端单次动作（此前 deliver 对 RECOVERY_REQUIRED 不投递，
    // 用户必须再手动 resend 才续跑）。
    void runSubagentSessionAction(
      'recover',
      service.resumeAfterRecovery(sessionId),
      refreshSessionSnapshot,
      sessionId,
    )
  }, [sessionId, sessionSnapshot, refreshSessionSnapshot])

  const handleQueueResend = useCallback(
    (messageId: string) => {
      if (!sessionId || !sessionSnapshot) return
      const service = getSubagentSessionService()
      if (!service) return
      void runSubagentSessionAction(
        'resend',
        service.queueRecovery({
          sessionId,
          messageId,
          expectedSessionRevision: sessionSnapshot.session.revision,
          action: 'resend',
          requestId: `ui:resend:${crypto.randomUUID()}`,
        }),
        refreshSessionSnapshot,
        sessionId,
      )
    },
    [sessionId, sessionSnapshot, refreshSessionSnapshot],
  )

  const handleQueueDrop = useCallback(
    (messageId: string) => {
      if (!sessionId || !sessionSnapshot) return
      const service = getSubagentSessionService()
      if (!service) return
      void runSubagentSessionAction(
        'drop',
        service.queueRecovery({
          sessionId,
          messageId,
          expectedSessionRevision: sessionSnapshot.session.revision,
          action: 'drop',
          requestId: `ui:drop:${crypto.randomUUID()}`,
        }),
        refreshSessionSnapshot,
        sessionId,
      )
    },
    [sessionId, sessionSnapshot, refreshSessionSnapshot],
  )

  return (
    <SubagentCardView
      title={title}
      modelName={modelName}
      subtitle={subtitle}
      status={toDisplayStatus(effectiveStatus)}
      prompt={prompt}
      taskId={taskId}
      transcriptSections={transcriptSections}
      activityLines={activityLines}
      detailStats={
        subagentResult
          ? {
              durationMs: subagentResult.durationMs,
              toolUseCount: subagentResult.toolUseCount,
              totalTokens: subagentResult.usage?.total_tokens,
            }
          : undefined
      }
      sessionStatus={sessionProps.sessionStatus}
      awaitingApproval={sessionProps.awaitingApproval}
      queuedCount={sessionProps.queuedCount}
      queuedMessages={sessionProps.queuedMessages}
      needsResume={sessionProps.needsResume}
      onRecover={handleRecover}
      onQueueResend={handleQueueResend}
      onQueueDrop={handleQueueDrop}
      onAbort={isRunning ? onAbort : undefined}
      footer={
        isAwaitingApproval ? (
          <SubagentApprovalBlock
            conversationId={conversationId}
            pendingApprovals={pendingApprovals}
          />
        ) : undefined
      }
    />
  )
}
