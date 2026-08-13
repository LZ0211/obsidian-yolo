import { normalizePath } from 'obsidian'

import type { YoloSettingsLike } from '../../../types/yoloSettingsLike'
import { subagentTaskRegistry } from '../subagent/task-registry'
import type { SubagentTaskRecord } from '../subagent/types'

import {
  ProjectStore,
  type ProjectStoreOptions,
  type ProjectVaultAdapter,
} from './store'
import {
  buildTaskFileContent,
  extractFrontmatter,
  parseTaskRecord,
} from './parser'
import type { VersionedTask } from './types'

const makeProjectWithTask = async (store: ProjectStore) => {
  const r = await store.initProject({
    projectId: 'p1',
    projectName: 'P',
    tasks: [{ taskId: 't1', title: 'T' }],
  })
  if (!r.ok) throw new Error('setup failed')
}
const preconditionOf = (v: VersionedTask | null) => {
  if (!v) throw new Error('expected a task read')
  return {
    expectedRevision: v.revision,
    expectedContentHash: v.contentHash,
  }
}

class FakeAdapter implements ProjectVaultAdapter {
  private readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>()

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path)
    return this.files.has(normalized) || this.dirs.has(normalized)
  }

  async read(path: string): Promise<string> {
    const normalized = normalizePath(path)
    const value = this.files.get(normalized)
    if (value === undefined) throw new Error(`file not found: ${normalized}`)
    return value
  }

  async write(path: string, data: string): Promise<void> {
    const normalized = normalizePath(path)
    this.files.set(normalized, data)
    const slash = normalized.lastIndexOf('/')
    if (slash > 0) this.dirs.add(normalized.slice(0, slash))
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(normalizePath(path))
  }

  async list(
    path: string,
  ): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${normalizePath(path)}/`
    return {
      files: [...this.files.keys()]
        .filter(
          (file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'),
        )
        .sort(),
      folders: [...this.dirs].filter(
        (dir) => dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/'),
      ),
    }
  }
}

/**
 * FakeAdapter that can block a specific read of a path (by read index) until
 * released, optionally serving a snapshot instead of the current file content.
 * Used to deterministically construct the reclaim lost-update window: `status()`
 * must observe a stale `running`+expired snapshot in `listTasks` while a
 * concurrent ingest has already advanced the on-disk file before the reclaim
 * write lands.
 */
class GatedAdapter extends FakeAdapter {
  private readonly readCounts = new Map<string, number>()
  private readonly gates = new Map<
    string,
    Array<{
      when: number
      snapshot?: string
      promise: Promise<void>
      release: () => void
      resolveOpened: () => void
    }>
  >()

  gateRead(
    path: string,
    when: number,
    snapshot?: string,
  ): { opened: Promise<void>; release: () => void } {
    const normalized = normalizePath(path)
    let release!: () => void
    let resolveOpened!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    const opened = new Promise<void>((resolve) => {
      resolveOpened = resolve
    })
    const gates = this.gates.get(normalized) ?? []
    gates.push({ when, snapshot, promise, release, resolveOpened })
    this.gates.set(normalized, gates)
    // Restart read counting for this path so `when` is relative to the gate,
    // independent of how many times setup read the file.
    this.readCounts.delete(normalized)
    return { opened, release }
  }

  override async read(path: string): Promise<string> {
    const normalized = normalizePath(path)
    const count = (this.readCounts.get(normalized) ?? 0) + 1
    this.readCounts.set(normalized, count)
    const gate = this.gates.get(normalized)?.find((g) => g.when === count)
    if (gate) {
      gate.resolveOpened()
      await gate.promise
      if (gate.snapshot !== undefined) return gate.snapshot
    }
    return super.read(normalized)
  }
}

const defaultSettings = {} as unknown as YoloSettingsLike

const createStore = (
  adapter = new FakeAdapter(),
  overrides: Partial<ProjectStoreOptions> = {},
) =>
  new ProjectStore({ getSettings: () => defaultSettings, adapter, ...overrides })

describe('ProjectStore.initProject', () => {
  it('creates project.md and task files', async () => {
    const adapter = new FakeAdapter()
    const store = createStore(adapter)

    const result = await store.initProject({
      projectId: 'proj-1',
      projectName: 'Proj One',
      tasks: [
        { taskId: 'T-001', title: 'First', dependencies: [] },
        { taskId: 'T-002', title: 'Second', dependencies: ['T-001'] },
      ],
    })

    expect(result.ok).toBe(true)
    expect(await adapter.exists('Projects/proj-1/project.md')).toBe(true)
    expect(await adapter.exists('Projects/proj-1/tasks/T-001.md')).toBe(true)
    expect(await adapter.exists('Projects/proj-1/tasks/T-002.md')).toBe(true)

    const taskFile = await adapter.read('Projects/proj-1/tasks/T-001.md')
    const split = extractFrontmatter(taskFile)
    expect(parseTaskRecord(split!.frontmatter!)).toMatchObject({
      projectId: 'proj-1',
      taskId: 'T-001',
      revision: 1,
      status: 'pending',
      dependencies: [],
    })
  })

  it('fails when the project already exists', async () => {
    const adapter = new FakeAdapter()
    const store = createStore(adapter)
    await store.initProject({ projectId: 'proj-1', projectName: 'A', tasks: [] })

    const result = await store.initProject({ projectId: 'proj-1', projectName: 'B', tasks: [] })
    expect(result).toMatchObject({ ok: false, kind: 'exists' })
  })

  it('rejects dependency cycles deterministically', async () => {
    const store = createStore()
    const result = await store.initProject({
      projectId: 'proj-cyc',
      projectName: 'Cycle',
      tasks: [
        { taskId: 'T-001', title: 'A', dependencies: ['T-002'] },
        { taskId: 'T-002', title: 'B', dependencies: ['T-001'] },
        { taskId: 'T-003', title: 'C', dependencies: ['T-003'] },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('invalid')
      expect(result.errors).toBeDefined()
      expect(result.errors!.join('\n')).toContain('cycle')
      expect(result.errors!.join('\n')).toContain('depend on itself')
    }
  })
})

describe('ProjectStore.updateTask', () => {
  it('bumps revision and updates timestamps on a fresh write', async () => {
    const adapter = new FakeAdapter()
    const store = createStore(adapter)
    await store.initProject({
      projectId: 'proj-1',
      projectName: 'A',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })

    const before = (await store.readTask('proj-1', 'T-001'))!
    const result = await store.updateTask(
      'proj-1',
      'T-001',
      { expectedRevision: before.revision, expectedContentHash: before.contentHash },
      (current) => ({ ...current, status: 'in_progress' }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.noop).toBe(false)
      expect(result.revision).toBe(before.revision + 1)
      expect(result.record.status).toBe('in_progress')
    }
  })

  it('rejects a stale write with a structured conflict', async () => {
    const adapter = new FakeAdapter()
    const store = createStore(adapter)
    await store.initProject({
      projectId: 'proj-1',
      projectName: 'A',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })

    const before = (await store.readTask('proj-1', 'T-001'))!
    // A concurrent writer advances the task first.
    await store.updateTask(
      'proj-1',
      'T-001',
      { expectedRevision: before.revision, expectedContentHash: before.contentHash },
      (current) => ({ ...current, status: 'in_progress' }),
    )

    const stale = await store.updateTask(
      'proj-1',
      'T-001',
      { expectedRevision: before.revision, expectedContentHash: before.contentHash },
      (current) => ({ ...current, status: 'blocked' }),
    )

    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.kind).toBe('conflict')
      expect(stale.current).toBeDefined()
    }
  })

  it('skips the write as a no-op when the canonical content is unchanged', async () => {
    const adapter = new FakeAdapter()
    const store = createStore(adapter)
    await store.initProject({
      projectId: 'proj-1',
      projectName: 'A',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })

    const before = (await store.readTask('proj-1', 'T-001'))!
    const beforeContent = await adapter.read('Projects/proj-1/tasks/T-001.md')

    const result = await store.updateTask(
      'proj-1',
      'T-001',
      { expectedRevision: before.revision, expectedContentHash: before.contentHash },
      (current) => ({ ...current, status: 'pending' }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.noop).toBe(true)
      expect(result.revision).toBe(before.revision)
    }
    expect(await adapter.read('Projects/proj-1/tasks/T-001.md')).toBe(beforeContent)
  })

  it('rejects an invalid status transition', async () => {
    const adapter = new FakeAdapter()
    const store = createStore(adapter)
    await store.initProject({
      projectId: 'proj-1',
      projectName: 'A',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })

    const before = (await store.readTask('proj-1', 'T-001'))!
    await expect(
      store.updateTask(
        'proj-1',
        'T-001',
        { expectedRevision: before.revision, expectedContentHash: before.contentHash },
        (current) => ({ ...current, status: 'completed' }),
      ),
    ).rejects.toThrow(/Invalid task transition/)
  })
})

describe('ProjectStore.listTasks + status', () => {
  it('lists tasks deterministically and reports invalid files', async () => {
    const adapter = new FakeAdapter()
    const store = createStore(adapter)
    await store.initProject({
      projectId: 'proj-1',
      projectName: 'A',
      tasks: [
        { taskId: 'T-002', title: 'Second' },
        { taskId: 'T-001', title: 'First' },
      ],
    })
    await adapter.write('Projects/proj-1/tasks/broken.md', 'no frontmatter here')

    const { tasks, invalid } = await store.listTasks('proj-1')
    expect(tasks.map((entry) => entry.task.taskId)).toEqual(['T-001', 'T-002'])
    expect(invalid.map((entry) => entry.path)).toContain(
      'Projects/proj-1/tasks/broken.md',
    )
  })

  it('computes counts, active tasks, pending reviews, and dependency blocks', async () => {
    const adapter = new FakeAdapter()
    const store = createStore(adapter)
    await store.initProject({
      projectId: 'proj-1',
      projectName: 'A',
      tasks: [
        { taskId: 'T-001', title: 'First' },
        { taskId: 'T-002', title: 'Second', dependencies: ['T-001'] },
        { taskId: 'T-003', title: 'Third' },
      ],
    })

    // Set statuses directly (test state setup, not transition validation):
    // T-001 pending (incomplete dependency), T-002 in_progress but blocked by
    // the incomplete T-001, T-003 awaiting_review.
    await setTaskStatus(adapter, store, 'T-001', 'pending')
    await setTaskStatus(adapter, store, 'T-002', 'in_progress')
    await setTaskStatus(adapter, store, 'T-003', 'awaiting_review')

    const status = await store.status('proj-1')
    expect(status).not.toBeNull()
    expect(status!.counts).toMatchObject({
      pending: 1,
      in_progress: 1,
      awaiting_review: 1,
      completed: 0,
    })
    expect(status!.pendingReviews).toEqual(['T-003'])
    expect(status!.active.map((entry) => entry.taskId).sort()).toEqual([
      'T-001',
      'T-002',
      'T-003',
    ])
    expect(status!.dependencyBlocks.map((entry) => entry.taskId)).toContain(
      'T-002',
    )
  })
})

const setTaskStatus = async (
  adapter: FakeAdapter,
  store: ProjectStore,
  taskId: string,
  status: 'pending' | 'in_progress' | 'awaiting_review',
): Promise<void> => {
  const read = (await store.readTask('proj-1', taskId))!
  const content = await adapter.read(read.path)
  const body = extractFrontmatter(content)!.body
  const next = { ...read.task, status }
  await adapter.write(read.path, buildTaskFileContent(next, body))
}

describe('claim and renew', () => {
  it('claim_task sets running + claim and appends a running attempt', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    const result = await store.claimTask('p1', 't1', preconditionOf(read), { runKey: 'run-1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.status).toBe('running')
    expect(result.record.claim?.runKey).toBe('run-1')
    expect(result.record.attempts[0].status).toBe('running')
  })

  it('rejects claim without precondition (stale read)', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const result = await store.claimTask('p1', 't1', { expectedRevision: 99, expectedContentHash: 'x' }, { runKey: 'run-1' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('conflict')
  })

  it('rejects a second claim with a different runKey on a running task as a conflict', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const first = await store.readTask('p1', 't1')
    const claimed = await store.claimTask('p1', 't1', preconditionOf(first), { runKey: 'run-1' })
    expect(claimed.ok).toBe(true)

    // A fresh precondition (re-read after the claim) with a different runKey
    // must not steal the live lease from run-1.
    const running = await store.readTask('p1', 't1')
    const conflict = await store.claimTask('p1', 't1', preconditionOf(running), { runKey: 'run-2' })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.kind).toBe('conflict')

    const after = await store.readTask('p1', 't1')
    expect(after?.task.status).toBe('running')
    expect(after?.task.claim?.runKey).toBe('run-1')
    expect(after?.task.attempts).toHaveLength(1)
  })

  it('renew with the same runKey extends expiresAt without a new attempt', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const first = await store.readTask('p1', 't1')
    const claimed = await store.claimTask('p1', 't1', preconditionOf(first), { runKey: 'run-1', durationMs: 60000 })
    if (!claimed.ok) throw new Error('claim failed')
    const renewRead = await store.readTask('p1', 't1')
    const renewed = await store.claimTask('p1', 't1', preconditionOf(renewRead), { runKey: 'run-1', durationMs: 60000 })
    expect(renewed.ok).toBe(true)
    if (!renewed.ok) return
    expect(renewed.record.attempts).toHaveLength(1)
    const renewedExpires = new Date(renewed.record.claim?.expiresAt ?? 0).getTime()
    const priorExpires = new Date(renewRead?.task.claim?.expiresAt ?? 0).getTime()
    expect(renewedExpires).toBeGreaterThan(priorExpires)
  })

  it('leaving running clears claim and terminalizes the open attempt', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const first = await store.readTask('p1', 't1')
    await store.claimTask('p1', 't1', preconditionOf(first), { runKey: 'run-1' })
    const claimed = await store.readTask('p1', 't1')
    const moved = await store.updateTask('p1', 't1', preconditionOf(claimed), (cur) => ({ ...cur, status: 'blocked', blockReason: { kind: 'needs_input' } }))
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.record.claim).toBeUndefined()
    expect(moved.record.attempts[0].status).toBe('blocked')
    expect(moved.record.blockRecurrences).toBe(1)
  })

  it('transition to blocked without block_reason is rejected', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    const result = await store.updateTask('p1', 't1', preconditionOf(read), (cur) => ({ ...cur, status: 'blocked' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/block_reason|blockReason/i)
  })

  it('blocks recurrence increments on re-entry and resets on completion', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.updateTask('p1', 't1', preconditionOf(read), (cur) => ({ ...cur, status: 'blocked', blockReason: { kind: 'dependency' } }))
    const blocked = await store.readTask('p1', 't1')
    await store.updateTask('p1', 't1', preconditionOf(blocked), (cur) => ({ ...cur, status: 'pending' }))
    const unblocked = await store.readTask('p1', 't1')
    await store.updateTask('p1', 't1', preconditionOf(unblocked), (cur) => ({ ...cur, status: 'blocked', blockReason: { kind: 'dependency' } }))
    const reBlocked = await store.readTask('p1', 't1')
    expect(reBlocked?.task.blockRecurrences).toBe(2)
    // `blocked -> completed` is not an allowed transition (only review-completion
    // paths are), so reach completed through the valid route to exercise the
    // blockRecurrences reset on completion.
    await store.updateTask('p1', 't1', preconditionOf(reBlocked), (cur) => ({ ...cur, status: 'in_progress' }))
    const inProgress = await store.readTask('p1', 't1')
    await store.updateTask('p1', 't1', preconditionOf(inProgress), (cur) => ({ ...cur, status: 'awaiting_review' }))
    const awaiting = await store.readTask('p1', 't1')
    const completed = await store.updateTask('p1', 't1', preconditionOf(awaiting), (cur) => ({ ...cur, status: 'completed' }))
    expect(completed.ok && completed.record.blockRecurrences).toBe(0)
  })
})

describe('status signals and lazy reclaim', () => {
  it('reports concurrent_running, all_terminal, and open_task_count', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.claimTask('p1', 't1', preconditionOf(read), { runKey: 'run-1' })
    const status = await store.status('p1')
    expect(status?.concurrentRunning).toEqual(['t1'])
    expect(status?.allTerminal).toBe(false)
    expect(status?.openTaskCount).toBe(1)
  })

  it('reclaims an expired claim when the run is not active', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    const claimed = await store.claimTask('p1', 't1', preconditionOf(read), { runKey: 'run-1', durationMs: -1000 })
    expect(claimed.ok).toBe(true)
    const status = await store.status('p1') // isRunActive absent -> reclaim
    expect(status?.reclaimed).toEqual([{ taskId: 't1', reason: 'claim_expired' }])
    const after = await store.readTask('p1', 't1')
    expect(after?.task.status).toBe('pending')
    expect(after?.task.claim).toBeUndefined()
    expect(after?.task.attempts[0].status).toBe('timed_out')
  })

  it('leaves an expired claim alone when the run is still active', async () => {
    const store = createStore(undefined, { isRunActive: (runKey) => runKey === 'run-1' })
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.claimTask('p1', 't1', preconditionOf(read), { runKey: 'run-1', durationMs: -1000 })
    const status = await store.status('p1')
    expect(status?.reclaimed).toEqual([])
    const after = await store.readTask('p1', 't1')
    expect(after?.task.status).toBe('running')
  })

  it('keeps an expired claim when the production liveness probe (real subagent registry) reports the run alive', async () => {
    // Production wiring: main.ts passes isRunActive: (runKey) =>
    // subagentTaskRegistry.get(runKey)?.status === 'running'. The claim
    // runKey is the real subagent taskId (backfilled at dispatch), so the
    // registry lookup is the identity match. A >30min long-running implementer
    // must NOT be reclaimed as a crash, or its delivery would be dropped.
    const runKey = `sub_probe_${Date.now()}`
    const record: SubagentTaskRecord = {
      taskId: runKey,
      conversationId: 'conv-probe',
      source: {
        type: 'llm_tool_call',
        toolCallId: 'tool-probe',
        assistantMessageId: 'msg-probe',
      },
      title: 'Probe',
      status: 'running',
      createdAt: Date.now(),
      prompt: 'do it',
      runKey,
      sessionId: runKey,
      runSequence: 1,
      abortController: new AbortController(),
    }
    subagentTaskRegistry.register(record)
    const store = createStore(undefined, {
      isRunActive: (k) => subagentTaskRegistry.get(k)?.status === 'running',
    })
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.claimTask('p1', 't1', preconditionOf(read), { runKey, durationMs: -1000 })
    const status = await store.status('p1')
    expect(status?.reclaimed).toEqual([])
    const after = await store.readTask('p1', 't1')
    expect(after?.task.status).toBe('running')
    expect(after?.task.claim?.runKey).toBe(runKey)
  })

  it('skips reclaim when the task leaves running before the write (in-lock re-read)', async () => {
    const adapter = new GatedAdapter()
    const store = createStore(adapter)
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.claimTask('p1', 't1', preconditionOf(read), { runKey: 'run-1', durationMs: -1000 })

    const taskPath = 'Projects/p1/tasks/t1.md'
    // Let `status()`'s listTasks snapshot see the stale running+expired record
    // while the on-disk file is advanced by a concurrent ingest before the
    // reclaim write lands (the read that hit the window that previously let
    // reclaim overwrite a concurrent update).
    const snapshot = await adapter.read(taskPath)
    // gateRead restarts read counting, so `status()`'s listTasks read of the
    // task file is the first read after the gate.
    const gate = adapter.gateRead(taskPath, 1, snapshot)

    const statusPromise = store.status('p1')
    await gate.opened // status() is paused mid-listTasks on the task read

    // Concurrent ingest: the running+expired task advances to in_progress
    // between status()'s snapshot and the reclaim write.
    const running = (await store.readTask('p1', 't1'))!
    const moved = await store.updateTask(
      'p1',
      't1',
      preconditionOf(running),
      (current) => ({ ...current, status: 'in_progress' }),
    )
    expect(moved.ok).toBe(true)

    gate.release()
    const status = await statusPromise

    // The inside-the-lock re-read observes the task is no longer `running`, so
    // reclaim is skipped and the concurrent ingest is not clobbered.
    expect(status?.reclaimed).toEqual([])
    const after = await store.readTask('p1', 't1')
    expect(after?.task.status).toBe('in_progress')
    expect(after?.task.revision).toBe(running.revision + 1)
  })

  it('flags recurring blocks past the limit', async () => {
    const store = createStore()
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.updateTask('p1', 't1', preconditionOf(read), (cur) => ({ ...cur, status: 'blocked', blockReason: { kind: 'dependency' }, blockRecurrences: 3 }))
    const status = await store.status('p1')
    expect(status?.recurringBlocks.map((t) => t.taskId)).toEqual(['t1'])
  })
})
