import { Clock, Coins, Wrench, X } from 'lucide-react'
import { Fragment, useEffect, useId } from 'react'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../../contexts/language-context'
import type { ChatMessage } from '../../../types/chat'
import { groupAssistantAndToolMessages } from '../../../utils/chat/message-groups'
import { formatTokenCount } from '../../../utils/llm/formatTokenCount'
import AssistantToolMessageGroupItem from '../AssistantToolMessageGroupItem'

import {
  type SubagentQueuedMessage,
  type SubagentTranscriptSection,
  formatDuration,
  formatQueuedIntentLine,
  formatSubagentActivityLine,
} from './subagentCardUtils'
import type {
  SubagentDetailStats,
  SubagentDisplayStatus,
} from './SubagentCardView'

type SubagentDetailModalProps = {
  container: HTMLElement
  title: string
  modelName?: string
  prompt?: string
  taskId?: string
  status: SubagentDisplayStatus
  transcript?: ChatMessage[]
  /** 历史/live 分段 transcript（A2）：有值时代替 transcript 渲染。 */
  transcriptSections?: SubagentTranscriptSection[] | null
  activityLines: string[]
  detailStats?: SubagentDetailStats
  isTranscriptLoading?: boolean
  /** 排队意图明细（pending / recovery_required）。 */
  queuedMessages?: SubagentQueuedMessage[]
  /** 会话需要手动恢复（needs_resume）时显示"恢复"按钮。 */
  needsResume?: boolean
  onRecover?: () => void
  onQueueResend?: (messageId: string) => void
  onQueueDrop?: (messageId: string) => void
  onClose: () => void
}

function getStatusLabel(
  status: SubagentDisplayStatus,
  t: (key: string, fallback?: string) => string,
): string {
  switch (status) {
    case 'running':
      return t('chat.liveTask.statusRunning', 'Running')
    case 'success':
      return t('chat.liveTask.statusDone', 'Done')
    case 'aborted':
      return t('chat.liveTask.statusAborted', 'Aborted')
    case 'error':
      return t('chat.liveTask.statusError', 'Error')
    case 'dispatched':
      return t('chat.subagent.statusDispatched', 'Dispatched')
    default:
      return status
  }
}

export function SubagentDetailModal({
  container,
  title,
  modelName,
  prompt,
  taskId,
  status,
  transcript,
  transcriptSections,
  activityLines,
  detailStats,
  isTranscriptLoading = false,
  queuedMessages,
  needsResume = false,
  onRecover,
  onQueueResend,
  onQueueDrop,
  onClose,
}: SubagentDetailModalProps) {
  const { t } = useLanguage()
  const titleId = useId()

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const groupedTranscript =
    transcript && transcript.length > 0
      ? groupAssistantAndToolMessages(transcript)
      : null

  const renderGroupedTranscript = (messages: ChatMessage[]) =>
    groupAssistantAndToolMessages(messages).map((messageOrGroup) =>
      Array.isArray(messageOrGroup) ? (
        <AssistantToolMessageGroupItem
          key={messageOrGroup.at(0)?.id ?? taskId ?? title}
          messages={messageOrGroup}
          conversationId={taskId ?? 'subagent-transcript'}
          suppressFooter
          showInlineInfo={false}
          showRetryAction={false}
          showInsertAction={false}
          showCopyAction={false}
          showBranchAction={false}
          showEditAction={false}
          showDeleteAction={false}
          showQuoteAction={false}
          showRunningToolFooter={false}
          isApplying={false}
          activeApplyRequestKey={null}
          onApply={() => {}}
          onToolMessageUpdate={() => {}}
          onEditStart={() => {}}
          onEditCancel={() => {}}
          onEditSave={() => {}}
          onDeleteGroup={() => {}}
          onRetryGroup={() => {}}
          onBranchGroup={() => {}}
          onOpenEditSummaryFile={() => {}}
          onQuoteAssistantSelection={() => {}}
        />
      ) : null,
    )

  const visibleActivityLines = activityLines.filter(
    (line) =>
      !line.startsWith('[state] starting') &&
      !line.startsWith('[state] completed'),
  )

  return createPortal(
    <div
      className="yolo-subagent-detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="yolo-subagent-detail-panel">
        <div className="yolo-subagent-detail-header">
          <div className="yolo-subagent-detail-header-text">
            <div id={titleId} className="yolo-subagent-detail-title">
              {title}
            </div>
            <div className="yolo-subagent-detail-meta">
              {modelName && (
                <span className="yolo-subagent-detail-meta-item">
                  {modelName}
                </span>
              )}
              <span className="yolo-subagent-detail-meta-item">
                {getStatusLabel(status, t)}
              </span>
              {detailStats?.durationMs && detailStats.durationMs > 0 && (
                <span className="yolo-subagent-detail-meta-item">
                  <Clock size={12} />
                  {formatDuration(detailStats.durationMs)}
                </span>
              )}
              {detailStats?.toolUseCount && detailStats.toolUseCount > 0 && (
                <span className="yolo-subagent-detail-meta-item">
                  <Wrench size={12} />
                  {t('chat.subagent.toolUseCount', '{count} tools').replace(
                    '{count}',
                    String(detailStats.toolUseCount),
                  )}
                </span>
              )}
              {detailStats?.totalTokens && detailStats.totalTokens > 0 && (
                <span className="yolo-subagent-detail-meta-item">
                  <Coins size={12} />
                  {t('chat.subagent.tokenCount', '{count} tokens').replace(
                    '{count}',
                    formatTokenCount(detailStats.totalTokens),
                  )}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="clickable-icon yolo-subagent-detail-close"
            aria-label={t('common.close', 'Close')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="yolo-subagent-detail-body">
          {prompt && (
            <div className="yolo-subagent-detail-prompt">{prompt}</div>
          )}

          {needsResume && onRecover && (
            <div className="yolo-subagent-detail-recover">
              <span className="yolo-subagent-detail-recover-text">
                {t(
                  'chat.subagent.recoverSessionHint',
                  'The session was interrupted and needs recovery before it can continue.',
                )}
              </span>
              <button
                type="button"
                className="yolo-subagent-detail-recover-btn"
                onClick={onRecover}
              >
                {t('chat.subagent.recoverSession', 'Recover session')}
              </button>
            </div>
          )}

          {queuedMessages && queuedMessages.length > 0 && (
            <div className="yolo-subagent-detail-queued">
              <div className="yolo-subagent-detail-queued-title">
                {t('chat.subagent.queuedMessagesTitle', 'Queued messages')}
              </div>
              {queuedMessages.map((message) => (
                <div
                  key={message.messageId}
                  className="yolo-subagent-detail-queued-item"
                >
                  <span
                    className="yolo-subagent-detail-queued-text"
                    title={message.text}
                  >
                    {formatQueuedIntentLine(message)}
                  </span>
                  {message.state === 'recovery_required' && (
                    <span className="yolo-subagent-detail-queued-actions">
                      <button
                        type="button"
                        className="yolo-subagent-detail-queued-btn yolo-subagent-detail-queued-btn--resend"
                        onClick={() => onQueueResend?.(message.messageId)}
                      >
                        {t('chat.subagent.queueResend', 'Resend')}
                      </button>
                      <button
                        type="button"
                        className="yolo-subagent-detail-queued-btn yolo-subagent-detail-queued-btn--drop"
                        onClick={() => onQueueDrop?.(message.messageId)}
                      >
                        {t('chat.subagent.queueDrop', 'Drop')}
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {isTranscriptLoading ? (
            <div className="yolo-subagent-detail-empty">
              {t('chat.subagent.loadingActivity', 'Loading activity…')}
            </div>
          ) : transcriptSections && transcriptSections.length > 0 ? (
            // A2：历史已结算轮次（previous，上方分隔条）在上、当前 live 在下。
            transcriptSections.map((section) => (
              <Fragment key={section.kind}>
                {section.kind === 'previous' && (
                  <div className="yolo-subagent-detail-transcript-divider">
                    {t('chat.subagent.previousRuns', 'Previous runs')}
                  </div>
                )}
                {renderGroupedTranscript(section.messages)}
              </Fragment>
            ))
          ) : groupedTranscript ? (
            renderGroupedTranscript(transcript ?? [])
          ) : visibleActivityLines.length > 0 ? (
            <div className="yolo-subagent-detail-activity">
              {visibleActivityLines
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line, index) => (
                  <div
                    key={`${index}-${line}`}
                    className="yolo-subagent-detail-activity-row"
                  >
                    {formatSubagentActivityLine(line)}
                  </div>
                ))}
            </div>
          ) : (
            <div className="yolo-subagent-detail-empty">
              {t('chat.subagent.noActivity', 'No activity yet.')}
            </div>
          )}
        </div>
      </div>
    </div>,
    container,
  )
}
