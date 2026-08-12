import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useLiveTaskStream } from '../../../hooks/useLiveTaskStream'
import { useSubagentTask } from '../../../hooks/useSubagentTask'
import type { ChatSubagentResultMessage } from '../../../types/chat'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

import {
  type SubagentCardArgs,
  buildSubagentCompletionSummary,
  collectSubagentActivityText,
  getLatestActivityLine,
  normalizeActivityLines,
  parseAcceptedSubagentResponse,
  resolveSubagentEffectiveStatus,
} from './subagentCardUtils'
import {
  SubagentCardView,
  type SubagentDisplayStatus,
} from './SubagentCardView'

type SubagentCardProps = {
  toolCallId: string
  response: ToolCallResponse
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

export function SubagentCard({
  toolCallId,
  response,
  conversationId: _conversationId,
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

  // The task registry stores only summaries (no live transcript) — the live
  // mirroring moved to the durable session transcript. The Task 10 card
  // rework wires the pending-approval block to the session snapshot instead.
  const activitySubtitle = subagentResult
    ? buildSubagentCompletionSummary({ subagentResult, t })
    : getLatestActivityLine(activityLines) ||
      (isRunning
        ? t('chat.subagent.planningNextMoves', 'Planning next moves')
        : t('chat.subagent.noActivity', 'No activity yet.'))

  const prompt = subagentResult?.prompt ?? liveTask?.prompt

  return (
    <SubagentCardView
      title={title}
      modelName={modelName}
      subtitle={activitySubtitle}
      status={toDisplayStatus(effectiveStatus)}
      prompt={prompt}
      taskId={taskId}
      transcript={subagentResult?.transcript}
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
      onAbort={isRunning ? onAbort : undefined}
    />
  )
}
