import { App, Notice } from 'obsidian'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type {
  RetrievalInspectStatus,
  RetrievalTrace,
} from '../../../core/rag/retrievalTraceTypes'
import YoloPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'

import {
  buildVisibleTimingEntries,
  formatDurationMs,
  formatTraceSummary,
  getTraceBadge,
  resolveSelectedQueryIdAfterRefresh,
  selectNextTraceAfterDelete,
} from './ragLogModalRows'

type RAGLogModalProps = {
  plugin: YoloPlugin
}

type LoadState = {
  inspectStatus: RetrievalInspectStatus | null
  traces: RetrievalTrace[]
  inspectError: string | null
  tracesError: string | null
}

export class RAGLogModal extends ReactModal<RAGLogModalProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: RAGLogModalComponent,
      props: { plugin },
      options: {
        title: plugin.t('settings.rag.log.title', 'RAG 日志'),
        className: 'yolo-rag-log-modal-shell',
      },
      plugin,
    })
  }
}

function RAGLogModalComponent({
  plugin,
  onClose,
}: RAGLogModalProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [deletingQueryId, setDeletingQueryId] = useState<string | null>(null)
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadState>({
    inspectStatus: null,
    traces: [],
    inspectError: null,
    tracesError: null,
  })
  const isMountedRef = useRef(false)
  const refreshRequestIdRef = useRef(0)
  const selectedQueryIdRef = useRef<string | null>(null)
  const loadStateRef = useRef(loadState)

  useEffect(() => {
    loadStateRef.current = loadState
  }, [loadState])

  useEffect(() => {
    selectedQueryIdRef.current = selectedQueryId
  }, [selectedQueryId])

  const refreshData = async (options?: {
    preserveSelection?: boolean
    preferredQueryId?: string | null
  }) => {
    const requestId = ++refreshRequestIdRef.current

    setIsRefreshing(true)

    const [inspectResult, tracesResult] = await Promise.allSettled([
      plugin.getRetrievalInspectStatus(),
      plugin.listRetrievalTraces(50),
    ])

    if (!isMountedRef.current || requestId !== refreshRequestIdRef.current) {
      return
    }

    const currentLoadState = loadStateRef.current
    const nextInspectStatus =
      inspectResult.status === 'fulfilled'
        ? inspectResult.value
        : currentLoadState.inspectStatus
    const nextTraces =
      tracesResult.status === 'fulfilled'
        ? tracesResult.value
        : currentLoadState.traces
    const nextLoadState = {
      inspectStatus: nextInspectStatus,
      traces: nextTraces,
      inspectError:
        inspectResult.status === 'rejected'
          ? extractErrorMessage(inspectResult.reason)
          : null,
      tracesError:
        tracesResult.status === 'rejected'
          ? extractErrorMessage(tracesResult.reason)
          : null,
    }
    const nextSelectedQueryId = resolveSelectedQueryIdAfterRefresh(nextTraces, {
      preserveSelection: options?.preserveSelection,
      currentSelectedQueryId: selectedQueryIdRef.current,
      preferredQueryId: options?.preferredQueryId,
    })

    loadStateRef.current = nextLoadState
    selectedQueryIdRef.current = nextSelectedQueryId
    setLoadState(nextLoadState)
    setSelectedQueryId(nextSelectedQueryId)

    setIsRefreshing(false)
    setIsLoading(false)
  }

  useEffect(() => {
    isMountedRef.current = true
    void refreshData({ preserveSelection: false })

    return () => {
      isMountedRef.current = false
      refreshRequestIdRef.current += 1
    }
  }, [])

  const traces = loadState.traces
  const selectedTrace =
    traces.find((trace) => trace.queryId === selectedQueryId) ?? null

  const inspectRows = useMemo(() => {
    if (!loadState.inspectStatus) {
      return []
    }

    const rows = [
      {
        label: t('settings.rag.log.model', '模型'),
        value:
          loadState.inspectStatus.modelId ??
          t('settings.rag.log.unknown', '未知'),
      },
      {
        label: t('settings.rag.log.dimension', '维度'),
        value: String(loadState.inspectStatus.embeddingDimension ?? '—'),
      },
      {
        label: t('settings.rag.log.indexedFiles', '已索引文件'),
        value: String(loadState.inspectStatus.indexedFileCount),
      },
      {
        label: t('settings.rag.log.chunks', '块数'),
        value: String(loadState.inspectStatus.chunkCount),
      },
    ]

    const currentIssue =
      loadState.inspectStatus.errorCode ??
      loadState.inspectStatus.warningCodes[0]
    if (currentIssue) {
      rows.push({
        label: loadState.inspectStatus.errorCode
          ? t('settings.rag.log.error', '错误')
          : t('settings.rag.log.warning', '警告'),
        value: currentIssue,
      })
    }

    return rows
  }, [loadState.inspectStatus, t])

  const handleRetryTraceLoad = () => {
    void refreshData()
  }

  const handleClearLogs = () => {
    if (isClearing) {
      return
    }

    new ConfirmModal(plugin.app, {
      title: t('settings.rag.log.clearConfirmTitle', '清空 RAG 日志？'),
      message: t(
        'settings.rag.log.clearConfirmMessage',
        '此操作无法恢复。只会清空本地 RAG 检索日志，不会删除索引、chunks、embeddings 或设置。',
      ),
      ctaText: t('settings.rag.log.clearConfirmButton', '确认清空'),
      cancelText: t('settings.rag.log.cancel', '取消'),
      onConfirm: () => {
        void (async () => {
          setIsClearing(true)
          try {
            await plugin.clearRetrievalTraces()
            setSelectedQueryId(null)
            await refreshData({ preserveSelection: false })
          } catch (error) {
            console.error('Failed to clear retrieval traces', error)
            new Notice(t('settings.rag.log.clearFailure', '清空日志失败'))
          } finally {
            setIsClearing(false)
          }
        })()
      },
    }).open()
  }

  const handleDeleteTrace = (trace: RetrievalTrace) => {
    if (deletingQueryId) {
      return
    }

    new ConfirmModal(plugin.app, {
      title: t('settings.rag.log.deleteConfirmTitle', '删除这条 RAG 日志？'),
      message: t(
        'settings.rag.log.deleteConfirmMessage',
        '此操作无法恢复。只会删除当前这条本地 RAG 检索日志，不会删除索引、chunks、embeddings 或设置。',
      ),
      ctaText: t('settings.rag.log.deleteConfirmButton', '确认删除'),
      cancelText: t('settings.rag.log.cancel', '取消'),
      onConfirm: () => {
        void (async () => {
          setDeletingQueryId(trace.queryId)
          try {
            const nextTrace = selectNextTraceAfterDelete(traces, trace.queryId)
            await plugin.deleteRetrievalTrace(trace.queryId)
            await refreshData({
              preserveSelection: false,
              preferredQueryId: nextTrace?.queryId ?? null,
            })
          } catch (error) {
            console.error('Failed to delete retrieval trace', error)
            new Notice(t('settings.rag.log.deleteFailure', '删除日志失败'))
          } finally {
            setDeletingQueryId(null)
          }
        })()
      },
    }).open()
  }

  return (
    <div className="yolo-rag-log-modal">
      <div className="yolo-rag-log-toolbar">
        <div className="yolo-rag-log-toolbar-copy">
          <div className="yolo-rag-card-description">
            {t(
              'settings.rag.log.subtitle',
              '最近 50 条检索追踪。顶部状态是当前 Inspect，不代表历史 trace 当时状态。',
            )}
          </div>
        </div>
        <div className="yolo-rag-log-actions modal-button-container">
          <button onClick={() => void refreshData()} disabled={isRefreshing}>
            {t('settings.rag.log.refresh', '刷新')}
          </button>
          <button
            className="mod-warning"
            onClick={handleClearLogs}
            disabled={isClearing || traces.length === 0}
          >
            {t('settings.rag.log.clearLogs', '清空日志')}
          </button>
          <button onClick={onClose}>
            {t('settings.rag.log.close', '关闭')}
          </button>
        </div>
      </div>

      <div className="yolo-rag-inspect-list yolo-rag-log-inspect-list">
        {loadState.inspectError ? (
          <div className="yolo-rag-inspect-row yolo-rag-log-inspect-row--failed">
            <span className="yolo-rag-inspect-label">
              {t('settings.rag.log.loadFailure', 'Inspect 加载失败')}
            </span>
            <span className="yolo-rag-inspect-value">
              {loadState.inspectError}
            </span>
          </div>
        ) : inspectRows.length > 0 ? (
          inspectRows.map((row) => (
            <div key={row.label} className="yolo-rag-inspect-row">
              <span className="yolo-rag-inspect-label">{row.label}</span>
              <span className="yolo-rag-inspect-value">{row.value}</span>
            </div>
          ))
        ) : (
          <div className="yolo-rag-inspect-row">
            <span className="yolo-rag-inspect-label">
              {t('settings.rag.log.loading', '加载中')}
            </span>
          </div>
        )}
      </div>

      <div className="yolo-rag-log-content">
        <div className="yolo-rag-log-list">
          <div className="yolo-rag-log-list-header">
            <span>{t('settings.rag.log.traceListTitle', '检索日志列表')}</span>
            <span>{traces.length}</span>
          </div>

          {isLoading ? (
            <div className="yolo-rag-log-empty">
              {t('settings.rag.log.loading', '加载中')}
            </div>
          ) : loadState.tracesError ? (
            <div className="yolo-rag-log-empty yolo-rag-log-error">
              <div>{loadState.tracesError}</div>
              <button onClick={handleRetryTraceLoad}>
                {t('settings.rag.log.retry', '重试')}
              </button>
            </div>
          ) : traces.length === 0 ? (
            <div className="yolo-rag-log-empty">
              {t('settings.rag.log.empty', '暂无 RAG 日志')}
            </div>
          ) : (
            traces.map((trace) => {
              const badge = getTraceBadge(trace)
              const summary = formatTraceSummary(trace)
              return (
                <button
                  key={trace.queryId}
                  type="button"
                  className={`yolo-rag-log-trace-row ${
                    trace.queryId === selectedQueryId ? 'is-selected' : ''
                  }`}
                  onClick={() => setSelectedQueryId(trace.queryId)}
                >
                  <div className="yolo-rag-log-trace-meta">
                    <span>
                      {summary.localTime} · {summary.durationText} ·{' '}
                      {summary.evidenceCount}{' '}
                      {t('settings.rag.log.evidenceCount', '条证据')}
                    </span>
                    <span
                      className={`yolo-rag-status-pill ${badgeClassName(badge.kind)}`}
                    >
                      {t(badge.labelKey, badge.kind)}
                    </span>
                  </div>
                  <div className="yolo-rag-log-query">
                    {summary.queryPreview}
                  </div>
                </button>
              )
            })
          )}
        </div>

        <div className="yolo-rag-log-detail">
          <div className="yolo-rag-log-detail-header">
            <span>{t('settings.rag.log.traceDetailTitle', '日志详情')}</span>
            {selectedTrace ? (
              <button
                className="mod-warning"
                onClick={() => handleDeleteTrace(selectedTrace)}
                disabled={deletingQueryId === selectedTrace.queryId}
              >
                {t('settings.rag.log.deleteTrace', '删除本条')}
              </button>
            ) : null}
          </div>

          <div className="yolo-rag-log-detail-body">
            {selectedTrace ? (
              <TraceDetail trace={selectedTrace} />
            ) : (
              <div className="yolo-rag-log-empty">
                {t('settings.rag.log.empty', '暂无 RAG 日志')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function TraceDetail({ trace }: { trace: RetrievalTrace }) {
  const { t } = useLanguage()
  const summary = formatTraceSummary(trace)
  const visibleTimingEntries = buildVisibleTimingEntries(trace)
  const diagnosticLines = [
    trace.errorCode
      ? `${t('settings.rag.log.error', '错误')}: ${trace.errorCode}`
      : null,
    trace.warningCodes.length > 0
      ? `${t('settings.rag.log.warning', '警告')}: ${trace.warningCodes.join(', ')}`
      : null,
    trace.diagnostic?.recoveryAction
      ? `${t('settings.rag.log.recoveryAction', '恢复建议')}: ${trace.diagnostic.recoveryAction}`
      : null,
    trace.diagnostic?.message ?? null,
  ].filter((line): line is string => Boolean(line))

  const totalDuration =
    typeof trace.timingsMs.total === 'number'
      ? trace.timingsMs.total
      : trace.finishedAt != null
        ? Math.max(0, trace.finishedAt - trace.startedAt)
        : 0

  return (
    <>
      <section className="yolo-rag-log-section">
        <div className="yolo-rag-log-section-title">
          {t('settings.rag.log.queryText', '检索 Query')}
        </div>
        <div className="yolo-rag-log-section-body">
          <div>{trace.queryText ?? t('settings.rag.log.unknown', '未知')}</div>
          <div className="yolo-rag-log-section-subtext">
            {summary.localTime} · {formatDurationMs(totalDuration)}
          </div>
        </div>
      </section>

      <section className="yolo-rag-log-section">
        <div className="yolo-rag-log-section-title">
          {t('settings.rag.log.timingBreakdown', '耗时明细')}
        </div>
        <div className="yolo-rag-log-section-body">
          <div className="yolo-rag-log-timing-grid">
            {visibleTimingEntries.map((entry) => (
              <div key={entry.key} className="yolo-rag-log-timing">
                <div className="yolo-rag-log-timing-label">
                  {formatTimingCardLabel(entry.key, t)}
                </div>
                <div className="yolo-rag-log-timing-value">
                  {formatDurationMs(entry.durationMs)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="yolo-rag-log-section">
        <div className="yolo-rag-log-section-title">
          {t('settings.rag.log.evidence', '证据片段')}
        </div>
        <div className="yolo-rag-log-section-body yolo-rag-log-evidence">
          {trace.evidence.length > 0 ? (
            trace.evidence.map((evidence, index) => (
              <div key={evidence.id} className="yolo-rag-log-evidence-row">
                <span className="yolo-rag-log-code">#{index + 1}</span>
                <span className="yolo-rag-log-evidence-path">
                  {evidence.path}
                </span>
                <span className="yolo-rag-log-code">
                  {typeof evidence.score === 'number'
                    ? evidence.score.toFixed(2)
                    : '—'}
                </span>
              </div>
            ))
          ) : (
            <div>{t('settings.rag.log.notAvailable', '无')}</div>
          )}
        </div>
      </section>

      <section className="yolo-rag-log-section">
        <div className="yolo-rag-log-section-title">
          {t('settings.rag.log.diagnostic', '诊断信息')}
        </div>
        <div className="yolo-rag-log-section-body">
          {diagnosticLines.length > 0
            ? diagnosticLines.map((line) => <div key={line}>{line}</div>)
            : null}
          {diagnosticLines.length === 0 ? (
            <div>{t('settings.rag.log.notAvailable', '无')}</div>
          ) : null}
        </div>
      </section>
    </>
  )
}

function badgeClassName(
  kind: ReturnType<typeof getTraceBadge>['kind'],
): string {
  switch (kind) {
    case 'success':
      return 'is-ready'
    case 'warning':
    case 'empty':
      return 'is-warning'
    case 'error':
    case 'aborted':
    default:
      return 'is-danger'
  }
}

function formatTimingCardLabel(
  key: string,
  t: (key: string, fallback?: string) => string,
): string {
  switch (key) {
    case 'total':
      return t('settings.rag.log.timingTotal', '总耗时')
    case 'embedQuery':
      return t('settings.rag.log.timingEmbedding', 'Embedding')
    case 'searchBackend':
      return t('settings.rag.log.timingRetrieval', '检索')
    case 'coarseSearch':
      return t('settings.rag.log.timingCoarse', '粗检索')
    case 'loadFullVectors':
      return t('settings.rag.log.timingFullVec', '读取 Full Vec')
    case 'rerankSimilarity':
      return t('settings.rag.log.timingSimilarityRerank', '相似度重排')
    case 'assembleEvidence':
      return t('settings.rag.log.timingAssemble', '组装证据')
    default:
      return key
  }
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return String(error)
}
