import { createWorkflowRunStore } from './workflow-run-store'
import type { WorkflowRunStorage } from './workflow-run-types'

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

class MemoryStorage implements WorkflowRunStorage {
  readonly blobs = new Map<string, string>()

  async list(directoryPrefix = ''): Promise<readonly string[]> {
    const prefix = directoryPrefix ? `${directoryPrefix}/` : ''
    return Object.freeze(
      [...this.blobs.keys()].filter((key) => key.startsWith(prefix)).sort(),
    )
  }

  async readText(key: string): Promise<string | null> {
    return this.blobs.get(key) ?? null
  }

  async writeText(key: string, value: string): Promise<void> {
    this.blobs.set(key, value)
  }

  async removeFile(key: string): Promise<boolean> {
    return this.blobs.delete(key)
  }
}

const snapshot = (
  overrides: Partial<Parameters<typeof makeSnapshot>[0]> = {},
) => makeSnapshot(overrides)

const makeSnapshot = (overrides: {
  runId?: string
  workflowPath?: string
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
}) => ({
  schemaVersion: 1 as const,
  runId: overrides.runId ?? 'run-1',
  workflowPath: overrides.workflowPath ?? 'demo/WORKFLOW.md',
  definition: {
    workflowPath: 'demo/WORKFLOW.md',
    workflowContextMarkdown: '# Context',
    topology: {
      revision: 1 as const,
      nodes: [],
      edges: [],
    },
    stepContents: {},
    modelByNodeId: {},
    policy: {
      capability: 'vault-write' as const,
      mapConcurrency: 3 as const,
      mergeStrategy: 'concat' as const,
    },
    definitionHash: 'a'.repeat(64),
  },
  input: { question: 'hi' },
  status: overrides.status ?? 'running',
  nodes: {},
  outputs: {},
  startedAt: 1,
})

describe('workflow run store', () => {
  it('writes and reads one latest record per Workflow path', async () => {
    const store = createWorkflowRunStore(new MemoryStorage())
    await store.write(snapshot({ runId: 'run-1' }))
    await store.write(snapshot({ runId: 'run-2' }))

    const latest = await store.read('demo/WORKFLOW.md')
    expect(latest?.runId).toBe('run-2')

    await store.write(
      snapshot({ runId: 'other-1', workflowPath: 'other/WORKFLOW.md' }),
    )
    const other = await store.read('other/WORKFLOW.md')
    expect(other?.runId).toBe('other-1')
    expect((await store.read('demo/WORKFLOW.md'))?.runId).toBe('run-2')
  })

  it('returns null for missing records and removed records', async () => {
    const store = createWorkflowRunStore(new MemoryStorage())
    expect(await store.read('demo/WORKFLOW.md')).toBeNull()

    await store.write(snapshot())
    expect(await store.remove('demo/WORKFLOW.md')).toBe(true)
    expect(await store.read('demo/WORKFLOW.md')).toBeNull()
    expect(await store.remove('demo/WORKFLOW.md')).toBe(false)
  })

  it('lists every stored run sorted by key', async () => {
    const store = createWorkflowRunStore(new MemoryStorage())
    await store.write(snapshot({ runId: 'a', workflowPath: 'aaa/WORKFLOW.md' }))
    await store.write(snapshot({ runId: 'b', workflowPath: 'bbb/WORKFLOW.md' }))

    const listed = await store.list()
    expect(listed.map((run) => run.runId)).toEqual(['a', 'b'])
  })

  it('stores records under runs/<sha256(workflowPath)>.json keys', async () => {
    const storage = new MemoryStorage()
    const store = createWorkflowRunStore(storage)
    await store.write(snapshot())

    const key = `runs/${await sha256('demo/WORKFLOW.md')}.json`
    expect(storage.blobs.has(key)).toBe(true)
    expect(
      [...storage.blobs.keys()].every((entry) => entry.startsWith('runs/')),
    ).toBe(true)
  })

  it('surfaces malformed records as store errors instead of repairing them', async () => {
    const storage = new MemoryStorage()
    await storage.writeText(
      `runs/${await sha256('demo/WORKFLOW.md')}.json`,
      '{not json',
    )
    const store = createWorkflowRunStore(storage)

    await expect(store.read('demo/WORKFLOW.md')).rejects.toThrow(
      /malformed|unsupported/i,
    )
    await expect(store.list()).rejects.toThrow(/malformed|unsupported/i)
  })

  it('rejects unsupported schema versions', async () => {
    const storage = new MemoryStorage()
    await storage.writeText(
      `runs/${await sha256('demo/WORKFLOW.md')}.json`,
      JSON.stringify({ ...snapshot(), schemaVersion: 2 }),
    )
    const store = createWorkflowRunStore(storage)

    await expect(store.read('demo/WORKFLOW.md')).rejects.toThrow(/unsupported/i)
  })

  it('rejects structurally invalid records', async () => {
    const storage = new MemoryStorage()
    await storage.writeText(
      `runs/${await sha256('demo/WORKFLOW.md')}.json`,
      JSON.stringify({ schemaVersion: 1, runId: 42 }),
    )
    const store = createWorkflowRunStore(storage)

    await expect(store.read('demo/WORKFLOW.md')).rejects.toThrow(
      /malformed|unsupported/i,
    )
  })

  it('round trips a complete snapshot through JSON', async () => {
    const store = createWorkflowRunStore(new MemoryStorage())
    const run = snapshot({ status: 'failed' })
    await store.write(run)

    const read = await store.read('demo/WORKFLOW.md')
    expect(read).toEqual(run)
    expect(Object.isFrozen(read)).toBe(true)
  })
})
