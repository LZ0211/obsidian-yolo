import { applyLegacyRerankResponse } from './rerank'

describe('legacy rerank adaptation', () => {
  const rows = [
    { path: 'a.md', similarity: 0.9 },
    { path: 'b.md', similarity: 0.8 },
    { path: 'c.md', similarity: 0.7 },
  ]

  it('puts the returned ordering before omitted items', () => {
    expect(
      applyLegacyRerankResponse(rows, {
        kind: 'ordering',
        indices: [2],
      }).map((row) => row.path),
    ).toEqual(['c.md', 'a.md', 'b.md'])
  })

  it('keeps partial scores safe and preserves original scores for omissions', () => {
    expect(
      applyLegacyRerankResponse(rows, {
        kind: 'scores',
        results: [
          { index: 1, relevanceScore: 0.95 },
          { index: 99, relevanceScore: 1 },
          { index: 0, relevanceScore: Number.NaN },
        ],
      }),
    ).toEqual([
      { path: 'b.md', similarity: 0.95 },
      { path: 'a.md', similarity: 0.9 },
      { path: 'c.md', similarity: 0.7 },
    ])
  })
})
