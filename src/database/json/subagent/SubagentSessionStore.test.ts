import { App } from 'obsidian'
import {
  RevisionConflictError,
  SubagentSessionStore,
} from './SubagentSessionStore'
import { AGENT_SESSION_MODE } from '../../../core/state/contracts'
import { SUBAGENT_SESSION_STATUS } from '../../../core/state/statuses'

// mockApp/mockAdapter 的构造参照 src/database/json/chat/ChatManager.test.ts 现有模式；
// base 的 create 先 exists 检查再 write、read 也先 exists，因此 mock 的 exists
// 需按内存文件状态返回。
function mockApp(): App {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const adapter = {
    exists: jest.fn(async (p: string) => files.has(p) || dirs.has(p)),
    mkdir: jest.fn(async (p: string) => {
      dirs.add(p)
    }),
    read: jest.fn(async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p) as string
    }),
    write: jest.fn(async (p: string, content: string) => {
      files.set(p, content)
    }),
    remove: jest.fn(async (p: string) => {
      files.delete(p)
    }),
    list: jest.fn(async (dir: string) => {
      const fileList: string[] = []
      files.forEach((_value, key) => {
        if (key.startsWith(`${dir}/`)) fileList.push(key)
      })
      return { files: fileList, folders: [] }
    }),
  }
  return { vault: { adapter } } as unknown as App
}

function makeStore(app: App, dir: string): SubagentSessionStore {
  return new SubagentSessionStore(app, dir)
}

const makeSession = (sessionId: string, revision = 1) => ({
  schemaVersion: 1 as const,
  session: {
    sessionId,
    parentConversationId: 'conv_1',
    originAssistantMessageId: 'msg_1',
    originToolCallId: 'tc_1',
    title: 'title',
    mode: AGENT_SESSION_MODE.PERSISTENT,
    status: SUBAGENT_SESSION_STATUS.IDLE,
    revision,
    nextRunSequence: 1,
    memoryAssistantId: 'mem_1',
    createdAt: 1000,
    lastActiveAt: 1000,
  },
  runs: [],
  intents: [],
})

describe('SubagentSessionStore', () => {
  it('persists a session snapshot and reads it back', async () => {
    const app = mockApp()
    const store = makeStore(app, '/vault/.obsidian/plugins/yolo/subagents')
    const row = makeSession('sub_abc')
    await store.create(row)
    const restored = await store.read(`v1_sub_abc.json`)
    expect(restored?.session.sessionId).toBe('sub_abc')
    expect(restored?.schemaVersion).toBe(1)
  })

  it('lists metadata from file names only', async () => {
    const app = mockApp()
    const store = makeStore(app, '/vault/.obsidian/plugins/yolo/subagents')
    await store.create(makeSession('sub_abc'))
    const meta = await store.listMetadata()
    expect(meta.map((m) => m.sessionId)).toContain('sub_abc')
  })

  it('updates a session atomically', async () => {
    const app = mockApp()
    const store = makeStore(app, '/vault/.obsidian/plugins/yolo/subagents')
    const row = makeSession('sub_abc', 1)
    await store.create(row)
    const next = { ...row, session: { ...row.session, revision: 2 } }
    await store.update(row, next)
    const restored = await store.read('v1_sub_abc.json')
    expect(restored?.session.revision).toBe(2)
  })

  it('compareAndUpdate writes when the expected revision matches', async () => {
    const app = mockApp()
    const store = makeStore(app, '/vault/.obsidian/plugins/yolo/subagents')
    const row = makeSession('sub_abc', 1)
    await store.create(row)
    const next = { ...row, session: { ...row.session, revision: 2 } }
    await store.compareAndUpdate(row, next)
    const restored = await store.readById('sub_abc')
    expect(restored?.session.revision).toBe(2)
  })

  it('compareAndUpdate rejects with RevisionConflictError on revision mismatch', async () => {
    const app = mockApp()
    const store = makeStore(app, '/vault/.obsidian/plugins/yolo/subagents')
    const row = makeSession('sub_abc', 2)
    await store.create(row)
    const stale = makeSession('sub_abc', 1)
    const next = { ...row, session: { ...row.session, revision: 3 } }
    const conflict = store.compareAndUpdate(stale, next)
    await expect(conflict).rejects.toThrow(RevisionConflictError)
    await expect(conflict).rejects.toThrow('expected 1, found 2')
  })
})
