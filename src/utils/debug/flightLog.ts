export type FlightLogEvent = {
  ts: number
  /** Run/turn identifier the event belongs to (e.g. `conversationId:runId`). */
  id?: string
  scope: string
  event: string
  detail?: string
  /** Milliseconds since the previous recorded event — a timeline gap pinpoints a stall. */
  gapMs: number
}

const MAX_FLIGHT_LOG_EVENTS = 1000
const SINK_FLUSH_INTERVAL_MS = 500

let enabled = true
let events: FlightLogEvent[] = []
let lastTs: number | null = null

export type FlightLogSink = {
  writeChunk: (chunk: string) => Promise<void>
}

let sink: FlightLogSink | null = null
let sinkChunk = ''
let sinkTimer: ReturnType<typeof setTimeout> | null = null
let sinkFlush: Promise<void> | null = null

/**
 * Attach a file sink so events are persisted continuously (throttled) instead
 * of only on manual export — a hang kills nothing that already hit disk.
 * Caller owns rollover/capacity policy inside `writeChunk`.
 */
export function setFlightLogSink(next: FlightLogSink | null): void {
  if (sink === next) return
  if (!next) {
    // Hand off any buffered chunk before detaching the sink.
    if (sinkTimer !== null) clearTimeout(sinkTimer)
    sinkTimer = null
    void flushFlightLog()
  }
  sink = next
}

/** Flush any pending sink chunks; used on unload. */
export async function flushFlightLog(): Promise<void> {
  if (sinkTimer !== null) clearTimeout(sinkTimer)
  sinkTimer = null
  const chunk = sinkChunk
  sinkChunk = ''
  if (!sink || chunk === '') return
  sinkFlush = sink.writeChunk(chunk).catch((error: unknown) => {
    console.warn('[YOLO][Flight] file sink write failed; disabling', error)
    sink = null
  })
  await sinkFlush
  sinkFlush = null
  if (sinkChunk !== '') scheduleSinkFlush()
}

const scheduleSinkFlush = (): void => {
  if (!sink || sinkTimer !== null || sinkChunk === '') return
  sinkTimer = setTimeout(() => {
    sinkTimer = null
    void flushFlightLog()
  }, SINK_FLUSH_INTERVAL_MS)
}

export function setFlightLogEnabled(next: boolean): void {
  enabled = next
}

export function isFlightLogEnabled(): boolean {
  return enabled
}

export function clearFlightLog(): void {
  events = []
  lastTs = null
}

type FlightLogOptions = {
  id?: string
  detail?: string
  consoleOutput?: 'info' | 'warn' | 'none'
}

export function logFlightEvent(
  scope: string,
  event: string,
  options: FlightLogOptions = {},
): void {
  if (!enabled) return
  const now = Date.now()
  const gapMs = lastTs === null ? 0 : now - lastTs
  lastTs = now
  const entry: FlightLogEvent = {
    ts: now,
    ...(options.id ? { id: options.id } : {}),
    scope,
    event,
    ...(options.detail ? { detail: options.detail } : {}),
    gapMs,
  }
  events.push(entry)
  if (events.length > MAX_FLIGHT_LOG_EVENTS) {
    events.splice(0, events.length - MAX_FLIGHT_LOG_EVENTS)
  }

  if (sink) {
    sinkChunk += `${formatEntry(entry)}\n`
    scheduleSinkFlush()
  }

  const level = options.consoleOutput ?? 'info'
  if (level === 'none') return
  const idPart = options.id ? ` [${options.id}]` : ''
  const detailPart = options.detail ? ` ${options.detail}` : ''
  const message = `[YOLO][Flight][${scope}:${event}]${idPart}${detailPart} (+${gapMs}ms)`
  if (level === 'warn') {
    console.warn(message)
  } else {
    console.debug(message)
  }
}

export type FlightSpan = {
  finish(detail?: string): void
  cancel(): void
}

/** Records a span start plus an automatic duration-carrying done event. */
export function startFlightSpan(
  scope: string,
  event: string,
  options: FlightLogOptions = {},
): FlightSpan {
  const startedAt = Date.now()
  logFlightEvent(scope, `span:${event}:start`, options)
  let done = false
  return {
    finish(detail?: string) {
      if (done) return
      done = true
      logFlightEvent(scope, `span:${event}:done`, {
        id: options.id,
        detail: detail ?? `${Date.now() - startedAt}ms`,
      })
    },
    cancel() {
      if (done) return
      done = true
      logFlightEvent(scope, `span:${event}:cancelled`, {
        id: options.id,
      })
    },
  }
}

/**
 * Emits a warn-level `stall` event at a fixed cadence while the watched
 * operation exceeds `timeoutMs` without being cleared — makes a dead request
 * visible without requiring the user to watch the clock.
 */
export function watchFlight(
  id: string,
  scope: string,
  timeoutMs: number,
): () => void {
  const startedAt = Date.now()
  let cleared = false
  let lastStallAt = startedAt
  const intervalMs = Math.min(5_000, Math.max(1_000, Math.floor(timeoutMs / 4)))
  const timer = setInterval(() => {
    if (cleared) return
    const now = Date.now()
    if (now - startedAt < timeoutMs) return
    logFlightEvent(scope, 'stall', {
      id,
      detail: `waited ${now - startedAt}ms since watch start, ${now - lastStallAt}ms since last stall`,
      consoleOutput: 'warn',
    })
    lastStallAt = now
  }, intervalMs)
  return () => {
    cleared = true
    clearInterval(timer)
  }
}

export function getFlightEvents(): readonly FlightLogEvent[] {
  return events
}

const formatTime = (ts: number): string => {
  const date = new Date(ts)
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const formatEntry = (entry: FlightLogEvent): string =>
  `${formatTime(entry.ts)} [${entry.scope}:${entry.event}]${entry.id ? ` [${entry.id}]` : ''}${entry.detail ? ` ${entry.detail}` : ''} (+${entry.gapMs}ms)`

export function formatFlightLog(): string {
  return events.map(formatEntry).join('\n')
}
