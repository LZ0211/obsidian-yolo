import type { ChatMessage } from '../../../types/chat'

import type { SubagentTaskRecord, SubagentTaskSummary } from './types'

const DEFAULT_MAX_COMPLETED_RECORDS = 50

export type SubagentTaskRegistrySubscriber = (
  records: SubagentTaskSummary[],
) => void

type SubagentTaskSubscriber = () => void

type SubagentTaskIndexRecord = SubagentTaskSummary

const notifySafely = (subscriber: () => void): void => {
  try {
    subscriber()
  } catch (error) {
    console.error('[YOLO] Subagent task subscriber failed', error)
  }
}

export class SubagentTaskRegistry {
  private readonly tasks = new Map<string, SubagentTaskIndexRecord>()
  /**
   * Abort owners live outside the indexed summaries (which intentionally drop
   * `abortController`). Keyed by the task id used as the index key so `abort`
   * can reach the runtime owner of a run.
   */
  private readonly abortControllers = new Map<string, AbortController>()
  /**
   * Live transcript 侧 map（Task 10 C1 恢复）：索引摘要刻意不携带
   * liveTranscript（Task 6 的 summary 形态，避免大数组随每次摘要拷贝），
   * 但运行中的实时消息仍经 `update(taskId, { liveTranscript })` 推送——存到
   * 侧 map 供 SubagentCard 的审批块/实时摘要/详情弹窗读取，与 abortControllers
   * 同一旁路模式。按 taskId 键控（与索引记录一致）。
   */
  private readonly liveTranscripts = new Map<string, readonly ChatMessage[]>()
  private readonly compactedTaskIds = new Set<string>()
  private readonly scheduledCompactionTaskIds = new Set<string>()
  private readonly subscribers = new Set<SubagentTaskRegistrySubscriber>()
  private readonly taskSubscribers = new Map<
    string,
    Set<SubagentTaskSubscriber>
  >()

  constructor(
    private readonly maxCompletedRecords = DEFAULT_MAX_COMPLETED_RECORDS,
  ) {}

  register(record: SubagentTaskRecord): void {
    const { liveTranscript, abortController, ...recordSummary } = record
    const indexedRecord: SubagentTaskIndexRecord = {
      ...recordSummary,
      taskId: record.taskId,
    }

    this.tasks.set(record.taskId, indexedRecord)
    this.abortControllers.set(record.taskId, abortController)
    if (liveTranscript) {
      this.liveTranscripts.set(record.taskId, liveTranscript)
    }
    this.compactedTaskIds.delete(record.taskId)
    this.emit([record.taskId])
    if (record.status !== 'running') {
      this.scheduleCompaction(record.taskId)
    }
  }

  update(
    taskId: string,
    patch: Partial<Omit<SubagentTaskRecord, 'taskId'>>,
  ): void {
    const existing = this.tasks.get(taskId)
    if (!existing) return
    const { liveTranscript, abortController, ...summaryPatch } = patch
    if (abortController) {
      this.abortControllers.set(taskId, abortController)
    }
    const summaryEntries = Object.entries(summaryPatch)
    const summaryChanged =
      summaryEntries.length > 0 &&
      summaryEntries.some(
        ([key, value]) =>
          !Object.is(existing[key as keyof SubagentTaskIndexRecord], value),
      )
    const liveChanged =
      liveTranscript !== undefined &&
      !Object.is(this.liveTranscripts.get(taskId), liveTranscript)
    if (!summaryChanged && !liveChanged) {
      return
    }
    if (summaryChanged) {
      const next: SubagentTaskIndexRecord = { ...existing, ...summaryPatch }
      this.tasks.set(taskId, next)
      if (next.status !== 'running') {
        this.scheduleCompaction(taskId)
      }
    }
    if (liveChanged) {
      this.liveTranscripts.set(taskId, liveTranscript)
    }
    this.emit([taskId])
  }

  compactCompleted(taskId: string): void {
    this.scheduledCompactionTaskIds.delete(taskId)
    const existing = this.tasks.get(taskId)
    if (!existing || existing.status === 'running') return
    const compactResult = existing.result
      ? (() => {
          const { transcript: _transcript, ...result } = existing.result
          return result
        })()
      : undefined

    this.tasks.set(taskId, {
      ...existing,
      result: compactResult,
    })
    this.liveTranscripts.delete(taskId)
    this.compactedTaskIds.add(taskId)
    const removedTaskIds = this.pruneCompletedRecords()
    this.emit([taskId, ...removedTaskIds])
  }

  get(taskId: string): SubagentTaskSummary | undefined {
    return this.tasks.get(taskId)
  }

  getLiveTranscript(taskId: string): readonly ChatMessage[] | undefined {
    return this.liveTranscripts.get(taskId)
  }

  list(): SubagentTaskSummary[] {
    return [...this.tasks.values()]
  }

  listByConversation(conversationId: string): SubagentTaskSummary[] {
    return [...this.tasks.values()].filter(
      (record) => record.conversationId === conversationId,
    )
  }

  abort(taskId: string): void {
    const controller = this.abortControllers.get(taskId)
    if (!controller || controller.signal.aborted) return
    controller.abort()
  }

  abortAll(): void {
    for (const controller of this.abortControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort()
      }
    }
  }

  subscribe(subscriber: SubagentTaskRegistrySubscriber): () => void {
    this.subscribers.add(subscriber)
    try {
      subscriber(this.list())
    } catch (error) {
      console.error('[YOLO] Subagent task subscriber failed', error)
    }
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  subscribeTask(
    taskId: string,
    subscriber: SubagentTaskSubscriber,
  ): () => void {
    const subscribers =
      this.taskSubscribers.get(taskId) ?? new Set<SubagentTaskSubscriber>()
    subscribers.add(subscriber)
    this.taskSubscribers.set(taskId, subscribers)
    return () => {
      subscribers.delete(subscriber)
      if (subscribers.size === 0) this.taskSubscribers.delete(taskId)
    }
  }

  private emit(changedTaskIds: readonly string[]): void {
    if (this.subscribers.size > 0) {
      const snapshot = this.list()
      for (const subscriber of [...this.subscribers]) {
        try {
          subscriber(snapshot)
        } catch (error) {
          console.error('[YOLO] Subagent task subscriber failed', error)
        }
      }
    }
    for (const taskId of new Set(changedTaskIds)) {
      for (const subscriber of [...(this.taskSubscribers.get(taskId) ?? [])]) {
        notifySafely(subscriber)
      }
    }
  }

  private pruneCompletedRecords(): string[] {
    const completedRecords = [...this.compactedTaskIds]
      .map((taskId) => this.tasks.get(taskId))
      .filter(
        (record): record is SubagentTaskIndexRecord =>
          record !== undefined && record.status !== 'running',
      )
      .sort(
        (a, b) =>
          (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt),
      )

    const recordsToRemove = completedRecords.length - this.maxCompletedRecords
    const removedTaskIds: string[] = []
    for (let index = 0; index < recordsToRemove; index += 1) {
      const taskId = completedRecords[index].taskId
      this.tasks.delete(taskId)
      this.compactedTaskIds.delete(taskId)
      this.abortControllers.delete(taskId)
      this.liveTranscripts.delete(taskId)
      removedTaskIds.push(taskId)
    }
    return removedTaskIds
  }

  private scheduleCompaction(taskId: string): void {
    if (this.scheduledCompactionTaskIds.has(taskId)) return
    this.scheduledCompactionTaskIds.add(taskId)
    void Promise.resolve().then(() => {
      if (this.tasks.get(taskId)?.status !== 'running') {
        this.compactCompleted(taskId)
      } else {
        this.scheduledCompactionTaskIds.delete(taskId)
      }
    })
  }
}

export const subagentTaskRegistry = new SubagentTaskRegistry()
