import type { RetrievalTrace } from '../../../core/rag/retrievalTraceTypes'

import {
  buildTimingOverviewCards,
  buildVisibleTimingEntries,
  formatDurationMs,
  formatLocalTime,
  formatTraceSummary,
  getTraceBadge,
  resolveSelectedQueryIdAfterRefresh,
  selectNextTraceAfterDelete,
} from './ragLogModalRows'

const makeTrace = (
  overrides: Partial<RetrievalTrace> = {},
): RetrievalTrace => ({
  queryId: overrides.queryId ?? 'trace-1',
  backend: overrides.backend ?? 'sqlite',
  modelId: overrides.modelId ?? 'bge-m3',
  namespaceId: overrides.namespaceId ?? 'ns-1',
  queryText: overrides.queryText ?? '检索 query',
  startedAt: overrides.startedAt ?? 1_700_000_000_000,
  finishedAt: overrides.finishedAt ?? 1_700_000_000_218,
  timingsMs: overrides.timingsMs ?? {
    normalizeInput: 4,
    resolveScope: 9,
    embedQuery: 131,
    searchBackend: 45,
    assembleEvidence: 29,
    total: 218,
  },
  evidence: overrides.evidence ?? [
    { id: 'ev-1', path: 'docs/a.md', score: 0.8 },
  ],
  warningCodes: overrides.warningCodes ?? [],
  errorCode: overrides.errorCode,
  diagnostic: overrides.diagnostic,
  parentTraceId: overrides.parentTraceId,
  stepLabel: overrides.stepLabel,
  queryRole: overrides.queryRole,
})

describe('ragLogModalRows', () => {
  it('returns success badge for successful traces', () => {
    expect(getTraceBadge(makeTrace())).toEqual({
      kind: 'success',
      labelKey: 'settings.rag.log.statusSuccess',
    })
  })

  it('returns empty badge when trace has no evidence and no error', () => {
    expect(
      getTraceBadge(
        makeTrace({
          evidence: [],
          warningCodes: [],
        }),
      ),
    ).toEqual({
      kind: 'empty',
      labelKey: 'settings.rag.log.statusEmpty',
    })
  })

  it('returns warning badge when warnings are present', () => {
    expect(
      getTraceBadge(
        makeTrace({
          warningCodes: ['partial_evidence'],
        }),
      ),
    ).toEqual({
      kind: 'warning',
      labelKey: 'settings.rag.log.statusWarning',
    })
  })

  it('returns error badge when non-abort error is present', () => {
    expect(
      getTraceBadge(
        makeTrace({
          errorCode: 'transient_network_failure',
        }),
      ),
    ).toEqual({
      kind: 'error',
      labelKey: 'settings.rag.log.statusError',
    })
  })

  it('returns aborted badge for cancelled or user_abort traces', () => {
    expect(
      getTraceBadge(
        makeTrace({
          errorCode: 'cancelled',
        }),
      ),
    ).toEqual({
      kind: 'aborted',
      labelKey: 'settings.rag.log.statusAborted',
    })

    expect(
      getTraceBadge(
        makeTrace({
          errorCode: 'user_abort',
        }),
      ),
    ).toEqual({
      kind: 'aborted',
      labelKey: 'settings.rag.log.statusAborted',
    })
  })

  it('formats durations in ms and seconds', () => {
    expect(formatDurationMs(218)).toBe('218 ms')
    expect(formatDurationMs(1400)).toBe('1400 ms')
  })

  it('returns a stable fallback for invalid duration input', () => {
    expect(formatDurationMs(Number.NaN)).toBe('0 ms')
  })

  it('formats local time using the provided formatter for deterministic tests', () => {
    const timestamp = Date.UTC(2023, 10, 14, 22, 13, 20)

    expect(
      formatLocalTime(
        timestamp,
        (date) => `${date.getUTCFullYear()}-${date.getUTCMinutes()}`,
      ),
    ).toBe('2023-13')
  })

  it('returns a fallback marker when local time input is invalid', () => {
    expect(formatLocalTime(Number.NaN)).toBe('—')
  })

  it('truncates long query previews to 160 characters plus ellipsis', () => {
    const longQuery = '长'.repeat(200)

    expect(
      formatTraceSummary(makeTrace({ queryText: longQuery })).queryPreview,
    ).toBe(`${'长'.repeat(160)}…`)
  })

  it('builds timing overview cards for total, embedding, retrieval, and assembly', () => {
    expect(buildTimingOverviewCards(makeTrace())).toEqual([
      { key: 'total', label: 'Total', durationMs: 218 },
      { key: 'embedQuery', label: 'Embedding', durationMs: 131 },
      { key: 'assembleEvidence', label: 'Assemble', durationMs: 29 },
    ])
  })

  it('prefers detailed vector timings over generic searchBackend cards', () => {
    expect(
      buildTimingOverviewCards(
        makeTrace({
          timingsMs: {
            normalizeInput: 4,
            resolveScope: 9,
            embedQuery: 131,
            searchBackend: 45,
            coarseSearch: 12,
            loadFullVectors: 8,
            rerankSimilarity: 3,
            assembleEvidence: 29,
            total: 218,
          },
        }),
      ),
    ).toEqual([
      { key: 'total', label: 'Total', durationMs: 218 },
      { key: 'embedQuery', label: 'Embedding', durationMs: 131 },
      { key: 'coarseSearch', label: 'Coarse', durationMs: 12 },
      { key: 'loadFullVectors', label: 'Full Vec', durationMs: 8 },
      { key: 'rerankSimilarity', label: 'Similarity rerank', durationMs: 3 },
      { key: 'assembleEvidence', label: 'Assemble', durationMs: 29 },
    ])
  })

  it('omits missing optional timing cards while keeping total first', () => {
    expect(
      buildTimingOverviewCards(
        makeTrace({
          timingsMs: {
            normalizeInput: 1,
            resolveScope: 2,
            assembleEvidence: 4,
            total: 7,
          },
        }),
      ),
    ).toEqual([
      { key: 'total', label: 'Total', durationMs: 7 },
      { key: 'assembleEvidence', label: 'Assemble', durationMs: 4 },
    ])
  })

  it('builds a fixed visible timing list instead of dumping every trace field', () => {
    expect(
      buildVisibleTimingEntries(
        makeTrace({
          timingsMs: {
            normalizeInput: 4,
            resolveScope: 9,
            embedQuery: 131,
            searchBackend: 45,
            coarseSearch: 12,
            loadFullVectors: 8,
            rerankSimilarity: 3,
            assembleEvidence: 29,
            total: 218,
            lexicalFtsDurationMs: 99,
          },
        }),
      ).map((entry) => entry.key),
    ).toEqual([
      'total',
      'embedQuery',
      'coarseSearch',
      'loadFullVectors',
      'rerankSimilarity',
      'assembleEvidence',
    ])
  })

  it('selects the next available trace after delete', () => {
    const traces = [
      makeTrace({ queryId: 'trace-3', startedAt: 3 }),
      makeTrace({ queryId: 'trace-2', startedAt: 2 }),
      makeTrace({ queryId: 'trace-1', startedAt: 1 }),
    ]

    expect(selectNextTraceAfterDelete(traces, 'trace-2')?.queryId).toBe(
      'trace-3',
    )
    expect(selectNextTraceAfterDelete(traces, 'trace-3')?.queryId).toBe(
      'trace-2',
    )
    expect(
      selectNextTraceAfterDelete([makeTrace({ queryId: 'only' })], 'only'),
    ).toBe(null)
  })

  it('prefers an explicit selection after refresh over preserved selection', () => {
    const traces = [
      makeTrace({ queryId: 'trace-3', startedAt: 3 }),
      makeTrace({ queryId: 'trace-2', startedAt: 2 }),
      makeTrace({ queryId: 'trace-1', startedAt: 1 }),
    ]

    expect(
      resolveSelectedQueryIdAfterRefresh(traces, {
        preserveSelection: true,
        currentSelectedQueryId: 'trace-1',
        preferredQueryId: 'trace-2',
      }),
    ).toBe('trace-2')
  })

  it('returns null when refresh has no traces left to select', () => {
    expect(
      resolveSelectedQueryIdAfterRefresh([], {
        preserveSelection: false,
        currentSelectedQueryId: 'trace-1',
        preferredQueryId: null,
      }),
    ).toBeNull()
  })
})
