import { buildReviewPrompt } from './review-prompt'

describe('buildReviewPrompt', () => {
  const task = {
    taskId: 't1',
    title: 'Add parser',
    status: 'awaiting_review',
    acceptanceCriteria: ['parses v2 frontmatter'],
    reviewHistory: [
      {
        decision: 'rework',
        evidence: [],
        comments: ['add roundtrip'],
        at: '2026-08-01T00:00:00.000Z',
      },
    ],
  } as any

  it('includes acceptance criteria, delivery content, and history', () => {
    const prompt = buildReviewPrompt({
      task,
      body: 'background',
      delivery: 'delivery text',
      history: 'history text',
    })
    expect(prompt).toMatch(/acceptance/i)
    expect(prompt).toMatch(/parses v2 frontmatter/)
    expect(prompt).toMatch(/delivery text/)
    expect(prompt).toMatch(/history text/)
  })

  it('demands a strict structured output', () => {
    const prompt = buildReviewPrompt({
      task,
      body: '',
      delivery: '',
      history: '',
    })
    expect(prompt).toMatch(/decision: approved|rework|escalated/)
    expect(prompt).toMatch(/findings/)
    expect(prompt).toMatch(/confidence/)
  })
})
