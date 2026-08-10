import type { AgentFileChange } from '../../../types/chat'

import {
  AgentGitDiffEnricher,
  type AgentGitDiffRun,
} from './agentGitDiffEnricher'
import type {
  AgentGitDiffBackend,
  ShadowGitBaseline,
} from './shadowGitDiffBackend'

type Deferred<T> = {
  promise: Promise<T>
  reject: (reason: unknown) => void
  resolve: (value: T) => void
}

type FakeAgentGitDiffBackend = jest.Mocked<AgentGitDiffBackend> & {
  discard: jest.MockedFunction<(baseline: ShadowGitBaseline) => Promise<void>>
}

function deferred<T>(): Deferred<T> {
  let reject!: (reason: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function createBackend(
  baseline: Deferred<ShadowGitBaseline | null>,
): FakeAgentGitDiffBackend {
  return {
    begin: jest.fn(
      (_policy: Parameters<AgentGitDiffBackend['begin']>[0]) =>
        baseline.promise,
    ),
    discard: jest.fn(async (_baseline: ShadowGitBaseline) => undefined),
    finish: jest.fn(),
  }
}

function createBaseline(): ShadowGitBaseline {
  return {
    tree: 'baseline-tree',
    gitDir: '.git',
    indexFile: '.git/index',
    repoRoot: '/repo',
    vaultPrefix: 'Vault',
  }
}

function change(path = 'a.md'): AgentFileChange {
  return { kind: 'modified', path }
}

async function settleBaseline(
  run: AgentGitDiffRun,
  baseline: Deferred<ShadowGitBaseline | null>,
  value: ShadowGitBaseline | null,
): Promise<void> {
  baseline.resolve(value)
  await run.baseline
}

describe('AgentGitDiffEnricher', () => {
  it('merges Git stats after the baseline is ready', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const readyBaseline = createBaseline()
    const changes = [change()]
    backend.finish.mockResolvedValue(
      new Map([['a.md', { additions: 2, deletions: 1 }]]),
    )

    const run = enricher.beginRun()

    expect(backend.begin).toHaveBeenCalledTimes(1)
    await settleBaseline(run, baseline, readyBaseline)
    expect(run.baselineSettled).toBe(true)
    enricher.markChanged(run)
    expect(run.invalidated).toBe(false)

    await expect(enricher.finishRun(run, changes)).resolves.toEqual([
      {
        kind: 'modified',
        path: 'a.md',
        gitDiff: { additions: 2, deletions: 1 },
      },
    ])
    expect(backend.finish).toHaveBeenCalledWith(readyBaseline, changes)
    expect(changes).toEqual([change()])
  })

  it('falls back when a change arrives before the baseline settles', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const changes = [change()]
    const run = enricher.beginRun()
    const readyBaseline = createBaseline()

    enricher.markChanged(run)

    await expect(enricher.finishRun(run, changes)).resolves.toBe(changes)
    expect(backend.finish).not.toHaveBeenCalled()
    expect(backend.discard).not.toHaveBeenCalled()

    await settleBaseline(run, baseline, readyBaseline)
    await Promise.resolve()

    expect(backend.discard).toHaveBeenCalledWith(readyBaseline)
  })

  it('falls back when the backend cannot create a baseline', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const changes = [change()]
    const run = enricher.beginRun()

    await settleBaseline(run, baseline, null)

    await expect(enricher.finishRun(run, changes)).resolves.toBe(changes)
    expect(backend.finish).not.toHaveBeenCalled()
  })

  it('falls back when the backend returns no Git stats', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const changes = [change()]
    const run = enricher.beginRun()
    backend.finish.mockResolvedValue(new Map())
    await settleBaseline(run, baseline, createBaseline())

    await expect(enricher.finishRun(run, changes)).resolves.toBe(changes)
  })

  it('catches a rejected begin and falls back', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const changes = [change()]
    const run = enricher.beginRun()

    baseline.reject(new Error('begin failed'))

    await expect(run.baseline).resolves.toBeNull()
    await expect(enricher.finishRun(run, changes)).resolves.toBe(changes)
    expect(backend.finish).not.toHaveBeenCalled()
  })

  it('catches a rejected finish and falls back', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const changes = [change()]
    const run = enricher.beginRun()
    backend.finish.mockRejectedValue(new Error('finish failed'))
    await settleBaseline(run, baseline, createBaseline())

    await expect(enricher.finishRun(run, changes)).resolves.toBe(changes)
  })

  it('skips finish for empty changes and discards a late baseline', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const changes: AgentFileChange[] = []
    const run = enricher.beginRun()
    const readyBaseline = createBaseline()

    await expect(enricher.finishRun(run, changes)).resolves.toBe(changes)
    expect(backend.finish).not.toHaveBeenCalled()
    expect(backend.discard).not.toHaveBeenCalled()

    await settleBaseline(run, baseline, readyBaseline)
    await Promise.resolve()

    expect(backend.discard).toHaveBeenCalledWith(readyBaseline)
    expect(run.baselineSettled).toBe(true)
  })

  it('catches a rejected discard and keeps the empty fallback', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const changes: AgentFileChange[] = []
    const run = enricher.beginRun()
    backend.discard.mockRejectedValue(new Error('discard failed'))

    await expect(enricher.finishRun(run, changes)).resolves.toBe(changes)
    await settleBaseline(run, baseline, createBaseline())
    await Promise.resolve()

    expect(backend.discard).toHaveBeenCalledTimes(1)
  })

  it('safely settles a rejected late baseline for empty changes', async () => {
    const baseline = deferred<ShadowGitBaseline | null>()
    const backend = createBackend(baseline)
    const enricher = new AgentGitDiffEnricher(backend)
    const changes: AgentFileChange[] = []
    const run = enricher.beginRun()

    await expect(enricher.finishRun(run, changes)).resolves.toBe(changes)
    baseline.reject(new Error('late begin failure'))

    await expect(run.baseline).resolves.toBeNull()
    expect(backend.discard).not.toHaveBeenCalled()
  })
})
