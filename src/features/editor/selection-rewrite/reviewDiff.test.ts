import { type ReviewDiffLine, buildReviewDiff } from './reviewDiff'

const flatten = (lines: ReviewDiffLine[]): string[] =>
  lines.map((line) => `${line.kind}:${line.text}`)

describe('buildReviewDiff', () => {
  it('keeps identical text as a single equal line', () => {
    const lines = buildReviewDiff('hello world', 'hello world')

    expect(lines).toEqual([{ kind: 'equal', text: 'hello world' }])
  })

  it('marks a wholly rewritten text as del + ins', () => {
    const lines = buildReviewDiff('old line', 'new line')

    expect(flatten(lines)).toEqual(['del:old line', 'ins:new line'])
  })

  it('keeps unchanged lines equal and marks only changed lines', () => {
    const lines = buildReviewDiff(
      'line one\nline two\nline three',
      'line one\nline TWO\nline three',
    )

    expect(flatten(lines)).toEqual([
      'equal:line one',
      'del:line two',
      'ins:line TWO',
      'equal:line three',
    ])
  })

  it('splits multi-line del and ins blocks into one line per entry', () => {
    const lines = buildReviewDiff('a\nb\nc', 'a\nx\ny\nc')

    expect(flatten(lines)).toEqual([
      'equal:a',
      'del:b',
      'ins:x',
      'ins:y',
      'equal:c',
    ])
  })

  it('handles empty originals (pure insertion)', () => {
    const lines = buildReviewDiff('', 'added')

    expect(flatten(lines)).toEqual(['ins:added'])
  })

  it('handles empty rewrites (pure deletion)', () => {
    const lines = buildReviewDiff('removed', '')

    expect(flatten(lines)).toEqual(['del:removed'])
  })

  it('handles both empty inputs', () => {
    expect(buildReviewDiff('', '')).toEqual([])
  })
})
