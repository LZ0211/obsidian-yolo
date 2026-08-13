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
    // ⚠️ 首 run prompt 落盘（Task 7）：reload 后续跑可重建首 run
    expect(snapshot?.recentRuns[0]?.prompt).toBe('p')
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

  it('rejects recover on a settled session and keeps the run terminal', async () => {
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
    // IDLE + COMPLETED 会话：recover 应被状态前置守卫拒绝，终态 run 不被改写
    // （settleRun 后 revision 为 2，需匹配以越过 revision 校验、命中守卫）
    const rejected = await service.recover({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 2,
      action: 'mark_interrupted_run_aborted',
      requestId: 'r3',
    })
    expect(rejected.accepted).toBe(false)
    if (rejected.accepted) throw new Error('expected rejection')
    expect(rejected.errorCode).toBe('session_not_sendable')
    expect(rejected.retryable).toBe(false)
    const after = await service.query(spawned.sessionId)
    expect(after?.session.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    expect(after?.recentRuns[0]?.status).toBe(SUBAGENT_RUN_STATUS.COMPLETED)
    expect(after?.recentRuns[0]?.result?.content).toBe('ok')
  })

  it('recovers an interrupted run to aborted and returns the session to idle', async () => {
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
    // 模拟崩溃遗留：session 置 RUNNING → 恢复扫描把 run 置 INTERRUPTED、
    // session 置 NEEDS_RESUME（revision+1 → 2），随后显式 recover 应成功
    const stored = await store.readById(spawned.sessionId)
    if (!stored) throw new Error('missing row')
    await store.compareAndUpdate(stored, {
      ...stored,
      session: { ...stored.session, status: SUBAGENT_SESSION_STATUS.RUNNING },
    })
    await service.recoverInterruptedSessions()
    const recovered = await service.recover({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 2,
      action: 'mark_interrupted_run_aborted',
      requestId: 'r2',
    })
    expect(recovered.accepted).toBe(true)
    if (!recovered.accepted) throw new Error('expected acceptance')
    expect(recovered.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    const snapshot = await service.query(spawned.sessionId)
    expect(snapshot?.session.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    expect(snapshot?.recentRuns[0]?.status).toBe(SUBAGENT_RUN_STATUS.ABORTED)
  })

  it('begins a new run with the next sequence and advances nextRunSequence', async () => {
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

    // spawn 已创建 run 1 且 nextRunSequence=2：IDLE 续跑的 beginRun 拿到的
    // runKey 与 run 1 不重叠（审查 #2a——否则 settleRun 按 runKey findIndex
    // 会命中 run 1 记录，续跑结算覆写 run 1 历史）
    const first = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 1,
      prompt: 'p2',
    })
    expect(first).toEqual({
      accepted: true,
      runKey: `${spawned.sessionId}:2`,
      runSequence: 2,
      sessionRevision: 2,
      // 无 PENDING 意图 → 兜底 prompt 原样返回、deliveredIntent=false
      prompt: 'p2',
      deliveredIntent: false,
    })
    const afterFirst = await service.query(spawned.sessionId)
    expect(afterFirst?.session.status).toBe(SUBAGENT_SESSION_STATUS.RUNNING)
    expect(afterFirst?.session.currentRunSequence).toBe(2)
    expect(afterFirst?.session.nextRunSequence).toBe(3)
    expect(afterFirst?.recentRuns.map((run) => run.runKey)).toEqual([
      `${spawned.sessionId}:1`,
      `${spawned.sessionId}:2`,
    ])
    expect(afterFirst?.recentRuns[1]?.prompt).toBe('p2')

    // 子 run 结算前不允许再 begin（RUNNING → session_not_sendable）
    const blocked = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 2,
      prompt: 'p3',
    })
    expect(blocked.accepted).toBe(false)
    if (blocked.accepted) throw new Error('expected rejection')
    expect(blocked.errorCode).toBe('session_not_sendable')

    // run 2 结算回 IDLE 后，第二次 beginRun 用推进后的 nextRunSequence
    await service.settleRun({
      sessionId: spawned.sessionId,
      runKey: `${spawned.sessionId}:2`,
      status: 'completed',
      result: {
        status: 'completed',
        content: 'ok',
        durationMs: 1,
        toolUseCount: 0,
      },
      completedAt: 2000,
    })
    const second = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 3,
      prompt: 'p3',
    })
    expect(second).toEqual({
      accepted: true,
      runKey: `${spawned.sessionId}:3`,
      runSequence: 3,
      sessionRevision: 4,
      prompt: 'p3',
      deliveredIntent: false,
    })
    const afterSecond = await service.query(spawned.sessionId)
    expect(afterSecond?.session.nextRunSequence).toBe(4)
    expect(afterSecond?.recentRuns).toHaveLength(3)
    expect(afterSecond?.recentRuns.map((run) => run.runKey)).toEqual([
      `${spawned.sessionId}:1`,
      `${spawned.sessionId}:2`,
      `${spawned.sessionId}:3`,
    ])
  })

  it('rejects beginRun for a stale revision or an unknown session', async () => {
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

    const stale = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 99,
      prompt: 'p2',
    })
    expect(stale.accepted).toBe(false)
    if (stale.accepted) throw new Error('expected rejection')
    expect(stale.errorCode).toBe('revision_conflict')
    expect(stale.retryable).toBe(true)

    const missing = await service.beginRun({
      sessionId: 'sub_missing',
      expectedSessionRevision: 1,
      prompt: 'p',
    })
    expect(missing.accepted).toBe(false)
    if (missing.accepted) throw new Error('expected rejection')
    expect(missing.errorCode).toBe('session_not_found')
  })

  it('delivers pending after_run intents by requesting a new run (Task 9)', async () => {
    const requested: Array<{ sessionId: string }> = []
    const service = await makeService(mockApp(), {
      onIntentRunRequested: (sessionId) => requested.push({ sessionId }),
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
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      text: 'again',
      delivery: 'after_run',
      expectedSessionRevision: spawned.sessionRevision,
      requestId: 'r2',
    })
    // run 1 settle → session 回 IDLE + PENDING after_run 意图 → 触发续跑
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
    expect(requested).toContainEqual({ sessionId: spawned.sessionId })
  })

  describe('deliverQueuedIntents (Task 10 UI 续跑接线)', () => {
    const spawnSession = async (
      store: SubagentSessionStore,
      service: SubagentSessionService,
    ) => {
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
      return spawned
    }

    it('requests a run for a pending after_run intent when idle and inactive', async () => {
      const app = mockApp()
      const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
      const requested: string[] = []
      const service = new SubagentSessionService(store, {
        isSessionActive: () => false,
        onIntentRunRequested: (sessionId) => requested.push(sessionId),
      })
      const spawned = await spawnSession(store, service)
      const sent = await service.send({
        sessionId: spawned.sessionId,
        messageId: 'm1',
        text: 'again',
        delivery: 'after_run',
        expectedSessionRevision: spawned.sessionRevision,
        requestId: 'r2',
      })
      if (!sent.accepted) throw new Error('send failed')

      await service.deliverQueuedIntents(spawned.sessionId)

      expect(requested).toEqual([spawned.sessionId])
      // 不改写 intent 状态——claim 由续跑路径的 beginRun 原子执行（预先置
      // CLAIMED 会让 beginRun 找不到 PENDING、新 run prompt 丢失）。
      const stored = await store.readById(spawned.sessionId)
      expect(stored?.intents[0]).toMatchObject({ state: 'pending' })
    })

    it('does not request a run while the session is running', async () => {
      const app = mockApp()
      const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
      const requested: string[] = []
      const service = new SubagentSessionService(store, {
        isSessionActive: () => false,
        onIntentRunRequested: (sessionId) => requested.push(sessionId),
      })
      const spawned = await spawnSession(store, service)
      const begin = await service.beginRun({
        sessionId: spawned.sessionId,
        expectedSessionRevision: spawned.sessionRevision,
        prompt: 'p2',
      })
      if (!begin.accepted) throw new Error('beginRun failed')
      const sent = await service.send({
        sessionId: spawned.sessionId,
        messageId: 'm1',
        text: 'again',
        delivery: 'after_run',
        expectedSessionRevision: begin.sessionRevision,
        requestId: 'r2',
      })
      if (!sent.accepted) throw new Error('send failed')

      await service.deliverQueuedIntents(spawned.sessionId)

      expect(requested).toEqual([])
    })

    it('does not request a run when only next_boundary intents are pending', async () => {
      const app = mockApp()
      const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
      const requested: string[] = []
      const service = new SubagentSessionService(store, {
        isSessionActive: () => false,
        onIntentRunRequested: (sessionId) => requested.push(sessionId),
      })
      const spawned = await spawnSession(store, service)
      const sent = await service.send({
        sessionId: spawned.sessionId,
        messageId: 'm1',
        text: 'steer',
        delivery: 'next_boundary',
        expectedSessionRevision: spawned.sessionRevision,
        requestId: 'r2',
      })
      if (!sent.accepted) throw new Error('send failed')

      await service.deliverQueuedIntents(spawned.sessionId)

      expect(requested).toEqual([])
    })

    it('does not request a run while an active runtime is registered', async () => {
      const app = mockApp()
      const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
      const requested: string[] = []
      const service = new SubagentSessionService(store, {
        isSessionActive: () => true,
        onIntentRunRequested: (sessionId) => requested.push(sessionId),
      })
      const spawned = await spawnSession(store, service)
      const sent = await service.send({
        sessionId: spawned.sessionId,
        messageId: 'm1',
        text: 'again',
        delivery: 'after_run',
        expectedSessionRevision: spawned.sessionRevision,
        requestId: 'r2',
      })
      if (!sent.accepted) throw new Error('send failed')

      await service.deliverQueuedIntents(spawned.sessionId)

      expect(requested).toEqual([])
    })

    it('resolves silently when onIntentRunRequested is not registered', async () => {
      const app = mockApp()
      const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
      const service = new SubagentSessionService(store, {
        isSessionActive: () => false,
      })
      const spawned = await spawnSession(store, service)
      const sent = await service.send({
        sessionId: spawned.sessionId,
        messageId: 'm1',
        text: 'again',
        delivery: 'after_run',
        expectedSessionRevision: spawned.sessionRevision,
        requestId: 'r2',
      })
      if (!sent.accepted) throw new Error('send failed')

      await expect(
        service.deliverQueuedIntents(spawned.sessionId),
      ).resolves.toBeUndefined()
    })
  })

  it('begins a run claiming the first pending after_run intent as its prompt (Task 9)', async () => {
    const app = mockApp()
    const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
    const service = new SubagentSessionService(store)
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
      text: 'intent-1',
      delivery: 'after_run',
      expectedSessionRevision: 1,
      requestId: 'r2',
    })
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm3',
      text: 'intent-2',
      delivery: 'after_run',
      expectedSessionRevision: 2,
      requestId: 'r3',
    })
    const begin = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 3,
      prompt: 'fallback',
    })
    expect(begin.accepted).toBe(true)
    if (!begin.accepted) throw new Error('expected acceptance')
    // FIFO：首个 PENDING after_run 意图被原子 claim，文本即新 run prompt
    expect(begin.prompt).toBe('intent-1')
    expect(begin.deliveredIntent).toBe(true)
    const snapshot = await service.query(spawned.sessionId)
    expect(snapshot?.recentRuns[1]?.prompt).toBe('intent-1')
    expect(snapshot?.recentRuns[1]?.runKey).toBe(`${spawned.sessionId}:2`)
    // 意图 1 → CLAIMED + claimedByRunKey；意图 2 保持 PENDING（下一次投递）
    const stored = await store.readById(spawned.sessionId)
    expect(stored?.intents).toHaveLength(2)
    expect(stored?.intents[0]).toMatchObject({
      state: 'claimed',
      claimedByRunKey: `${spawned.sessionId}:2`,
      text: 'intent-1',
    })
    expect(stored?.intents[1]).toMatchObject({
      state: 'pending',
      text: 'intent-2',
    })
  })

  it('settles a run committing its claimed intents without re-triggering delivery (Task 9)', async () => {
    const requested: Array<{ sessionId: string }> = []
    const app = mockApp()
    const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
    const service = new SubagentSessionService(store, {
      onIntentRunRequested: (sessionId) => requested.push({ sessionId }),
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
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      text: 'again',
      delivery: 'after_run',
      expectedSessionRevision: 1,
      requestId: 'r2',
    })
    const begin = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 2,
      prompt: 'fallback',
    })
    expect(begin.accepted).toBe(true)
    if (!begin.accepted) throw new Error('expected acceptance')
    // 结算 run 2：CLAIMED 意图 → COMMITTED，PENDING 已不存在 → 不再触发续跑
    //（否则同一意图会无限循环重新投递）
    await service.settleRun({
      sessionId: spawned.sessionId,
      runKey: begin.runKey,
      status: 'completed',
      result: {
        status: 'completed',
        content: 'ok',
        durationMs: 1,
        toolUseCount: 0,
      },
      completedAt: 3000,
    })
    const stored = await store.readById(spawned.sessionId)
    expect(stored?.intents[0]).toMatchObject({
      state: 'committed',
      committedRunKey: begin.runKey,
      text: 'again',
    })
    expect(requested).toEqual([])
  })

  it('recovery scan converts claimed intents of the interrupted run to recovery_required (Task 9)', async () => {
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
    // run 1 完成后投递 after_run 意图
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
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      text: 'again',
      delivery: 'after_run',
      expectedSessionRevision: 2,
      requestId: 'r2',
    })
    const begin = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 3,
      prompt: 'fallback',
    })
    expect(begin.accepted).toBe(true)
    if (!begin.accepted) throw new Error('expected acceptance')
    // 崩溃：session 留在 RUNNING（beginRun 已置）→ 扫描把 run 2 置 INTERRUPTED、
    // 其 claim 的意图置 RECOVERY_REQUIRED
    await service.recoverInterruptedSessions()
    const snapshot = await service.query(spawned.sessionId)
    expect(snapshot?.session.status).toBe(SUBAGENT_SESSION_STATUS.NEEDS_RESUME)
    expect(snapshot?.recentRuns[1]?.status).toBe(
      SUBAGENT_RUN_STATUS.INTERRUPTED,
    )
    const stored = await store.readById(spawned.sessionId)
    expect(stored?.intents[0]).toMatchObject({ state: 'recovery_required' })
  })

  it('recovery scan skips already-recovered sessions with all-terminal runs (Task 9)', async () => {
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
    const stored = await store.readById(spawned.sessionId)
    if (!stored) throw new Error('missing row')
    await store.compareAndUpdate(stored, {
      ...stored,
      session: { ...stored.session, status: SUBAGENT_SESSION_STATUS.RUNNING },
    })
    const first = await service.recoverInterruptedSessions()
    expect(first.recovered).toBe(1)
    const afterFirst = await service.query(spawned.sessionId)
    expect(afterFirst?.session.status).toBe(
      SUBAGENT_SESSION_STATUS.NEEDS_RESUME,
    )
    // 第二次扫描：run 已终态（INTERRUPTED）→ 跳过，revision 不再空涨
    const second = await service.recoverInterruptedSessions()
    expect(second.recovered).toBe(0)
    const afterSecond = await service.query(spawned.sessionId)
    expect(afterSecond?.session.revision).toBe(afterFirst?.session.revision)
  })

  it('queueRecovery only accepts recovery_required intents (Task 9)', async () => {
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
    // PENDING 意图不可 resend（非 recovery_required——投递路径中）
    const pending = await service.queueRecovery({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      expectedSessionRevision: 1,
      action: 'resend',
      requestId: 'r2',
    })
    expect(pending.accepted).toBe(false)
    if (pending.accepted) throw new Error('expected rejection')
    expect(pending.errorCode).toBe('queue_recovery_required')
    // 恢复扫描把 CLAIMED 意图翻成 RECOVERY_REQUIRED 后可 resend/drop
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      text: 'again',
      delivery: 'after_run',
      expectedSessionRevision: 1,
      requestId: 'r3',
    })
    const begin = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 2,
      prompt: 'fallback',
    })
    expect(begin.accepted).toBe(true)
    if (!begin.accepted) throw new Error('expected acceptance')
    await service.recoverInterruptedSessions()
    const resent = await service.queueRecovery({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      expectedSessionRevision: 4,
      action: 'resend',
      requestId: 'r4',
    })
    expect(resent.accepted).toBe(true)
    if (!resent.accepted) throw new Error('expected acceptance')
    expect(resent.state).toBe('pending')
    const stored = await store.readById(spawned.sessionId)
    expect(stored?.intents[0]).toMatchObject({ state: 'pending' })
    expect(stored?.intents[0]).not.toHaveProperty('claimedByRunKey')
    // 已 resend（PENDING）不可再 drop——需重新进入 RECOVERY_REQUIRED
    const dropPending = await service.queueRecovery({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      expectedSessionRevision: 5,
      action: 'drop',
      requestId: 'r5',
    })
    expect(dropPending.accepted).toBe(false)
    if (dropPending.accepted) throw new Error('expected rejection')
    expect(dropPending.errorCode).toBe('queue_recovery_required')
    // 完整 drop 链：recover(abort) → IDLE → 再 send → beginRun（FIFO 再 claim
    // m2——resend 保持原数组序）→ 再恢复 → drop m2
    const recovered = await service.recover({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 5,
      action: 'mark_interrupted_run_aborted',
      requestId: 'r6',
    })
    expect(recovered.accepted).toBe(true)
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm3',
      text: 'again-2',
      delivery: 'after_run',
      expectedSessionRevision: 6,
      requestId: 'r7',
    })
    const begin2 = await service.beginRun({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 7,
      prompt: 'fallback',
    })
    expect(begin2.accepted).toBe(true)
    if (!begin2.accepted) throw new Error('expected acceptance')
    // resend 保持原数组序：FIFO 先投递 m2（m3 仍在更后）
    expect(begin2.prompt).toBe('again')
    await service.recoverInterruptedSessions()
    const dropped = await service.queueRecovery({
      sessionId: spawned.sessionId,
      messageId: 'm2',
      expectedSessionRevision: 9,
      action: 'drop',
      requestId: 'r8',
    })
    expect(dropped.accepted).toBe(true)
    if (!dropped.accepted) throw new Error('expected acceptance')
    expect(dropped.state).toBe('dropped')
    // m3 未被 claim/恢复，保持 PENDING 可正常投递
    const finalRow = await store.readById(spawned.sessionId)
    expect(finalRow?.intents[1]).toMatchObject({
      state: 'pending',
      text: 'again-2',
    })
  })

  it('claims pending next_boundary intents into a drain payload (Task 9, F1)', async () => {
    const app = mockApp()
    const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
    const service = new SubagentSessionService(store)
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
      text: 'mid-run 1',
      delivery: 'next_boundary',
      expectedSessionRevision: 1,
      requestId: 'r2',
    })
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm3',
      text: 'mid-run 2',
      delivery: 'next_boundary',
      expectedSessionRevision: 2,
      requestId: 'r3',
    })
    const drain = await service.claimNextBoundaryIntents(spawned.sessionId, {
      runKey: `${spawned.sessionId}:2`,
      expectedSessionRevision: 3,
    })
    expect(drain?.messages.map((message) => message.promptContent)).toEqual([
      'mid-run 1',
      'mid-run 2',
    ])
    expect(drain?.sourceUserMessageId).toBe('m3')
    const stored = await store.readById(spawned.sessionId)
    expect(stored?.intents[0]).toMatchObject({
      state: 'claimed',
      claimedByRunKey: `${spawned.sessionId}:2`,
    })
    // 二次 claim（同 run）无 PENDING 可投 → null
    const again = await service.claimNextBoundaryIntents(spawned.sessionId, {
      runKey: `${spawned.sessionId}:2`,
      expectedSessionRevision: 4,
    })
    expect(again).toBeNull()
    // revision 落后（并发 send 已写）→ 尽力而为返回 null，不 claim
    await service.send({
      sessionId: spawned.sessionId,
      messageId: 'm4',
      text: 'mid-run 3',
      delivery: 'next_boundary',
      expectedSessionRevision: 4,
      requestId: 'r4',
    })
    const stale = await service.claimNextBoundaryIntents(spawned.sessionId, {
      runKey: `${spawned.sessionId}:2`,
      expectedSessionRevision: 4,
    })
    expect(stale).toBeNull()
  })

  it('markOrphaned marks an idle session orphaned (Task 9, R13 semantics)', async () => {
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
    const orphaned = await service.markOrphaned({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 1,
    })
    expect(orphaned.accepted).toBe(true)
    const snapshot = await service.query(spawned.sessionId)
    expect(snapshot?.session.status).toBe(SUBAGENT_SESSION_STATUS.ORPHANED)
    // 已孤儿会话幂等拒绝（不可再 close/recover）
    const close = await service.close({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 2,
      requestId: 'r2',
    })
    expect(close.accepted).toBe(false)
    if (close.accepted) throw new Error('expected rejection')
    expect(close.errorCode).toBe('session_not_sendable')
  })

  it('markOrphaned rejects a stale revision (Task 9)', async () => {
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
    const rejected = await service.markOrphaned({
      sessionId: spawned.sessionId,
      expectedSessionRevision: 99,
    })
    expect(rejected.accepted).toBe(false)
    if (rejected.accepted) throw new Error('expected rejection')
    expect(rejected.errorCode).toBe('revision_conflict')
  })
})
