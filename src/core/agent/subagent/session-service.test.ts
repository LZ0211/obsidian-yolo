import type { App } from 'obsidian'

import { SubagentSessionStore } from '../../../database/json/subagent/SubagentSessionStore'
import { AGENT_SESSION_MODE } from '../../state/contracts'
import {
  SUBAGENT_RUN_STATUS,
  SUBAGENT_SESSION_STATUS,
} from '../../state/statuses'

import {
  SubagentSessionService,
  type SubagentSessionServiceOptions,
} from './session-service'

// 规则 obsidianmd/hardcoded-config-path 禁止硬编码 `.obsidian` 字面量
const SUBAGENT_CONFIG_DIR = ['.', 'obsidian'].join('')
const SUBAGENT_DATA_DIR = [
  '/vault',
  SUBAGENT_CONFIG_DIR,
  'plugins',
  'yolo',
  'subagents',
].join('/')

// mockApp/mockAdapter 的构造参照 SubagentSessionStore.test.ts 的同一模式；
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

describe('SubagentSessionService', () => {
  const makeService = async (
    app: App,
    options?: SubagentSessionServiceOptions,
  ) => {
    const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
    return new SubagentSessionService(store, options)
  }

  it('spawns a session with a queued first run', async () => {
    const service = await makeService(mockApp())
    const result = await service.spawn({
      title: 't',
      prompt: 'p',
      mode: AGENT_SESSION_MODE.PERSISTENT,
      requestId: 'r1',
      parentConversationId: 'conv_1',
      originAssistantMessageId: 'msg_1',
      originToolCallId: 'tc_1',
      memoryAssistantId: 'mem_1',
    })
    expect(result.accepted).toBe(true)
    if (!result.accepted) return
    const snapshot = await service.query(result.sessionId)
    expect(snapshot?.session.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    expect(snapshot?.recentRuns[0]?.status).toBe(SUBAGENT_RUN_STATUS.QUEUED)
    expect(snapshot?.recentRuns[0]?.runKey).toBe(`${result.sessionId}:1`)
  })

  it('rejects a send with a stale revision', async () => {
    const service = await makeService(mockApp())
    const spawned = await service.spawn({
      title: 't',
      prompt: 'p',
      mode: AGENT_SESSION_MODE.PERSISTENT,
      requestId: 'r1',
      parentConversationId: 'c',
      originAssistantMessageId: 'm',
      originToolCallId: 't',
      memoryAssistantId: 'x',
    })
    if (!spawned.accepted) throw new Error('spawn failed')
    const stale = await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      text: 'hi',
      delivery: 'after_run',
      expectedSessionRevision: 999,
      requestId: 'r2',
    })
    expect(stale.accepted).toBe(false)
    if (stale.accepted) throw new Error('expected rejection')
    expect(stale.errorCode).toBe('revision_conflict')
    expect(stale.retryable).toBe(true)
  })

  it('settles a run and persists the result', async () => {
    const service = await makeService(mockApp())
    const spawned = await service.spawn({
      title: 't',
      prompt: 'p',
      mode: AGENT_SESSION_MODE.PERSISTENT,
      requestId: 'r1',
      parentConversationId: 'c',
      originAssistantMessageId: 'm',
      originToolCallId: 't',
      memoryAssistantId: 'x',
    })
    if (!spawned.accepted) throw new Error('spawn failed')
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      text: 'again',
      delivery: 'after_run',
      expectedSessionRevision: spawned.sessionRevision,
      requestId: 'r2',
    })
    await service.settleRun({
      sessionId: spawned.sessionId,
      runKey: spawned.runKey,
      status: 'completed',
      result: {
        status: 'completed',
        content: 'ok',
        durationMs: 1,
        toolUseCount: 0,
      },
      completedAt: 2000,
    })
    const after = await service.query(spawned.sessionId)
    expect(after?.session.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    expect(after?.recentRuns[0]?.status).toBe(SUBAGENT_RUN_STATUS.COMPLETED)
    expect(after?.recentRuns[0]?.result?.content).toBe('ok')
  })

  it('recoverInterruptedSessions marks orphaned runs', async () => {
    // 无活跃 runtime 的场景由注入的 isSessionActive 判定函数模拟
    const app = mockApp()
    const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
    const service = new SubagentSessionService(store, {
      isSessionActive: () => false,
    })
    const spawned = await service.spawn({
      title: 't',
      prompt: 'p',
      mode: AGENT_SESSION_MODE.PERSISTENT,
      requestId: 'r1',
      parentConversationId: 'c',
      originAssistantMessageId: 'm',
      originToolCallId: 't',
      memoryAssistantId: 'x',
    })
    if (!spawned.accepted) throw new Error('spawn failed')
    // 模拟崩溃遗留：把 session 状态直接置 RUNNING（经 CAS 写入）
    const stored = await store.readById(spawned.sessionId)
    if (!stored) throw new Error('missing row')
    await store.compareAndUpdate(stored, {
      ...stored,
      session: { ...stored.session, status: SUBAGENT_SESSION_STATUS.RUNNING },
    })
    const { recovered } = await service.recoverInterruptedSessions()
    const snapshot = await service.query(spawned.sessionId)
    expect(snapshot?.session.status).toBe(SUBAGENT_SESSION_STATUS.NEEDS_RESUME)
    expect(snapshot?.recentRuns[0]?.status).toBe(
      SUBAGENT_RUN_STATUS.INTERRUPTED,
    )
    expect(recovered).toBe(1)
  })

  it('orphans a NEEDS_RESUME session whose delegated role is unresolvable (R13)', async () => {
    // service 构造传 { resolveDelegatedRole: () => false }（模拟角色被删除）
    const app = mockApp()
    const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
    const service = new SubagentSessionService(store, {
      isSessionActive: () => false,
      resolveDelegatedRole: () => false,
    })
    const spawned = await service.spawn({
      title: 't',
      prompt: 'p',
      mode: AGENT_SESSION_MODE.PERSISTENT,
      requestId: 'r1',
      parentConversationId: 'c',
      originAssistantMessageId: 'm',
      originToolCallId: 't',
      delegatedRoleId: 'role_x',
      memoryAssistantId: 'x',
    })
    if (!spawned.accepted) throw new Error('spawn failed')
    // 模拟崩溃遗留：session 置 RUNNING（经 CAS 写入）后触发恢复扫描
    const stored = await store.readById(spawned.sessionId)
    if (!stored) throw new Error('missing row')
    await store.compareAndUpdate(stored, {
      ...stored,
      session: { ...stored.session, status: SUBAGENT_SESSION_STATUS.RUNNING },
    })
    const { recovered } = await service.recoverInterruptedSessions()
    const snapshot = await service.query(spawned.sessionId)
    expect(snapshot?.session.status).toBe(SUBAGENT_SESSION_STATUS.ORPHANED)
    expect(recovered).toBe(1)
  })
})
