import { AGENT_SESSION_MODE } from '../../state/contracts'

import { makeSubagentRunKey } from './session-types'
import type {
  SubagentTaskRecord,
  SubagentTaskSummary,
} from './types'

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
   * `abortController`). Keyed by the same session id used as the index key so
   * `abort` can reach the runtime owner of a durable or legacy run.
   */
  private readonly abortControllers = new Map<string, AbortController>()
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
    const sessionId = record.sessionId ?? record.taskId
    const runSequence = record.runSequence ?? 1
    const runKey = record.runKey ?? makeSubagentRunKey(sessionId, runSequence)
    const mode = record.mode ?? AGENT_SESSION_MODE.EPHEMERAL

    const {
      liveTranscript: _liveTranscript,
      abortController,
      ...recordSummary
    } = record
    const indexedRecord: SubagentTaskIndexRecord = {
      ...recordSummary,
      taskId: sessionId,
      sessionId,
      runSequence,
      runKey,
      mode,
    }

    this.tasks.set(sessionId, indexedRecord)
    this.abortControllers.set(sessionId, abortController)
    this.compactedTaskIds.delete(sessionId)
    this.emit([sessionId])
    if (record.status !== 'running') {
      this.scheduleCompaction(sessionId)
    }
  }

  update(
    taskId: string,
    patch: Partial<Omit<SubagentTaskRecord, 'taskId'>>,
  ): void {
    const existing = this.tasks.get(taskId)
    if (!existing) return
    const {
      liveTranscript: _liveTranscript,
      abortController,
      ...summaryPatch
    } = patch
    if (abortController) {
      this.abortControllers.set(taskId, abortController)
    }
    const summaryEntries = Object.entries(summaryPatch)
    if (
      summaryEntries.length === 0 ||
      summaryEntries.every(([key, value]) =>
        Object.is(existing[key as keyof SubagentTaskIndexRecord], value),
      )
    ) {
      return
    }
    const next: SubagentTaskIndexRecord = { ...existing, ...summaryPatch }
    this.tasks.set(taskId, next)
    this.emit([taskId])
    if (next.status !== 'running') {
      this.scheduleCompaction(taskId)
    }
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
    this.compactedTaskIds.add(taskId)
    const removedTaskIds = this.pruneCompletedRecords()
    this.emit([taskId, ...removedTaskIds])
  }

  get(taskId: string): SubagentTaskSummary | undefined {
    return this.tasks.get(taskId)
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

  abortAllForConversation(conversationId: string): void {
    for (const record of this.tasks.values()) {
      if (
        record.conversationId === conversationId &&
        record.status === 'running'
      ) {
        this.abort(record.taskId)
      }
    }
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
          record !== undefined &&
          record.status !== 'running',
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
