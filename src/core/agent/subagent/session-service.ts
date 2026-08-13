import type { App } from 'obsidian'
import { normalizePath } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { SUBAGENT_DIR } from '../../../database/json/constants'
import {
  RevisionConflictError,
  SubagentSessionStore,
} from '../../../database/json/subagent/SubagentSessionStore'
import type { StoredSubagentSession } from '../../../database/json/subagent/SubagentSessionStore'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { ChatMessage, ChatUserMessage } from '../../../types/chat'
import { ensureUserDataRootDir } from '../../paths/yoloManagedData'
import { getYoloUserDataRootDir } from '../../paths/yoloPaths'
import {
  SUBAGENT_MESSAGE_INTENT_STATE,
  SUBAGENT_RUN_STATUS,
  SUBAGENT_SESSION_STATUS,
} from '../../state/statuses'
import type {
  SubagentRunStatus,
  SubagentSessionStatus,
} from '../../state/statuses'
import type { AgentPendingUserMessageDrain } from '../types'

import {
  SUBAGENT_SESSION_SCHEMA_VERSION,
  type SubagentBeginRunInput,
  type SubagentBeginRunResult,
  type SubagentCloseInput,
  type SubagentCloseResult,
  type SubagentControlRejected,
  type SubagentMessageIntent,
  type SubagentQueryOptions,
  type SubagentQueueRecoveryInput,
  type SubagentQueueRecoveryResult,
  type SubagentRecoverInput,
  type SubagentRecoverResult,
  type SubagentResultSummary,
  type SubagentResumeAfterRecoveryResult,
  type SubagentRun,
  type SubagentSendInput,
  type SubagentSendResult,
  type SubagentSession,
  type SubagentSessionSnapshot,
  type SubagentSpawnInput,
  type SubagentSpawnResult,
  type TrustedSubagentCallerContext,
  makeSubagentRunKey,
} from './session-types'

export type SubagentSessionServiceOptions = {
  isSessionActive?: (sessionId: string) => boolean
  /** R13：委托画像解析失败判定（角色被删除/模型不可用），true 表示可解析 */
  resolveDelegatedRole?: (
    delegatedRoleId: string,
    modelPreferenceId?: string,
  ) => boolean
  /** Task 9 注册：after_run 意图 → 续跑入口（runner 的 runSubagentSessionContinuation） */
  onIntentRunRequested?: (sessionId: string) => void
}

/**
 * Subagent durable session 控制面（Task 5）。
 *
 * 所有写操作的模式一致：读 → revision 校验（快速失败）→ 变更 →
 * store.compareAndUpdate（CAS 兜底并发窗口）→ 捕获 RevisionConflictError
 * 返回 `revision_conflict` 冲突结果（recoverInterruptedSessions 为尽力而为的
 * 扫描，冲突时跳过该会话；settleRun 是终态写，冲突时收敛重试）。
 */
export class SubagentSessionService {
  private readonly isSessionActive: (sessionId: string) => boolean
  private readonly options: SubagentSessionServiceOptions

  constructor(
    private readonly store: SubagentSessionStore,
    options: SubagentSessionServiceOptions = {},
  ) {
    this.isSessionActive = options.isSessionActive ?? (() => true)
    this.options = options
  }

  async spawn(
    input: SubagentSpawnInput &
      TrustedSubagentCallerContext & { memoryAssistantId: string },
  ): Promise<SubagentSpawnResult> {
    const sessionId = `sub_${uuidv4().replace(/-/g, '').slice(0, 12)}`
    const session: SubagentSession = {
      sessionId,
      parentConversationId: input.parentConversationId,
      originAssistantMessageId: input.originAssistantMessageId,
      originToolCallId: input.originToolCallId,
      originBranchId: input.originBranchId,
      title: input.title,
      mode: input.mode,
      status: SUBAGENT_SESSION_STATUS.IDLE,
      revision: 1,
      // run 1 已随 spawn 创建，下一个 run 从 2 开始（Task 7 审查 #2a：否则
      // IDLE 续跑的 beginRun 会用 runSequence 1 与 run 1 的 runKey 重叠，
      // settleRun 按 runKey findIndex 会覆写 run 1 的结算）。
      nextRunSequence: 2,
      delegatedRoleId: input.delegatedRoleId,
      modelPreferenceId: input.modelPreferenceId,
      memoryAssistantId: input.memoryAssistantId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    const run: SubagentRun = {
      sessionId,
      runSequence: 1,
      runKey: makeSubagentRunKey(sessionId, 1),
      promptMessageId: `${makeSubagentRunKey(sessionId, 1)}:prompt`,
      // ⚠️ 首 run prompt 落盘（Task 5 审查前送，Task 7 落实）：prompt 文本随
      // run 记录持久化，reload 后 runSubagentSessionContinuation 可重建首 run。
      prompt: input.prompt,
      status: SUBAGENT_RUN_STATUS.QUEUED,
      basedOnSessionRevision: 1,
    }
    await this.store.create({
      schemaVersion: SUBAGENT_SESSION_SCHEMA_VERSION,
      session,
      runs: [run],
      intents: [],
    })
    return { accepted: true, sessionId, runKey: run.runKey, sessionRevision: 1 }
  }

  async send(input: SubagentSendInput): Promise<SubagentSendResult> {
    const stored = await this.store.readById(input.sessionId)
    if (!stored) {
      return {
        accepted: false,
        errorCode: 'session_not_found',
        retryable: false,
      }
    }
    if (stored.session.revision !== input.expectedSessionRevision) {
      return {
        accepted: false,
        errorCode: 'revision_conflict',
        retryable: true,
        current: this.toSnapshot(stored),
      }
    }
    if (
      stored.session.status !== SUBAGENT_SESSION_STATUS.IDLE &&
      stored.session.status !== SUBAGENT_SESSION_STATUS.RUNNING
    ) {
      return {
        accepted: false,
        errorCode: 'session_not_sendable',
        retryable: false,
      }
    }
    const intent: SubagentMessageIntent = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      text: input.text,
      delivery: input.delivery,
      state: SUBAGENT_MESSAGE_INTENT_STATE.PENDING,
      createdAt: Date.now(),
    }
    const next: StoredSubagentSession = {
      ...stored,
      intents: [...stored.intents, intent],
      session: {
        ...stored.session,
        revision: stored.session.revision + 1,
        lastActiveAt: Date.now(),
      },
    }
    try {
      await this.store.compareAndUpdate(stored, next) // CAS 兜底并发窗口（R2）
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return {
          accepted: false,
          errorCode: 'revision_conflict',
          retryable: true,
          current: this.toSnapshot(stored),
        }
      }
      throw error
    }
    return {
      accepted: true,
      queued: true,
      sessionRevision: next.session.revision,
    }
  }

  /**
   * close（设计 6.5）：
   * - idle：一次 CAS 直接 archive；
   * - running：置 closing，阻止新 send，active run settle 后转 archived；
   * - closing/archived：幂等接受，返回当前状态。
   */
  async close(input: SubagentCloseInput): Promise<SubagentCloseResult> {
    const stored = await this.store.readById(input.sessionId)
    if (!stored) {
      return {
        accepted: false,
        errorCode: 'session_not_found',
        retryable: false,
      }
    }
    if (stored.session.revision !== input.expectedSessionRevision) {
      return {
        accepted: false,
        errorCode: 'revision_conflict',
        retryable: true,
        current: this.toSnapshot(stored),
      }
    }
    const { status } = stored.session
    if (status === SUBAGENT_SESSION_STATUS.CLOSING) {
      return {
        accepted: true,
        status: SUBAGENT_SESSION_STATUS.CLOSING,
        sessionRevision: stored.session.revision,
      }
    }
    if (status === SUBAGENT_SESSION_STATUS.ARCHIVED) {
      return {
        accepted: true,
        status: SUBAGENT_SESSION_STATUS.ARCHIVED,
        sessionRevision: stored.session.revision,
      }
    }
    if (
      status === SUBAGENT_SESSION_STATUS.NEEDS_RESUME ||
      status === SUBAGENT_SESSION_STATUS.ORPHANED
    ) {
      // needs_resume 必须先执行显式 recover；orphaned 不允许继续
      return {
        accepted: false,
        errorCode: 'session_not_sendable',
        retryable: false,
      }
    }
    const nextStatus =
      status === SUBAGENT_SESSION_STATUS.IDLE
        ? SUBAGENT_SESSION_STATUS.ARCHIVED
        : SUBAGENT_SESSION_STATUS.CLOSING
    const next: StoredSubagentSession = {
      ...stored,
      session: {
        ...stored.session,
        status: nextStatus,
        revision: stored.session.revision + 1,
        ...(nextStatus === SUBAGENT_SESSION_STATUS.ARCHIVED
          ? { archivedAt: Date.now() }
          : {}),
      },
    }
    try {
      await this.store.compareAndUpdate(stored, next)
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return {
          accepted: false,
          errorCode: 'revision_conflict',
          retryable: true,
          current: this.toSnapshot(stored),
        }
      }
      throw error
    }
    return {
      accepted: true,
      status: nextStatus,
      sessionRevision: next.session.revision,
    }
  }

  /** recover：仅支持把当前 run 明确终结为 aborted，再把 session 转为 idle（设计 6.4）。 */
  async recover(input: SubagentRecoverInput): Promise<SubagentRecoverResult> {
    const stored = await this.store.readById(input.sessionId)
    if (!stored) {
      return {
        accepted: false,
        errorCode: 'session_not_found',
        retryable: false,
      }
    }
    if (stored.session.revision !== input.expectedSessionRevision) {
      return {
        accepted: false,
        errorCode: 'revision_conflict',
        retryable: true,
        current: this.toSnapshot(stored),
      }
    }
    const targetRun = this.locateRun(stored)
    // 状态前置守卫：mark_interrupted_run_aborted 只对 INTERRUPTED run 有效；
    // 对已终态 run（如 IDLE+COMPLETED 的误用调用方）无条件置 ABORTED 会把
    // 终态结果抹掉，与恢复扫描侧的终态保护（locateInterruptibleRun）保持一致。
    // 联合内无 'session_not_recoverable'，复用最贴近的“当前状态不允许该操作”。
    if (!targetRun || targetRun.status !== SUBAGENT_RUN_STATUS.INTERRUPTED) {
      return {
        accepted: false,
        errorCode: 'session_not_sendable',
        retryable: false,
      }
    }
    const next: StoredSubagentSession = {
      ...stored,
      runs: stored.runs.map((run) =>
        run.runKey === targetRun.runKey
          ? { ...run, status: SUBAGENT_RUN_STATUS.ABORTED }
          : run,
      ),
      session: {
        ...stored.session,
        status: SUBAGENT_SESSION_STATUS.IDLE,
        revision: stored.session.revision + 1,
      },
    }
    try {
      await this.store.compareAndUpdate(stored, next)
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return {
          accepted: false,
          errorCode: 'revision_conflict',
          retryable: true,
          current: this.toSnapshot(stored),
        }
      }
      throw error
    }
    return {
      accepted: true,
      status: SUBAGENT_SESSION_STATUS.IDLE,
      sessionRevision: next.session.revision,
    }
  }

  /**
   * resumeAfterRecovery（R14 UI 一键恢复）：recover 成功（中断 run 已 aborted、
   * session 回 IDLE）后由 UI 调用——把所有 RECOVERY_REQUIRED 意图一次置回
   * PENDING（同一次 CAS 写、revision 推进，recoverInterruptedSessions 的逆
   * 操作），随后 deliverQueuedIntents 把 PENDING after_run 意图投递成续跑
   * （onIntentRunRequested → runner）。此前 UI 只调 deliverQueuedIntents，而
   * 中断意图是 RECOVERY_REQUIRED 不是 PENDING，投递不命中 → 用户必须再手动
   * resend 才续跑（两步操作）；本方法收敛为一步。
   * 状态前置守卫：仅 IDLE 可一键恢复（recover 之后）；无 recovery_required
   * 意图时不做状态写、直接投递（既有 PENDING after_run 意图可能已存在）。
   */
  async resumeAfterRecovery(
    sessionId: string,
  ): Promise<SubagentResumeAfterRecoveryResult> {
    const stored = await this.store.readById(sessionId)
    if (!stored) {
      return {
        accepted: false,
        errorCode: 'session_not_found',
        retryable: false,
      }
    }
    if (stored.session.status !== SUBAGENT_SESSION_STATUS.IDLE) {
      return {
        accepted: false,
        errorCode: 'session_not_sendable',
        retryable: false,
        current: this.toSnapshot(stored),
      }
    }
    const recoveryIndexes: number[] = []
    stored.intents.forEach((intent, index) => {
      if (intent.state === SUBAGENT_MESSAGE_INTENT_STATE.RECOVERY_REQUIRED) {
        recoveryIndexes.push(index)
      }
    })
    if (recoveryIndexes.length === 0) {
      await this.deliverQueuedIntents(sessionId)
      return {
        accepted: true,
        recovered: 0,
        sessionRevision: stored.session.revision,
      }
    }
    const next: StoredSubagentSession = {
      ...stored,
      // RECOVERY_REQUIRED → PENDING 时清空 claim 归属（queueRecovery resend
      // 同款语义：意图重新待投递，beginRun 按 FIFO 原子 claim）。
      intents: stored.intents.map((intent, index) =>
        recoveryIndexes.includes(index)
          ? {
              ...intent,
              state: SUBAGENT_MESSAGE_INTENT_STATE.PENDING,
              claimedByRunKey: undefined,
            }
          : intent,
      ),
      session: {
        ...stored.session,
        revision: stored.session.revision + 1,
        lastActiveAt: Date.now(),
      },
    }
    try {
      await this.store.compareAndUpdate(stored, next)
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return {
          accepted: false,
          errorCode: 'revision_conflict',
          retryable: true,
          current: this.toSnapshot(stored),
        }
      }
      throw error
    }
    // 投递内部重新读 store，能看到刚置回 PENDING 的意图（deliverQueuedIntents
    // 只投递不改写状态——claim 由续跑路径的 beginRun 原子执行）。
    await this.deliverQueuedIntents(sessionId)
    return {
      accepted: true,
      recovered: recoveryIndexes.length,
      sessionRevision: next.session.revision,
    }
  }

  /**
   * queueRecovery：recovery_required 意图显式 resend（置 PENDING）/ drop（置
   * DROPPED）。Task 9（backup resolve_session_queue 守卫）：仅 RECOVERY_REQUIRED
   * 意图可恢复——PENDING/CLAIMED/COMMITTED 走此路径会把投递中的意图翻回
   * PENDING（重复投递）或把已提交意图抹成未投递，属数据损坏。联合内无
   * 'invalid_state'，复用最贴近的 queue_recovery_required（意图不可恢复）。
   */
  async queueRecovery(
    input: SubagentQueueRecoveryInput,
  ): Promise<SubagentQueueRecoveryResult> {
    const stored = await this.store.readById(input.sessionId)
    if (!stored) {
      return {
        accepted: false,
        errorCode: 'session_not_found',
        retryable: false,
      }
    }
    if (stored.session.revision !== input.expectedSessionRevision) {
      return {
        accepted: false,
        errorCode: 'revision_conflict',
        retryable: true,
        current: this.toSnapshot(stored),
      }
    }
    const intentIndex = stored.intents.findIndex(
      (intent) => intent.messageId === input.messageId,
    )
    if (intentIndex === -1) {
      // 目标意图不存在（已被处理/删除），无法完成队列恢复
      return {
        accepted: false,
        errorCode: 'queue_recovery_required',
        retryable: false,
      }
    }
    const intent = stored.intents[intentIndex]
    if (intent.state !== SUBAGENT_MESSAGE_INTENT_STATE.RECOVERY_REQUIRED) {
      return {
        accepted: false,
        errorCode: 'queue_recovery_required',
        retryable: false,
      }
    }
    const nextState =
      input.action === 'resend'
        ? SUBAGENT_MESSAGE_INTENT_STATE.PENDING
        : SUBAGENT_MESSAGE_INTENT_STATE.DROPPED
    const next: StoredSubagentSession = {
      ...stored,
      // backup session_message_requeued/dropped 均清空 claim 归属
      intents: stored.intents.map((candidate, index) =>
        index === intentIndex
          ? { ...candidate, state: nextState, claimedByRunKey: undefined }
          : candidate,
      ),
      session: {
        ...stored.session,
        revision: stored.session.revision + 1,
      },
    }
    try {
      await this.store.compareAndUpdate(stored, next)
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return {
          accepted: false,
          errorCode: 'revision_conflict',
          retryable: true,
          current: this.toSnapshot(stored),
        }
      }
      throw error
    }
    return {
      accepted: true,
      state: nextState,
      sessionRevision: next.session.revision,
    }
  }

  async query(
    sessionId: string,
    _options?: SubagentQueryOptions,
  ): Promise<SubagentSessionSnapshot | null> {
    const stored = await this.store.readById(sessionId)
    if (!stored) return null
    return this.toSnapshot(stored)
  }

  async listByParent(
    parentConversationId: string,
  ): Promise<SubagentSessionSnapshot[]> {
    const metas = await this.store.listMetadata()
    const snapshots: SubagentSessionSnapshot[] = []
    for (const meta of metas) {
      const stored = await this.store.readById(meta.sessionId)
      if (
        stored &&
        stored.session.parentConversationId === parentConversationId
      ) {
        snapshots.push(this.toSnapshot(stored))
      }
    }
    return snapshots
  }

  /** deleteByParent（R6 联动清理）：枚举 metadata → 匹配 parentConversationId → store.delete。 */
  async deleteByParent(parentConversationId: string): Promise<number> {
    const metas = await this.store.listMetadata()
    let deleted = 0
    for (const meta of metas) {
      const stored = await this.store.readById(meta.sessionId)
      if (
        stored &&
        stored.session.parentConversationId === parentConversationId
      ) {
        await this.store.delete(meta.fileName)
        deleted++
      }
    }
    return deleted
  }

  /**
   * beginRun：IDLE 会话续跑（after_run 意图投递，Task 7 审查 #2）前创建新 run
   * 记录并推进 nextRunSequence。runSequence = session.nextRunSequence（不与
   * 既有 run 重叠——否则 settleRun 按 runKey findIndex 会覆写旧 run 的结算）；
   * 成功后 session 置 RUNNING + currentRunSequence（子 run 中断时恢复扫描可
   * 正确标记 INTERRUPTED），nextRunSequence+1 持久化。
   * 与其余写路径一致：读 → revision 校验 → CAS（RevisionConflictError 按冲突
   * 结果返回，由调用方决定收敛重试）→ 结果。
   *
   * Task 9（意图投递）：同一次 CAS 原子 claim 首个 PENDING `after_run` 意图
   * （FIFO）——意图文本即新 run 的 prompt（Task 7 Minor #1：续跑时意图文本
   * 合入，而非旧 prompt 兜底）；无 PENDING 意图（手动续跑/重建）时用输入
   * prompt 兜底。claim 与 run 创建同原子，避免"意图已 claim 但 run 未建"的
   * 悬挂态；剩余 PENDING 意图留待下一次 settle 触发。
   */
  async beginRun(
    input: SubagentBeginRunInput,
  ): Promise<SubagentBeginRunResult> {
    const stored = await this.store.readById(input.sessionId)
    if (!stored) {
      return {
        accepted: false,
        errorCode: 'session_not_found',
        retryable: false,
      }
    }
    if (stored.session.revision !== input.expectedSessionRevision) {
      return {
        accepted: false,
        errorCode: 'revision_conflict',
        retryable: true,
        current: this.toSnapshot(stored),
      }
    }
    if (stored.session.status !== SUBAGENT_SESSION_STATUS.IDLE) {
      return {
        accepted: false,
        errorCode: 'session_not_sendable',
        retryable: false,
      }
    }
    const runSequence = stored.session.nextRunSequence
    const runKey = makeSubagentRunKey(stored.session.sessionId, runSequence)
    const pendingIndex = stored.intents.findIndex(
      (intent) =>
        intent.delivery === 'after_run' &&
        intent.state === SUBAGENT_MESSAGE_INTENT_STATE.PENDING,
    )
    const deliveredIntent =
      pendingIndex !== -1 ? stored.intents[pendingIndex] : undefined
    const effectivePrompt = deliveredIntent?.text ?? input.prompt
    const run: SubagentRun = {
      sessionId: stored.session.sessionId,
      runSequence,
      runKey,
      promptMessageId: `${runKey}:prompt`,
      prompt: effectivePrompt,
      status: SUBAGENT_RUN_STATUS.QUEUED,
      basedOnSessionRevision: stored.session.revision,
    }
    const next: StoredSubagentSession = {
      ...stored,
      runs: [...stored.runs, run],
      intents: deliveredIntent
        ? stored.intents.map((intent, index) =>
            index === pendingIndex
              ? {
                  ...intent,
                  state: SUBAGENT_MESSAGE_INTENT_STATE.CLAIMED,
                  claimedByRunKey: runKey,
                }
              : intent,
          )
        : stored.intents,
      session: {
        ...stored.session,
        status: SUBAGENT_SESSION_STATUS.RUNNING,
        currentRunSequence: runSequence,
        nextRunSequence: runSequence + 1,
        revision: stored.session.revision + 1,
        lastActiveAt: Date.now(),
      },
    }
    try {
      await this.store.compareAndUpdate(stored, next)
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return {
          accepted: false,
          errorCode: 'revision_conflict',
          retryable: true,
          current: this.toSnapshot(stored),
        }
      }
      throw error
    }
    return {
      accepted: true,
      runKey,
      runSequence,
      sessionRevision: next.session.revision,
      prompt: effectivePrompt,
      deliveredIntent: deliveredIntent !== undefined,
    }
  }

  /**
   * settleRun：终结 run、回写 result/transcript；终结后 session 回 IDLE
   * （设计 §4：persistent run 完成/失败/abort 后 run 保留终态、session 回 idle；
   * NEEDS_RESUME 仅由恢复扫描产生），有待投递 `after_run` 意图时调用
   * `onIntentRunRequested(sessionId)`（Task 9 注册，经 runner 续跑）。
   * settle 是终态写，与并发 send 竞争时按最新行收敛重试；耗尽重试后抛
   * RevisionConflictError。
   */
  async settleRun(input: {
    sessionId: string
    runKey: string
    status: SubagentResultSummary['status']
    result: SubagentResultSummary
    transcript?: ChatMessage[]
    completedAt: number
  }): Promise<void> {
    let lastConflict: RevisionConflictError | null = null
    for (let attempt = 0; attempt < SETTLE_MAX_ATTEMPTS; attempt++) {
      const stored = await this.store.readById(input.sessionId)
      if (!stored) return
      const runIndex = stored.runs.findIndex(
        (run) => run.runKey === input.runKey,
      )
      if (runIndex === -1) return
      const hasPendingAfterRun = stored.intents.some(
        (intent) =>
          intent.delivery === 'after_run' &&
          intent.state === SUBAGENT_MESSAGE_INTENT_STATE.PENDING,
      )
      const sessionStatus = this.resolveSettledSessionStatus(
        stored.session.status,
      )
      const next: StoredSubagentSession = {
        ...stored,
        runs: stored.runs.map((run, index) =>
          index === runIndex
            ? {
                ...run,
                status: input.status,
                result: input.result,
                completedAt: input.completedAt,
              }
            : run,
        ),
        // Task 9：结算时提交本 run claim 的意图（CLAIMED → COMMITTED）。意图
        // 文本已作为该 run 的 user 消息投递进 transcript，run 结果即投递结果；
        // 提交后 hasPendingAfterRun 不再命中 → 不会对本 run 重复触发续跑
        // （否则 PENDING 常驻会无限循环）。中断恢复路径由扫描把 CLAIMED →
        // RECOVERY_REQUIRED，不经此提交。
        intents: stored.intents.map((intent) =>
          intent.state === SUBAGENT_MESSAGE_INTENT_STATE.CLAIMED &&
          intent.claimedByRunKey === input.runKey
            ? {
                ...intent,
                state: SUBAGENT_MESSAGE_INTENT_STATE.COMMITTED,
                committedRunKey: input.runKey,
              }
            : intent,
        ),
        ...(input.transcript !== undefined
          ? { latestTranscript: input.transcript }
          : {}),
        session: {
          ...stored.session,
          status: sessionStatus,
          revision: stored.session.revision + 1,
        },
      }
      try {
        await this.store.compareAndUpdate(stored, next)
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error
        lastConflict = error
        continue
      }
      if (
        hasPendingAfterRun &&
        sessionStatus === SUBAGENT_SESSION_STATUS.IDLE
      ) {
        this.options.onIntentRunRequested?.(input.sessionId)
      }
      return
    }
    // 耗尽重试仍冲突：终态写持续与并发变更竞争，直接暴露（fail-fast）
    if (lastConflict) {
      throw lastConflict
    }
  }

  /**
   * deliverQueuedIntents（Task 10 UI 续跑接线）：恢复/resend 动作成功后由 UI
   * 触发——存在 PENDING `after_run` 意图（next_boundary 由 run 内边界 claim，
   * 不在此列）且 session ∈ {IDLE, NEEDS_RESUME} 且当前无活跃 run 时，调用
   * `onIntentRunRequested(sessionId)`（Task 9 注册，经 runner 续跑）。
   * 不改写 intent 状态：claim 由续跑路径的 beginRun 原子执行——预先置 CLAIMED
   * 会让 beginRun 找不到 PENDING、新 run prompt 丢失（settleRun 的投递同款：
   * 只投递不置状态）；回调未注册时静默返回。
   */
  async deliverQueuedIntents(sessionId: string): Promise<void> {
    const stored = await this.store.readById(sessionId)
    if (!stored) return
    if (
      stored.session.status !== SUBAGENT_SESSION_STATUS.IDLE &&
      stored.session.status !== SUBAGENT_SESSION_STATUS.NEEDS_RESUME
    ) {
      return
    }
    if (this.isSessionActive(sessionId)) return
    const hasPendingAfterRun = stored.intents.some(
      (intent) =>
        intent.delivery === 'after_run' &&
        intent.state === SUBAGENT_MESSAGE_INTENT_STATE.PENDING,
    )
    if (!hasPendingAfterRun) return
    this.options.onIntentRunRequested?.(sessionId)
  }

  /**
   * claimNextBoundaryIntents（Task 9，Task 6 review F1 follow-up）：run 开始时
   * 一次性 claim 全部 PENDING `next_boundary` 意图（FIFO），返回 runner 构造
   * `drainPendingUserMessages` 钩子的投递数据。store 读取是异步的，而
   * native-runtime 的 llm_request 边界钩子是同步的——无法在边界内 claim，
   * 因此 run 启动前 claim 到内存，首个边界消费。
   * 冲突（revision 落后，如并发 send）返回 null：意图保持 PENDING，由下一次
   * 触发重投。
   */
  async claimNextBoundaryIntents(
    sessionId: string,
    input: {
      runKey: string
      expectedSessionRevision: number
    },
  ): Promise<AgentPendingUserMessageDrain | null> {
    const stored = await this.store.readById(sessionId)
    if (!stored) return null
    if (stored.session.revision !== input.expectedSessionRevision) return null
    const pendingIndexes: number[] = []
    stored.intents.forEach((intent, index) => {
      if (
        intent.delivery === 'next_boundary' &&
        intent.state === SUBAGENT_MESSAGE_INTENT_STATE.PENDING
      ) {
        pendingIndexes.push(index)
      }
    })
    if (pendingIndexes.length === 0) return null
    const messages: ChatUserMessage[] = pendingIndexes.map((index) => {
      const intent = stored.intents[index]
      return {
        role: 'user',
        id: intent.messageId,
        content: null,
        promptContent: intent.text,
        mentionables: [],
      }
    })
    const source = messages.at(-1)
    if (!source) return null
    const next: StoredSubagentSession = {
      ...stored,
      intents: stored.intents.map((intent, index) =>
        pendingIndexes.includes(index)
          ? {
              ...intent,
              state: SUBAGENT_MESSAGE_INTENT_STATE.CLAIMED,
              claimedByRunKey: input.runKey,
            }
          : intent,
      ),
      session: {
        ...stored.session,
        revision: stored.session.revision + 1,
        lastActiveAt: Date.now(),
      },
    }
    try {
      await this.store.compareAndUpdate(stored, next)
    } catch (error) {
      if (error instanceof RevisionConflictError) return null
      throw error
    }
    return { messages, sourceUserMessageId: source.id }
  }

  /**
   * markOrphaned（Task 9，Task 3 Important 投递加载域重建）：origin 上下文
   * 校验失败（parent_orphaned——父会话缺失/origin 消息不存在/工具调用归属
   * 不符/branch 不匹配）时把会话置 ORPHANED（R13 同款语义：不可续跑、不可
   * close/recover，仅保留历史）。仅 IDLE/NEEDS_RESUME/RUNNING 可转；
   * 已归档/已孤儿/关闭中会话幂等拒绝。
   */
  async markOrphaned(input: {
    sessionId: string
    expectedSessionRevision: number
  }): Promise<
    { accepted: true; sessionRevision: number } | SubagentControlRejected
  > {
    const stored = await this.store.readById(input.sessionId)
    if (!stored) {
      return {
        accepted: false,
        errorCode: 'session_not_found',
        retryable: false,
      }
    }
    if (stored.session.revision !== input.expectedSessionRevision) {
      return {
        accepted: false,
        errorCode: 'revision_conflict',
        retryable: true,
        current: this.toSnapshot(stored),
      }
    }
    const { status } = stored.session
    if (
      status === SUBAGENT_SESSION_STATUS.ARCHIVED ||
      status === SUBAGENT_SESSION_STATUS.ORPHANED ||
      status === SUBAGENT_SESSION_STATUS.CLOSING
    ) {
      return {
        accepted: false,
        errorCode: 'session_not_sendable',
        retryable: false,
      }
    }
    const next: StoredSubagentSession = {
      ...stored,
      session: {
        ...stored.session,
        status: SUBAGENT_SESSION_STATUS.ORPHANED,
        revision: stored.session.revision + 1,
        lastActiveAt: Date.now(),
      },
    }
    try {
      await this.store.compareAndUpdate(stored, next)
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return {
          accepted: false,
          errorCode: 'revision_conflict',
          retryable: true,
          current: this.toSnapshot(stored),
        }
      }
      throw error
    }
    return {
      accepted: true,
      sessionRevision: next.session.revision,
    }
  }

  /**
   * recoverInterruptedSessions：扫描全部会话，status ∈ {RUNNING, NEEDS_RESUME}
   * 且无活跃 runtime 的 → 当前 run 置 INTERRUPTED（仅未终态 run），session 置
   * NEEDS_RESUME，revision+1；delegatedRoleId 存在但 resolveDelegatedRole 返回
   * false 的会话置 ORPHANED（R13）。扫描是尽力而为：CAS 冲突跳过该会话。
   *
   * Task 9（意图投递）：
   * - 被中断 run 已 claim 的意图（CLAIMED && claimedByRunKey = 中断 runKey）置
   *   RECOVERY_REQUIRED（backup run_interrupted 语义：崩溃时投递结果未知，
   *   必须显式 queueRecovery resend/drop）；PENDING 意图不受影响（未被 claim，
   *   恢复后可正常再投递）。
   * - NEEDS_RESUME + 全终态 run（前次扫描已置 INTERRUPTED）且角色可解析的会话
   *   跳过——恢复扫描的"出口"：不再空转 revision 与 recovered 计数（任务前送
   *   item 6）。R13 仍生效：角色不可解析的会话照常置 ORPHANED。
   */
  async recoverInterruptedSessions(): Promise<{ recovered: number }> {
    const metas = await this.store.listMetadata()
    let recovered = 0
    for (const meta of metas) {
      const stored = await this.store.readById(meta.sessionId)
      if (!stored) continue
      const { session } = stored
      if (
        session.status !== SUBAGENT_SESSION_STATUS.RUNNING &&
        session.status !== SUBAGENT_SESSION_STATUS.NEEDS_RESUME
      ) {
        continue
      }
      if (this.isSessionActive(session.sessionId)) continue

      const currentRun = this.locateInterruptibleRun(stored)
      const recoveredStatus = this.resolveRecoveredStatus(session)
      if (
        session.status === SUBAGENT_SESSION_STATUS.NEEDS_RESUME &&
        !currentRun &&
        recoveredStatus === SUBAGENT_SESSION_STATUS.NEEDS_RESUME
      ) {
        // 全终态 run 且无需状态变更：跳过（不涨 revision、不计 recovered）
        continue
      }
      const interruptedRunKey = currentRun?.runKey
      const next: StoredSubagentSession = {
        ...stored,
        runs: currentRun
          ? stored.runs.map((run) =>
              run.runKey === currentRun.runKey
                ? { ...run, status: SUBAGENT_RUN_STATUS.INTERRUPTED }
                : run,
            )
          : stored.runs,
        intents: interruptedRunKey
          ? stored.intents.map((intent) =>
              intent.state === SUBAGENT_MESSAGE_INTENT_STATE.CLAIMED &&
              intent.claimedByRunKey === interruptedRunKey
                ? {
                    ...intent,
                    state: SUBAGENT_MESSAGE_INTENT_STATE.RECOVERY_REQUIRED,
                  }
                : intent,
            )
          : stored.intents,
        session: {
          ...session,
          status: recoveredStatus,
          revision: session.revision + 1,
        },
      }
      try {
        await this.store.compareAndUpdate(stored, next)
      } catch (error) {
        if (error instanceof RevisionConflictError) continue
        throw error
      }
      recovered++
    }
    return { recovered }
  }

  private toSnapshot(stored: StoredSubagentSession): SubagentSessionSnapshot {
    const currentRun =
      stored.session.currentRunSequence !== undefined
        ? stored.runs.find(
            (run) => run.runSequence === stored.session.currentRunSequence,
          )
        : undefined
    return {
      session: { ...stored.session },
      currentRun: currentRun ? { ...currentRun } : undefined,
      recentRuns: stored.runs.map((run) => ({ ...run })),
      intents: stored.intents.map((intent) => ({ ...intent })),
      ...(stored.latestTranscript !== undefined
        ? { transcriptPage: stored.latestTranscript }
        : {}),
      ...(stored.changes !== undefined ? { changes: stored.changes } : {}),
    }
  }

  /** 定位当前 run：currentRunSequence 优先，否则取最新 run。 */
  private locateRun(stored: StoredSubagentSession): SubagentRun | undefined {
    if (stored.session.currentRunSequence !== undefined) {
      const bySequence = stored.runs.find(
        (run) => run.runSequence === stored.session.currentRunSequence,
      )
      if (bySequence) return bySequence
    }
    return stored.runs[stored.runs.length - 1]
  }

  /**
   * 定位可中断 run：currentRunSequence 优先，否则取最新非终态 run。
   * 终态 run（completed/aborted/failed/interrupted）绝不被恢复扫描回写。
   */
  private locateInterruptibleRun(
    stored: StoredSubagentSession,
  ): SubagentRun | undefined {
    if (stored.session.currentRunSequence !== undefined) {
      const bySequence = stored.runs.find(
        (run) => run.runSequence === stored.session.currentRunSequence,
      )
      if (bySequence && !this.isTerminalRunStatus(bySequence.status)) {
        return bySequence
      }
    }
    for (let i = stored.runs.length - 1; i >= 0; i--) {
      if (!this.isTerminalRunStatus(stored.runs[i].status)) {
        return stored.runs[i]
      }
    }
    return undefined
  }

  private isTerminalRunStatus(status: SubagentRunStatus): boolean {
    return (
      status === SUBAGENT_RUN_STATUS.COMPLETED ||
      status === SUBAGENT_RUN_STATUS.ABORTED ||
      status === SUBAGENT_RUN_STATUS.FAILED ||
      status === SUBAGENT_RUN_STATUS.INTERRUPTED
    )
  }

  /** R13：delegatedRoleId 存在且 resolveDelegatedRole 判定失败 → ORPHANED。 */
  private resolveRecoveredStatus(
    session: SubagentSession,
  ): SubagentSessionStatus {
    const roleId = session.delegatedRoleId
    if (
      roleId &&
      this.options.resolveDelegatedRole &&
      !this.options.resolveDelegatedRole(roleId, session.modelPreferenceId)
    ) {
      return SUBAGENT_SESSION_STATUS.ORPHANED
    }
    return SUBAGENT_SESSION_STATUS.NEEDS_RESUME
  }

  /**
   * settle 后的 session 状态：closing 的会话优先归档（设计 6.5：active run
   * settle 为 aborted 后 archive），orphaned/archived 不再重新开放；其余一律
   * 回 IDLE（设计 §4：run 终结后 session 回到 idle）。
   */
  private resolveSettledSessionStatus(
    status: SubagentSessionStatus,
  ): SubagentSessionStatus {
    if (status === SUBAGENT_SESSION_STATUS.CLOSING) {
      return SUBAGENT_SESSION_STATUS.ARCHIVED
    }
    if (
      status === SUBAGENT_SESSION_STATUS.ARCHIVED ||
      status === SUBAGENT_SESSION_STATUS.ORPHANED
    ) {
      return status
    }
    return SUBAGENT_SESSION_STATUS.IDLE
  }
}

/** settle 终态写与并发 send 竞争的收敛重试上限。 */
const SETTLE_MAX_ATTEMPTS = 3

let subagentSessionService: SubagentSessionService | null = null

/** R3 单例：host 生命周期内只初始化一次；settings 走 getter 以支持运行期变化。 */
export function initSubagentSessionService(
  app: App,
  settings: () => YoloSettings | null,
  options: SubagentSessionServiceOptions = {},
): void {
  if (subagentSessionService) return
  const baseDir = getYoloUserDataRootDir(settings())
  subagentSessionService = new SubagentSessionService(
    new SubagentSessionStore(app, `${baseDir}/${SUBAGENT_DIR}`, {
      prepareDataDir: async () => {
        const rootDir = await ensureUserDataRootDir(app, settings())
        return normalizePath(`${rootDir}/${SUBAGENT_DIR}`)
      },
    }),
    options,
  )
}

export function getSubagentSessionService(): SubagentSessionService | null {
  return subagentSessionService
}

/**
 * Web 浏览器侧的会话服务挂载（Task 11 web 接线）：浏览器进程没有本地文件
 * 系统/会话 store，UI 消费面（SubagentCard 的 session 状态行/恢复/resend/drop
 * 与 runSubagentSessionAction 的续跑投递）只用到 query/recover/queueRecovery/
 * deliverQueuedIntents/resumeAfterRecovery 五个方法——由
 * createWebSubagentSessionService 的 HTTP facade 经 /api/subagent/* 转发到
 * 服务端真实 SubagentSessionService。
 * 与桌面 initSubagentSessionService 互斥（同一模块级单例）：浏览器 bundle 只
 * 调用本入口；桌面进程只调用 initSubagentSessionService。cast 边界限定在此处：
 * facade 是 Pick 子集，运行时绝不触碰其余方法（桌面 UI 的会话 chat 输入面
 * web 未实现）。
 */
export type WebSubagentSessionServiceLike = Pick<
  SubagentSessionService,
  | 'query'
  | 'recover'
  | 'queueRecovery'
  | 'deliverQueuedIntents'
  | 'resumeAfterRecovery'
>

export function initWebSubagentSessionService(
  service: WebSubagentSessionServiceLike,
): void {
  if (subagentSessionService) return
  subagentSessionService = service as unknown as SubagentSessionService
}
