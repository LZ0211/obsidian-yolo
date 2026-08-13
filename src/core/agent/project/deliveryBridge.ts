import type { YoloSettingsLike } from '../../../types/yoloSettingsLike'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'

import { ProjectDeliveryIngester } from './delivery'
import { ProjectStore, type ProjectVaultAdapter } from './store'

/**
 * Production subscriber to the background completion bus. Every terminal
 * subagent outcome for a bound task is forwarded to the ingester, which
 * records the durable delivery artifact and, if the task is still at the bound
 * revision, transitions it to awaiting_review (completed) or back to pending
 * (failed/aborted). Never ingests terminal-waiting/approval-paused events.
 */
export class ProjectDeliveryBridge {
  private readonly ingester: ProjectDeliveryIngester
  private unsubscribe?: () => void

  constructor(options: {
    getSettings: () => YoloSettingsLike | null
    adapter: ProjectVaultAdapter
    isRunActive?: (runKey: string) => boolean
  }) {
    this.ingester = new ProjectDeliveryIngester(
      new ProjectStore({ ...options, isRunActive: options.isRunActive }),
    )
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = backgroundTaskCompletionBus.subscribeCompleted(
      (event) => {
        if (event.kind !== 'subagent') return
        const record = event.record
        if (!record.projectTask || !record.result) return
        void this.ingester
          .ingest({
            binding: record.projectTask,
            runKey: record.runKey ?? `${record.taskId}:${record.runSequence ?? 1}`,
            sessionId: record.sessionId,
            runSequence: record.runSequence,
            result: {
              status: record.result.status,
              content: record.result.content,
            },
            completedAt: new Date(
              record.completedAt ?? Date.now(),
            ).toISOString(),
          })
          .catch((error) => {
            console.error('[YOLO] Project delivery ingestion failed', error)
          })
      },
    )
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }
}
