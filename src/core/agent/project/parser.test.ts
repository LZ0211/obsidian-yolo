import type { TaskAttempt, TaskRecord } from './types'

import {
  ProjectParseError,
  buildProjectFileContent,
  buildTaskFileContent,
  extractFrontmatter,
  parseProjectRecord,
  parseTaskRecord,
  serializeTaskFrontmatter,
} from './parser'

const projectFrontmatter = `schema_version: 2
project_id: proj-agent-loop
project_name: Agent Loop
created_at: 2026-07-31T09:00:00.000Z
updated_at: 2026-07-31T14:00:00.000Z
`

const taskFrontmatter = `schema_version: 2
project_id: proj-agent-loop
task_id: T-002
revision: 7
title: Propagate finish reason
status: in_progress
assignee: parent
dependencies:
  - T-001
acceptance_criteria:
  - Raw provider finish reason reaches diagnostics
priority: high
review_status: null
rework_count: 0
delivery_refs: []
attempts: []
created_at: 2026-07-31T09:05:00.000Z
updated_at: 2026-07-31T14:10:00.000Z
`

describe('extractFrontmatter', () => {
  it('splits frontmatter from the body', () => {
    const result = extractFrontmatter(`---\nschema_version: 1\n---\nbody text`)
    expect(result).toEqual({
      frontmatter: 'schema_version: 1',
      body: 'body text',
    })
  })

  it('returns null frontmatter when absent', () => {
    const result = extractFrontmatter('just body')
    expect(result).toEqual({ frontmatter: null, body: 'just body' })
  })
})

describe('parseProjectRecord', () => {
  it('parses a valid project frontmatter', () => {
    const record = parseProjectRecord(projectFrontmatter)
    expect(record).toMatchObject({
      schemaVersion: 2,
      projectId: 'proj-agent-loop',
      projectName: 'Agent Loop',
    })
    // Legacy files that still carry frozen status/revision parse fine; the
    // fields are simply not part of the record anymore.
    const legacy = parseProjectRecord(
      projectFrontmatter + 'status: in_progress\nrevision: 3\n',
    )
    expect(legacy).toMatchObject({
      schemaVersion: 2,
      projectId: 'proj-agent-loop',
      projectName: 'Agent Loop',
    })
  })

  it('roundtrips project frontmatter without frozen status/revision', () => {
    const record = parseProjectRecord(projectFrontmatter)
    const serialized = buildProjectFileContent(record, '')
    expect(serialized).not.toContain('status:')
    expect(serialized).not.toContain('revision:')
    expect(serialized).toContain('project_id: proj-agent-loop')
  })

  it('rejects an unsupported schema version', () => {
    expect(() =>
      parseProjectRecord(projectFrontmatter.replace('schema_version: 2', 'schema_version: 3')),
    ).toThrow(ProjectParseError)
  })

  it('rejects a missing required field', () => {
    expect(() =>
      parseProjectRecord(projectFrontmatter.replace('project_name: Agent Loop\n', '')),
    ).toThrow(/missing "project_name"/)
  })
})

describe('parseTaskRecord', () => {
  it('parses a valid task frontmatter', () => {
    const record = parseTaskRecord(taskFrontmatter)
    expect(record).toMatchObject({
      schemaVersion: 2,
      projectId: 'proj-agent-loop',
      taskId: 'T-002',
      revision: 7,
      title: 'Propagate finish reason',
      status: 'in_progress',
      assignee: 'parent',
      dependencies: ['T-001'],
      acceptanceCriteria: ['Raw provider finish reason reaches diagnostics'],
      priority: 'high',
      reviewStatus: null,
    })
  })

  it('rejects an invalid status', () => {
    expect(() =>
      parseTaskRecord(taskFrontmatter.replace('status: in_progress', 'status: bogus')),
    ).toThrow(/bad "status"/)
  })
})

describe('serialize + parse round-trip', () => {
  it('round-trips a task record through serialization', () => {
    const original = parseTaskRecord(taskFrontmatter)
    const serialized = serializeTaskFrontmatter(original)
    const reparsed = parseTaskRecord(serialized)
    expect(reparsed).toEqual(original)
  })

  it('builds a full task file that parses back', () => {
    const original = parseTaskRecord(taskFrontmatter)
    const content = buildTaskFileContent(original, '## Context\n\nbody')
    const split = extractFrontmatter(content)
    expect(split?.frontmatter).toBeDefined()
    expect(split?.body).toContain('## Context')
    expect(parseTaskRecord(split!.frontmatter!)).toEqual(original)
  })

  it('builds a project file that parses back', () => {
    const original = parseProjectRecord(projectFrontmatter)
    const content = buildProjectFileContent(original, '# Agent Loop')
    const split = extractFrontmatter(content)
    expect(parseProjectRecord(split!.frontmatter!)).toEqual(original)
  })

  it('round-trips review_history evidence through serialization', () => {
    const original = parseTaskRecord(taskFrontmatter)
    const withReviews: TaskRecord = {
      ...original,
      blockRecurrences: 0,
      reviewHistory: [
        {
          decision: 'rework',
          evidence: [
            {
              kind: 'test',
              reference: 'npm test',
              summary: 'Parity test fails on Windows.',
            },
          ],
          comments: ['Fix the path case sensitivity.'],
          at: '2026-07-31T15:30:00.000Z',
        },
        {
          decision: 'approved',
          evidence: [
            {
              kind: 'file',
              reference: 'src/core/agent/llm-turn-executor.ts',
              summary: 'Reviewed the finish-reason propagation.',
            },
          ],
          comments: [],
          at: '2026-07-31T16:00:00.000Z',
        },
      ],
    }
    const serialized = serializeTaskFrontmatter(withReviews)
    expect(serialized).toContain('review_history')
    const reparsed = parseTaskRecord(serialized)
    expect(reparsed.reviewHistory).toEqual(withReviews.reviewHistory)
  })
})

describe('schema v2 types', () => {
  it('TaskRecord carries claim, block reason, and lifecycle attempts', () => {
    const attempt: TaskAttempt = {
      runKey: 'run-1',
      status: 'running',
      dispatchedAt: '2026-08-03T00:00:00.000Z',
    }
    const record = {
      schemaVersion: 2,
      projectId: 'p1',
      taskId: 't1',
      revision: 1,
      title: 'T',
      status: 'running',
      assignee: 'parent',
      dependencies: [],
      acceptanceCriteria: [],
      priority: 'medium',
      reviewStatus: null,
      reworkCount: 0,
      deliveryRefs: [],
      attempts: [attempt],
      blockRecurrences: 0,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    } satisfies TaskRecord
    expect(record.status).toBe('running')
    expect(record.attempts[0].status).toBe('running')
  })
})

const v2Record: TaskRecord = {
  schemaVersion: 2,
  projectId: 'p1',
  taskId: 't1',
  revision: 3,
  title: 'Task',
  status: 'running',
  assignee: 'parent',
  dependencies: [],
  acceptanceCriteria: [],
  priority: 'medium',
  reviewStatus: null,
  reworkCount: 0,
  deliveryRefs: ['deliverables/t1/run-1.md'],
  attempts: [
    {
      runKey: 'run-1',
      status: 'running',
      dispatchedAt: '2026-08-03T00:00:00.000Z',
    },
  ],
  blockRecurrences: 0,
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
}

describe('parser v2', () => {
  it('roundtrips claim, block_reason, and lifecycle attempts', () => {
    const withClaim: typeof v2Record = {
      ...v2Record,
      claim: {
        runKey: 'run-1',
        dispatchedAt: '2026-08-03T00:00:00.000Z',
        expiresAt: '2026-08-03T00:30:00.000Z',
      },
      blockReason: { kind: 'dependency', detail: 'waiting on t2' },
      blockRecurrences: 2,
      attempts: [
        {
          runKey: 'run-0',
          status: 'failed',
          dispatchedAt: '2026-08-02T00:00:00.000Z',
          completedAt: '2026-08-02T00:05:00.000Z',
          error: 'timeout',
        },
        ...v2Record.attempts,
      ],
    }
    const content = buildTaskFileContent(withClaim, 'body')
    const frontmatter = extractFrontmatter(content)?.frontmatter ?? ''
    const parsed = parseTaskRecord(frontmatter, 't1.md')
    expect(parsed.claim?.runKey).toBe('run-1')
    expect(parsed.claim?.expiresAt).toBe('2026-08-03T00:30:00.000Z')
    expect(parsed.blockReason?.kind).toBe('dependency')
    expect(parsed.blockRecurrences).toBe(2)
    expect(parsed.attempts[0].status).toBe('failed')
    expect(parsed.attempts[0].error).toBe('timeout')
    expect(parsed.attempts[1].status).toBe('running')
    expect(parsed.attempts[1].completedAt).toBeUndefined()
  })

  it('serializes claim and block fields back to frontmatter', () => {
    const frontmatter = buildTaskFileContent({ ...v2Record, claim: { runKey: 'run-1', dispatchedAt: '2026-08-03T00:00:00.000Z', expiresAt: '2026-08-03T00:30:00.000Z' }, blockReason: { kind: 'transient' }, blockRecurrences: 1 }, '')
    expect(frontmatter).toContain('block_reason')
    expect(frontmatter).toContain('block_recurrences: 1')
    expect(frontmatter).toContain('claim:')
  })

  it('rejects a v1 task file with terminal_state', () => {
    const v1Frontmatter = [
      'schema_version: 1',
      'project_id: p1',
      'task_id: t1',
      'revision: 1',
      'title: Old',
      'status: pending',
      'assignee: parent',
      'dependencies: []',
      'acceptance_criteria: []',
      'priority: medium',
      'review_status: null',
      'rework_count: 0',
      'delivery_refs: []',
      'attempts:',
      '  - run_key: r1',
      '    dispatched_at: 2026-08-01T00:00:00.000Z',
      '    result: x',
      '    terminal_state: done',
      'created_at: 2026-08-01T00:00:00.000Z',
      'updated_at: 2026-08-01T00:00:00.000Z',
    ].join('\n')
    expect(() => parseTaskRecord(v1Frontmatter, 't1.md')).toThrow(
      /schema_version/,
    )
  })
})
