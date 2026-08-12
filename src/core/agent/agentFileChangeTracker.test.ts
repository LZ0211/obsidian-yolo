import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { AgentFileChange } from '../../types/chat'

import { AgentFileChangeTracker } from './agentFileChangeTracker'
import type {
  AgentGitDiffEnricher,
  AgentGitDiffRun,
} from './git-diff/agentGitDiffEnricher'

type FakeEnricher = Pick<
  AgentGitDiffEnricher,
  'beginRun' | 'finishRun' | 'markChanged'
>

function createGitRun(): AgentGitDiffRun {
  return {
    baseline: Promise.resolve(null),
    baselineSettled: false,
    invalidated: false,
  }
}

function createEnricher(): jest.Mocked<FakeEnricher> {
  return {
    beginRun: jest.fn(() => createGitRun()),
    finishRun: jest.fn(async (_run, changes) => changes),
    markChanged: jest.fn(),
  }
}

function policy(
  workspaceRoot: string,
  writeExcludes: string[] = [],
): WorkspaceAccessPolicy {
  return {
    enabled: true,
    workspaceRoot,
    readExtraIncludes: [],
    readExcludes: [],
    writeExcludes,
  }
}

describe('AgentFileChangeTracker', () => {
  it('passes coalesced fallback changes to the enricher and returns its result', async () => {
    const gitDiffEnricher = createEnricher()
    const gitRun = createGitRun()
    gitDiffEnricher.beginRun.mockReturnValue(gitRun)
    const tracker = new AgentFileChangeTracker({ gitDiffEnricher })
    const run = tracker.beginRun()
    const enriched: AgentFileChange[] = [
      { kind: 'created', path: 'a.md' },
      {
        kind: 'modified',
        path: 'z.md',
        gitDiff: { additions: 2, deletions: 1 },
      },
    ]
    gitDiffEnricher.finishRun.mockResolvedValue(enriched)

    tracker.record({ kind: 'modified', path: 'z.md' })
    tracker.record({ kind: 'created', path: 'a.md' })
    tracker.record({ kind: 'modified', path: 'z.md' })

    await expect(tracker.finishRun(run)).resolves.toBe(enriched)
    expect(gitDiffEnricher.finishRun).toHaveBeenCalledWith(gitRun, [
      { kind: 'created', path: 'a.md' },
      { kind: 'modified', path: 'z.md' },
    ])
  })

  it('passes the workspace access policy to the enricher at begin', () => {
    const gitDiffEnricher = createEnricher()
    const tracker = new AgentFileChangeTracker({ gitDiffEnricher })
    const workspaceAccessPolicy = policy('Projects/Alpha')

    tracker.beginRun({ workspaceAccessPolicy })

    expect(gitDiffEnricher.beginRun).toHaveBeenCalledWith(workspaceAccessPolicy)
  })

  it('marks only events accepted by the run policy', () => {
    const gitDiffEnricher = createEnricher()
    const gitRun = createGitRun()
    gitDiffEnricher.beginRun.mockReturnValue(gitRun)
    const tracker = new AgentFileChangeTracker({ gitDiffEnricher })
    tracker.beginRun({
      workspaceAccessPolicy: policy('Projects/Alpha', [
        'Projects/Alpha/private',
      ]),
    })

    tracker.record({ kind: 'modified', path: 'Projects/Other/ignored.md' })
    tracker.record({
      kind: 'modified',
      path: 'Projects/Alpha/private/ignored.md',
    })

    expect(gitDiffEnricher.markChanged).not.toHaveBeenCalled()

    tracker.record({ kind: 'modified', path: 'Projects/Alpha/report.md' })

    expect(gitDiffEnricher.markChanged).toHaveBeenCalledTimes(1)
    expect(gitDiffEnricher.markChanged).toHaveBeenCalledWith(gitRun)
  })

  it('always excludes the current YOLO directory even without a workspace policy', async () => {
    const tracker = new AgentFileChangeTracker({
      getAlwaysExcludedPaths: () => ['YOLO'],
    })
    const run = tracker.beginRun()

    tracker.record({ kind: 'modified', path: 'YOLO/.yolo_json_db/chat.json' })
    tracker.record({ kind: 'modified', path: 'Notes/result.md' })

    await expect(tracker.finishRun(run)).resolves.toEqual([
      { kind: 'modified', path: 'Notes/result.md' },
    ])
  })

  it('excludes both sides of a rename when either side is inside YOLO', async () => {
    const tracker = new AgentFileChangeTracker({
      getAlwaysExcludedPaths: () => ['YOLO'],
    })
    const run = tracker.beginRun()

    tracker.record({
      kind: 'renamed',
      oldPath: 'Notes/result.md',
      path: 'YOLO/archive/result.md',
    })
    tracker.record({
      kind: 'renamed',
      oldPath: 'YOLO/archive/old.md',
      path: 'Notes/new.md',
    })

    await expect(tracker.finishRun(run)).resolves.toEqual([
      { kind: 'created', path: 'Notes/new.md' },
      { kind: 'deleted', path: 'Notes/result.md' },
    ])
  })

  it.each<{
    change: AgentFileChange
    expected: AgentFileChange[]
    label: string
  }>([
    {
      label: 'renamed when both paths are accepted',
      change: {
        kind: 'renamed',
        oldPath: 'Projects/Alpha/old.md',
        path: 'Projects/Alpha/new.md',
      },
      expected: [
        {
          kind: 'renamed',
          oldPath: 'Projects/Alpha/old.md',
          path: 'Projects/Alpha/new.md',
        },
      ],
    },
    {
      label: 'deleted when only the old path is accepted',
      change: {
        kind: 'renamed',
        oldPath: 'Projects/Alpha/old.md',
        path: 'Projects/Other/new.md',
      },
      expected: [{ kind: 'deleted', path: 'Projects/Alpha/old.md' }],
    },
    {
      label: 'created when only the new path is accepted',
      change: {
        kind: 'renamed',
        oldPath: 'Projects/Other/old.md',
        path: 'Projects/Alpha/new.md',
      },
      expected: [{ kind: 'created', path: 'Projects/Alpha/new.md' }],
    },
  ])(
    'marks a rename once when it is recorded as $label',
    async ({ change, expected }) => {
      const gitDiffEnricher = createEnricher()
      const gitRun = createGitRun()
      gitDiffEnricher.beginRun.mockReturnValue(gitRun)
      const tracker = new AgentFileChangeTracker({ gitDiffEnricher })
      const run = tracker.beginRun({
        workspaceAccessPolicy: policy('Projects/Alpha'),
      })

      tracker.record(change)

      expect(gitDiffEnricher.markChanged).toHaveBeenCalledTimes(1)
      expect(gitDiffEnricher.markChanged).toHaveBeenCalledWith(gitRun)
      await expect(tracker.finishRun(run)).resolves.toEqual(expected)
    },
  )

  it('does not mark a rename when both paths are out of scope', async () => {
    const gitDiffEnricher = createEnricher()
    const tracker = new AgentFileChangeTracker({ gitDiffEnricher })
    const run = tracker.beginRun({
      workspaceAccessPolicy: policy('Projects/Alpha'),
    })

    tracker.record({
      kind: 'renamed',
      oldPath: 'Projects/Other/old.md',
      path: 'Projects/Other/new.md',
    })

    expect(gitDiffEnricher.markChanged).not.toHaveBeenCalled()
    await expect(tracker.finishRun(run)).resolves.toEqual([])
  })

  it('marks each active run only for events accepted by that run', () => {
    const gitDiffEnricher = createEnricher()
    const alphaGitRun = createGitRun()
    const betaGitRun = createGitRun()
    gitDiffEnricher.beginRun
      .mockReturnValueOnce(alphaGitRun)
      .mockReturnValueOnce(betaGitRun)
    const tracker = new AgentFileChangeTracker({ gitDiffEnricher })
    tracker.beginRun({ workspaceAccessPolicy: policy('Projects/Alpha') })
    tracker.beginRun({ workspaceAccessPolicy: policy('Projects/Beta') })

    tracker.record({ kind: 'modified', path: 'Projects/Alpha/a.md' })
    tracker.record({ kind: 'modified', path: 'Projects/Beta/b.md' })
    tracker.record({ kind: 'modified', path: 'Projects/Other/ignored.md' })

    expect(gitDiffEnricher.markChanged.mock.calls).toEqual([
      [alphaGitRun],
      [betaGitRun],
    ])
  })

  it('keeps coalescing, filtering, and sorting without an enricher', async () => {
    const tracker = new AgentFileChangeTracker()
    const run = tracker.beginRun({
      workspaceAccessPolicy: policy('Projects/Alpha'),
    })

    tracker.record({ kind: 'modified', path: 'Projects/Alpha/z.md' })
    tracker.record({ kind: 'created', path: 'Projects/Alpha/report.md' })
    tracker.record({ kind: 'modified', path: 'Projects/Alpha/report.md' })
    tracker.record({ kind: 'modified', path: 'Projects/Other/ignored.md' })
    tracker.record({
      kind: 'renamed',
      oldPath: 'Projects/Alpha/report.md',
      path: 'Projects/Alpha/final-report.md',
    })

    const result = tracker.finishRun(run)
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toEqual([
      { kind: 'created', path: 'Projects/Alpha/final-report.md' },
      { kind: 'modified', path: 'Projects/Alpha/z.md' },
    ])
    await expect(tracker.finishRun(Symbol('unknown'))).resolves.toEqual([])
  })

  it('records a shared vault event for every active run without an enricher', async () => {
    const tracker = new AgentFileChangeTracker()
    const first = tracker.beginRun()
    const second = tracker.beginRun()

    tracker.record({ kind: 'modified', path: 'Notes/shared.md' })

    await expect(tracker.finishRun(first)).resolves.toEqual([
      { kind: 'modified', path: 'Notes/shared.md' },
    ])
    await expect(tracker.finishRun(second)).resolves.toEqual([
      { kind: 'modified', path: 'Notes/shared.md' },
    ])
  })
})
