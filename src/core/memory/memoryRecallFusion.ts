/**
 * Reciprocal Rank Fusion (RRF) for multi-path memory recall.
 *
 * The lexical path (keyword + content matching), the semantic path (dense
 * embedding similarity), and the graph path (keyword-Jaccard expansion) each
 * produce their own ranked list of memory keys. RRF merges them by rank
 * position rather than by comparing incomparable scores — following
 * TencentDB-Agent-Memory's approach — so Chinese semantic recall (where
 * lexical matching is weak) and lexical precision combine without score
 * calibration.
 */

export const RRF_K = 60

export const fuseMemoryRecallRanks = (
  ...rankedLists: readonly (readonly string[])[]
): string[] => {
  const fused = new Map<string, number>()
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const key = list[rank]
      fused.set(key, (fused.get(key) ?? 0) + 1 / (RRF_K + rank + 1))
    }
  }
  return [...fused.entries()]
    .sort((left, right) => right[1] - left[1])
    .map((entry) => entry[0])
}
