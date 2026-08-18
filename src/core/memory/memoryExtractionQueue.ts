import { logFlightEvent } from '../../utils/debug/flightLog'

export type MemoryExtractionQueueTask = {
  assistantId?: string
  id: string
}

type QueueWorker<T extends MemoryExtractionQueueTask> = (
  task: T,
  signal: AbortSignal,
) => Promise<void>

const queueKey = (assistantId?: string): string => assistantId ?? '__default__'
const MAX_PENDING_EXTRACTIONS = 32
const MAX_ACTIVE_EXTRACTION_LANES = 2

type ExtractionLane<T> = {
  pending: T[]
  active: Promise<void> | null
  controller: AbortController | null
}

/** Serializes hidden extraction without delaying foreground agent turns. */
export class MemoryExtractionQueue<T extends MemoryExtractionQueueTask> {
  private lanes = new Map<string, ExtractionLane<T>>()
  private stopped = false
  private activeLaneCount = 0

  constructor(
    private readonly worker: QueueWorker<T>,
    private readonly maxActiveLanes = MAX_ACTIVE_EXTRACTION_LANES,
  ) {}

  enqueue(task: T): void {
    if (this.stopped) return
    const key = queueKey(task.assistantId)
    const lane = this.lanes.get(key) ?? {
      pending: [],
      active: null,
      controller: null,
    }
    this.lanes.set(key, lane)
    lane.pending.push(task)
    logFlightEvent('memory', 'enqueue', {
      id: task.id,
      detail: `pending=${lane.pending.length}`,
    })
    this.scheduleLanes()
    this.trimPendingLanes()
  }

  async drain(): Promise<void> {
    while (
      [...this.lanes.values()].some(
        (lane) => lane.active || lane.pending.length > 0,
      )
    ) {
      await Promise.all(
        [...this.lanes.values()]
          .map((lane) => lane.active)
          .filter((active): active is Promise<void> => Boolean(active)),
      )
    }
  }

  async shutdown(drainTimeoutMs = 1_000): Promise<void> {
    this.stopped = true
    const active = [...this.lanes.values()]
      .map((lane) => {
        lane.pending = []
        lane.controller?.abort()
        return lane.active
      })
      .filter((promise): promise is Promise<void> => Boolean(promise))
    if (active.length === 0) return
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        Promise.all(active).then(() => undefined),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, drainTimeoutMs)
        }),
      ])
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId)
    }
  }

  private trimPendingLanes(): void {
    const pendingLanes = [...this.lanes.entries()].filter(
      ([, lane]) => lane.pending.length > 0,
    )
    for (const [key, lane] of pendingLanes.slice(MAX_PENDING_EXTRACTIONS)) {
      lane.pending = []
      if (!lane.active) this.lanes.delete(key)
    }
  }

  private scheduleLanes(): void {
    while (!this.stopped && this.activeLaneCount < this.maxActiveLanes) {
      const next = [...this.lanes.entries()].find(
        ([, lane]) => !lane.active && lane.pending.length > 0,
      )
      if (!next) return
      const [key, lane] = next
      const task = lane.pending.shift()
      if (task) this.startLane(key, lane, task)
    }
  }

  private startLane(key: string, lane: ExtractionLane<T>, task: T): void {
    if (this.stopped) return
    const controller = new AbortController()
    lane.controller = controller
    this.activeLaneCount += 1
    logFlightEvent('memory', 'lane-start', {
      id: task.id,
      detail: `activeLanes=${this.activeLaneCount}`,
    })
    lane.active = this.worker(task, controller.signal)
      .catch((error: unknown) => {
        console.warn('[YOLO][MemoryAgent] queued extraction failed', error)
        logFlightEvent('memory', 'lane-failed', {
          id: task.id,
          detail: error instanceof Error ? error.message : String(error),
          consoleOutput: 'warn',
        })
      })
      .finally(() => {
        lane.active = null
        lane.controller = null
        this.activeLaneCount -= 1
        logFlightEvent('memory', 'lane-done', {
          id: task.id,
          detail: `activeLanes=${this.activeLaneCount}`,
        })
        if (lane.pending.length === 0 || this.stopped) {
          this.lanes.delete(key)
        }
        this.scheduleLanes()
      })
  }
}
