import type {
  RetrievalTrace,
  RetrievalTraceErrorCode,
} from '../../../core/rag/retrievalTraceTypes'

export type TraceBadgeKind =
  | 'success'
  | 'empty'
  | 'warning'
  | 'error'
  | 'aborted'

export type TraceBadge = {
  kind: TraceBadgeKind
  labelKey: string
}

export type TraceSummary = {
  queryPreview: string
  localTime: string
  durationText: string
  evidenceCount: number
}

export type TimingOverviewCard = {
  key:
    | 'total'
    | 'embedQuery'
    | 'searchBackend'
    | 'coarseSearch'
    | 'loadFullVectors'
    | 'rerankSimilarity'
    | 'assembleEvidence'
  label:
    | 'Total'
    | 'Embedding'
    | 'Retrieval'
    | 'Coarse'
    | 'Full Vec'
    | 'Similarity rerank'
    | 'Assemble'
  durationMs: number
}

export type RefreshSelectionOptions = {
  preserveSelection?: boolean
  currentSelectedQueryId?: string | null
  preferredQueryId?: string | null
}

const ABORT_ERROR_CODES = new Set<RetrievalTraceErrorCode>([
  'cancelled',
  'user_abort',
])

const QUERY_PREVIEW_LIMIT = 160
export function getTraceBadge(trace: RetrievalTrace): TraceBadge {
  if (trace.errorCode && ABORT_ERROR_CODES.has(trace.errorCode)) {
    return {
      kind: 'aborted',
      labelKey: 'settings.rag.log.statusAborted',
    }
  }

  if (trace.errorCode) {
    return {
      kind: 'error',
      labelKey: 'settings.rag.log.statusError',
    }
  }

  if (trace.warningCodes.length > 0) {
    return {
      kind: 'warning',
      labelKey: 'settings.rag.log.statusWarning',
    }
  }

  if (trace.evidence.length === 0) {
    return {
      kind: 'empty',
      labelKey: 'settings.rag.log.statusEmpty',
    }
  }

  return {
    kind: 'success',
    labelKey: 'settings.rag.log.statusSuccess',
  }
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '0 ms'
  }
  return `${Math.max(0, Math.round(ms))} ms`
}

export function formatLocalTime(
  timestamp: number,
  formatter: (date: Date) => string = (date) => date.toLocaleString(),
): string {
  if (!Number.isFinite(timestamp)) {
    return '—'
  }

  return formatter(new Date(timestamp))
}

function truncateQueryPreview(queryText: string): string {
  const trimmed = queryText.trim()
  if (trimmed.length <= QUERY_PREVIEW_LIMIT) {
    return trimmed
  }
  return `${trimmed.slice(0, QUERY_PREVIEW_LIMIT)}…`
}

export function buildTimingOverviewCards(
  trace: RetrievalTrace,
): TimingOverviewCard[] {
  const totalDuration =
    typeof trace.timingsMs.total === 'number'
      ? trace.timingsMs.total
      : trace.finishedAt != null
        ? Math.max(0, trace.finishedAt - trace.startedAt)
        : 0

  const cards: TimingOverviewCard[] = [
    {
      key: 'total',
      label: 'Total',
      durationMs: totalDuration,
    },
  ]

  if (typeof trace.timingsMs.embedQuery === 'number') {
    cards.push({
      key: 'embedQuery',
      label: 'Embedding',
      durationMs: trace.timingsMs.embedQuery,
    })
  }
  if (typeof trace.timingsMs.coarseSearch === 'number') {
    cards.push({
      key: 'coarseSearch',
      label: 'Coarse',
      durationMs: trace.timingsMs.coarseSearch,
    })
  }
  if (typeof trace.timingsMs.loadFullVectors === 'number') {
    cards.push({
      key: 'loadFullVectors',
      label: 'Full Vec',
      durationMs: trace.timingsMs.loadFullVectors,
    })
  }
  if (typeof trace.timingsMs.rerankSimilarity === 'number') {
    cards.push({
      key: 'rerankSimilarity',
      label: 'Similarity rerank',
      durationMs: trace.timingsMs.rerankSimilarity,
    })
  }
  if (cards.length === 1 && typeof trace.timingsMs.searchBackend === 'number') {
    cards.push({
      key: 'searchBackend',
      label: 'Retrieval',
      durationMs: trace.timingsMs.searchBackend,
    })
  }
  if (typeof trace.timingsMs.assembleEvidence === 'number') {
    cards.push({
      key: 'assembleEvidence',
      label: 'Assemble',
      durationMs: trace.timingsMs.assembleEvidence,
    })
  }

  return cards
}

export function buildVisibleTimingEntries(
  trace: RetrievalTrace,
): TimingOverviewCard[] {
  return buildTimingOverviewCards(trace)
}

export function formatTraceSummary(trace: RetrievalTrace): TraceSummary {
  const durationMs =
    typeof trace.timingsMs.total === 'number'
      ? trace.timingsMs.total
      : trace.finishedAt != null
        ? Math.max(0, trace.finishedAt - trace.startedAt)
        : 0

  return {
    queryPreview: truncateQueryPreview(trace.queryText ?? trace.queryId),
    localTime: formatLocalTime(trace.startedAt),
    durationText: formatDurationMs(durationMs),
    evidenceCount: trace.evidence.length,
  }
}

export function selectNextTraceAfterDelete(
  traces: RetrievalTrace[],
  deletedQueryId: string,
): RetrievalTrace | null {
  const deletedIndex = traces.findIndex(
    (trace) => trace.queryId === deletedQueryId,
  )
  if (deletedIndex === -1) {
    return traces[0] ?? null
  }

  const nextTrace = traces[deletedIndex - 1] ?? traces[deletedIndex + 1] ?? null
  return nextTrace
}

export function resolveSelectedQueryIdAfterRefresh(
  traces: RetrievalTrace[],
  options: RefreshSelectionOptions = {},
): string | null {
  const preferredQueryId = options.preferredQueryId ?? null
  if (
    preferredQueryId &&
    traces.some((trace) => trace.queryId === preferredQueryId)
  ) {
    return preferredQueryId
  }

  const currentSelectedQueryId = options.currentSelectedQueryId ?? null
  if (
    options.preserveSelection !== false &&
    currentSelectedQueryId &&
    traces.some((trace) => trace.queryId === currentSelectedQueryId)
  ) {
    return currentSelectedQueryId
  }

  return traces[0]?.queryId ?? null
}
