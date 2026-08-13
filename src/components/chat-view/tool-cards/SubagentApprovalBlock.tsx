import { useCallback, useRef, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import type { ToolCallRequest } from '../../../types/tool-call.types'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { useChatRuntimeActions } from '../chat-runtime-actions-context'
import {
  handleRuntimeToolApproval,
  handleRuntimeToolRejection,
} from '../runtime-action-handlers'

import { SubagentDetailModal } from './SubagentDetailModal'
import { buildSubagentApprovalSummary } from './subagentApprovalSummary'

export type SubagentPendingApproval = {
  toolCallId: string
  request: ToolCallRequest
}

type SubagentApprovalBlockProps = {
  conversationId: string
  pendingApprovals: SubagentPendingApproval[]
}

export function SubagentApprovalBlock({
  conversationId,
  pendingApprovals,
}: SubagentApprovalBlockProps) {
  const { t } = useLanguage()
  const app = useApp()
  const { actions, conversation } = useChatRuntimeActions(conversationId)

  // U1: the approval row only shows an 80-char truncated argument summary;
  // "View parameters" opens the existing SubagentDetailModal with the full
  // JSON payload of the pending call.
  const blockRef = useRef<HTMLDivElement | null>(null)
  const [detailsToolCall, setDetailsToolCall] = useState<{
    toolCallId: string
    request: ToolCallRequest
  } | null>(null)

  // F13: tool call ids whose decision (approve/reject) is currently in
  // flight. Their buttons are disabled while the runtime call is pending so a
  // double click cannot enqueue a duplicate decision, and the dimmed state
  // gives the user visible feedback that the click was received.
  const [inFlightToolCallIds, setInFlightToolCallIds] = useState<
    ReadonlySet<string>
  >(() => new Set())

  const runDecision = useCallback(
    async (
      toolCallId: string,
      decision: () => Promise<void>,
    ): Promise<void> => {
      setInFlightToolCallIds((prev) => new Set(prev).add(toolCallId))
      try {
        await decision()
      } finally {
        setInFlightToolCallIds((prev) => {
          const next = new Set(prev)
          next.delete(toolCallId)
          return next
        })
      }
    },
    [],
  )

  const handleApprove = useCallback(
    (toolCallId: string) =>
      runDecision(toolCallId, () =>
        handleRuntimeToolApproval({
          actions,
          conversation,
          toolCallId,
        }),
      ),
    [actions, conversation, runDecision],
  )

  const handleReject = useCallback(
    (toolCallId: string) =>
      runDecision(toolCallId, () =>
        handleRuntimeToolRejection({
          actions,
          conversation,
          toolCallId,
        }),
      ),
    [actions, conversation, runDecision],
  )

  const handleApproveAll = useCallback(() => {
    void Promise.all(
      pendingApprovals.map((approval) => handleApprove(approval.toolCallId)),
    )
  }, [pendingApprovals, handleApprove])

  const handleRejectAll = useCallback(() => {
    for (const approval of pendingApprovals) {
      void handleReject(approval.toolCallId)
    }
  }, [pendingApprovals, handleReject])

  // F13: bulk decisions are irreversible multi-call operations — require an
  // explicit confirmation before dispatching them.
  const confirmApproveAll = useCallback(() => {
    new ConfirmModal(app, {
      title: t(
        'chat.subagent.approval.confirmApproveAllTitle',
        'Approve all pending tool calls?',
      ),
      message: t(
        'chat.subagent.approval.confirmApproveAllMessage',
        'This approves every pending tool call at once and cannot be undone.',
      ),
      ctaText: t('chat.subagent.approval.approveAll', 'Approve all'),
      onConfirm: handleApproveAll,
    }).open()
  }, [app, t, handleApproveAll])

  const confirmRejectAll = useCallback(() => {
    new ConfirmModal(app, {
      title: t(
        'chat.subagent.approval.confirmRejectAllTitle',
        'Reject all pending tool calls?',
      ),
      message: t(
        'chat.subagent.approval.confirmRejectAllMessage',
        'This rejects every pending tool call at once and cannot be undone.',
      ),
      ctaText: t('chat.subagent.approval.rejectAll', 'Reject all'),
      onConfirm: handleRejectAll,
    }).open()
  }, [app, t, handleRejectAll])

  const isInFlight = (toolCallId: string): boolean =>
    inFlightToolCallIds.has(toolCallId)
  const anyInFlight = inFlightToolCallIds.size > 0

  const heading =
    pendingApprovals.length > 1
      ? t(
          'chat.subagent.approval.headingMulti',
          'Awaiting approval · {count}',
        ).replace('{count}', String(pendingApprovals.length))
      : t('chat.subagent.approval.heading', 'Awaiting approval')

  return (
    <>
    <div
      ref={blockRef}
      className="yolo-subagent-approval"
      role="group"
      aria-label={heading}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="yolo-subagent-approval__items">
        {pendingApprovals.map(({ toolCallId, request }) => {
          const summary = buildSubagentApprovalSummary(request)
          const pending = isInFlight(toolCallId)
          return (
            <div key={toolCallId} className="yolo-subagent-approval__item">
              <div className="yolo-subagent-approval__item-text">
                <span className="yolo-subagent-approval__item-label">
                  {summary.label}
                </span>
                {summary.detail && (
                  <span
                    className="yolo-subagent-approval__item-detail"
                    title={summary.detail}
                  >
                    {summary.detail}
                  </span>
                )}
              </div>
              <div className="yolo-subagent-approval__item-actions">
                <button
                  type="button"
                  className="yolo-subagent-approval__btn yolo-subagent-approval__btn--ghost"
                  onClick={() => setDetailsToolCall({ toolCallId, request })}
                  title={t(
                    'chat.subagent.approval.viewDetails',
                    'View parameters',
                  )}
                  aria-label={t(
                    'chat.subagent.approval.viewDetails',
                    'View parameters',
                  )}
                >
                  {t('chat.subagent.approval.viewDetails', 'View parameters')}
                </button>
                <button
                  type="button"
                  className="yolo-subagent-approval__btn yolo-subagent-approval__btn--ghost"
                  onClick={() => void handleReject(toolCallId)}
                  disabled={pending}
                  aria-busy={pending}
                  title={t('chat.subagent.approval.reject', 'Reject')}
                  aria-label={t('chat.subagent.approval.reject', 'Reject')}
                >
                  {t('chat.subagent.approval.reject', 'Reject')}
                </button>
                <button
                  type="button"
                  className="yolo-subagent-approval__btn yolo-subagent-approval__btn--primary"
                  onClick={() => void handleApprove(toolCallId)}
                  disabled={pending}
                  aria-busy={pending}
                  title={t('chat.subagent.approval.approve', 'Approve')}
                  aria-label={t('chat.subagent.approval.approve', 'Approve')}
                >
                  {t('chat.subagent.approval.approve', 'Approve')}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {pendingApprovals.length >= 2 && (
        <div className="yolo-subagent-approval__bulk">
          <button
            type="button"
            className="yolo-subagent-approval__bulk-btn yolo-subagent-approval__bulk-btn--ghost"
            onClick={confirmRejectAll}
            disabled={anyInFlight}
            aria-busy={anyInFlight}
          >
            {t('chat.subagent.approval.rejectAll', 'Reject all')}
          </button>
          <button
            type="button"
            className="yolo-subagent-approval__bulk-btn yolo-subagent-approval__bulk-btn--primary"
            onClick={confirmApproveAll}
            disabled={anyInFlight}
            aria-busy={anyInFlight}
          >
            {t('chat.subagent.approval.approveAll', 'Approve all')}
          </button>
        </div>
      )}
    </div>

    {detailsToolCall && (
      <SubagentDetailModal
        container={
          blockRef.current?.closest<HTMLElement>('.yolo-chat-container') ??
          document.body
        }
        title={detailsToolCall.request.name}
        status="running"
        requestArgs={{
          name: detailsToolCall.request.name,
          arguments: detailsToolCall.request.arguments,
        }}
        activityLines={[]}
        onClose={() => setDetailsToolCall(null)}
      />
    )}
    </>
  )
}
