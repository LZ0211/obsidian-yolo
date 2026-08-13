import type { YoloSettings } from '../../settings/schema/setting.types'

import { captureRagIndexScope, ragIndexScopeChanged } from './ragIndexScope'

const baseRagOptions = (): YoloSettings['ragOptions'] => ({
  enabled: true,
  chunkSize: 1000,
  chunkOverlap: 50,
  minSimilarity: 0,
  limit: 10,
  rerankEnabled: true,
  embeddingConcurrency: 10,
  excludePatterns: [],
  excludeYoloBaseDir: true,
  includePatterns: [],
  indexPdf: true,
  diagnosticsEnabled: true,
  showRagLogRibbonIcon: true,
  autoUpdateEnabled: true,
  autoUpdateIntervalHours: 0,
  lastAutoUpdateAt: 0,
})

describe('captureRagIndexScope', () => {
  it('snapshots the scope keys with defensive copies of pattern lists', () => {
    const options = baseRagOptions()
    options.includePatterns = ['notes/**']

    const snapshot = captureRagIndexScope(options)

    expect(snapshot).toEqual({
      chunkSize: 1000,
      chunkOverlap: 50,
      indexPdf: true,
      includePatterns: ['notes/**'],
      excludePatterns: [],
      excludeYoloBaseDir: true,
    })
    // Mutating the source settings afterwards must not change the snapshot.
    options.includePatterns.push('extra/**')
    expect(snapshot.includePatterns).toEqual(['notes/**'])
  })
})

describe('ragIndexScopeChanged', () => {
  it('returns false when there is no baseline (fresh install / legacy data)', () => {
    expect(
      ragIndexScopeChanged(captureRagIndexScope(baseRagOptions()), undefined),
    ).toBe(false)
  })

  it('returns false when every scope key matches the baseline', () => {
    const current = captureRagIndexScope(baseRagOptions())
    const baseline = captureRagIndexScope(baseRagOptions())
    expect(ragIndexScopeChanged(current, baseline)).toBe(false)
  })

  it('compares pattern lists by value, not reference', () => {
    // The baseline snapshot copies the pattern arrays; a fresh capture of the
    // same options must not report a change just because the arrays differ by
    // reference (this is the round-trip after a successful index run).
    const options = baseRagOptions()
    options.includePatterns = ['notes/**']
    options.excludePatterns = ['private/**']
    const baseline = captureRagIndexScope(options)
    expect(ragIndexScopeChanged(captureRagIndexScope(options), baseline)).toBe(
      false,
    )
  })

  it('detects include/exclude pattern changes', () => {
    const current = captureRagIndexScope(baseRagOptions())
    const baseline = captureRagIndexScope(baseRagOptions())
    current.includePatterns = ['notes/**']
    expect(ragIndexScopeChanged(current, baseline)).toBe(true)

    baseline.excludePatterns = ['private/**']
    current.excludePatterns = []
    expect(ragIndexScopeChanged(current, baseline)).toBe(true)
  })

  it('detects chunkSize / chunkOverlap / indexPdf / excludeYoloBaseDir changes', () => {
    const current = captureRagIndexScope(baseRagOptions())
    const baseline = captureRagIndexScope(baseRagOptions())

    current.chunkSize = 800
    expect(ragIndexScopeChanged(current, baseline)).toBe(true)

    const current2 = captureRagIndexScope(baseRagOptions())
    current2.chunkOverlap = 100
    expect(ragIndexScopeChanged(current2, baseline)).toBe(true)

    const current3 = captureRagIndexScope(baseRagOptions())
    current3.indexPdf = false
    expect(ragIndexScopeChanged(current3, baseline)).toBe(true)

    const current4 = captureRagIndexScope(baseRagOptions())
    current4.excludeYoloBaseDir = false
    expect(ragIndexScopeChanged(current4, baseline)).toBe(true)
  })

  it('ignores retrieval-only keys (minSimilarity / limit / rerankEnabled)', () => {
    const current = captureRagIndexScope(baseRagOptions())
    const baseline = captureRagIndexScope(baseRagOptions())

    // Non-scope key changes must not demand a rebuild.
    const options = baseRagOptions()
    options.minSimilarity = 0.5
    options.limit = 30
    options.rerankEnabled = false
    expect(ragIndexScopeChanged(captureRagIndexScope(options), baseline)).toBe(
      false,
    )
  })
})
