import type { TaskRecord } from './types'

import {
  ProjectTransitionError,
  applyReviewDecision,
  assertTaskTransition,
  canTransitionTask,
} from './transition'

const makeTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  schemaVersion: 2,
  projectId: 'proj-1',
  taskId: 'T-001',
  revision: 1,
  title: 'Task',
  status: 'pending',
  assignee: 'parent',
  dependencies: [],
  acceptanceCriteria: [],
  priority: 'medium',
  reviewStatus: null,
  reworkCount: 0,
  deliveryRefs: [],
  attempts: [],
  blockRecurrences: 0,
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  ...overrides,
})

describe('task transitions', () => {
  it('allows expected forward transitions', () => {
    expect(canTransitionTask('pending', 'in_progress')).toBe(true)
    expect(canTransitionTask('in_progress', 'awaiting_review')).toBe(true)
    expect(canTransitionTask('awaiting_review', 'completed')).toBe(true)
    expect(canTransitionTask('rework', 'in_progress')).toBe(true)
    expect(canTransitionTask('pending', 'blocked')).toBe(true)
    expect(canTransitionTask('pending', 'cancelled')).toBe(true)
  })

  it('rejects invalid transitions', () => {
    expect(canTransitionTask('pending', 'completed')).toBe(false)
    expect(canTransitionTask('completed', 'in_progress')).toBe(false)
    expect(() => assertTaskTransition('pending', 'completed')).toThrow(
      ProjectTransitionError,
    )
  })

  it('allows same-status no-op', () => {
    expect(canTransitionTask('pending', 'pending')).toBe(true)
    expect(() => assertTaskTransition('pending', 'pending')).not.toThrow()
  })
})

describe('review decisions', () => {
  it('approves awaiting_review to completed', () => {
    const record = applyReviewDecision(
      makeTask({ status: 'awaiting_review' }),
      'approved',
      [],
    )
    expect(record).toMatchObject({ status: 'completed', reviewStatus: 'approved' })
  })

  it('rejects approval outside awaiting_review', () => {
    expect(() =>
      applyReviewDecision(makeTask({ status: 'in_progress' }), 'approved', []),
    ).toThrow(ProjectTransitionError)
  })

  it('rework requires actionable comments and increments the counter', () => {
    expect(() =>
      applyReviewDecision(makeTask({ status: 'awaiting_review' }), 'rework', []),
    ).toThrow(/actionable comment/i)

    const record = applyReviewDecision(
      makeTask({ status: 'awaiting_review', reworkCount: 2 }),
      'rework',
      ['Fix the parity test.'],
    )
    expect(record).toMatchObject({
      status: 'rework',
      reviewStatus: 'rework',
      reworkCount: 3,
    })
  })

  it('escalates without pretending completion', () => {
    const record = applyReviewDecision(
      makeTask({ status: 'awaiting_review' }),
      'escalated',
      ['Needs human judgment.'],
    )
    expect(record).toMatchObject({
      status: 'awaiting_review',
      reviewStatus: 'escalated',
    })
  })
})

describe('running transitions', () => {
  it('allows entering running from pending, in_progress, blocked, rework', () => {
    for (const from of ['pending', 'in_progress', 'blocked', 'rework'] as const) {
      expect(canTransitionTask(from, 'running')).toBe(true)
    }
  })

  it('allows leaving running to awaiting_review, blocked, pending, in_progress, cancelled', () => {
    for (const to of ['awaiting_review', 'blocked', 'pending', 'in_progress', 'cancelled'] as const) {
      expect(canTransitionTask('running', to)).toBe(true)
    }
  })

  it('allows running to running (renew only)', () => {
    expect(canTransitionTask('running', 'running')).toBe(true)
  })

  it('forbids running to completed directly (must go through review)', () => {
    expect(canTransitionTask('running', 'completed')).toBe(false)
  })
})
