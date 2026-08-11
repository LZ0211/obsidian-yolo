export type WebAgentStateThrottler<T> = {
  publish: (state: T) => void
  flush: () => void
  dispose: () => void
}

export type WebAgentStateThrottlerOptions<T> = {
  intervalMs: number
  emit: (state: T) => void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export function createWebAgentStateThrottler<T>(
  options: WebAgentStateThrottlerOptions<T>,
): WebAgentStateThrottler<T> {
  const now = options.now ?? (() => Date.now())
  const setTimer =
    options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as number))
  let lastEmittedAt = Number.NEGATIVE_INFINITY
  let pendingState: T | null = null
  let timer: unknown = null

  const flush = () => {
    if (timer != null) {
      clearTimer(timer)
      timer = null
    }
    if (pendingState == null) return
    const state = pendingState
    pendingState = null
    lastEmittedAt = now()
    options.emit(state)
  }

  const publish = (state: T) => {
    if (timer == null && now() - lastEmittedAt >= options.intervalMs) {
      lastEmittedAt = now()
      options.emit(state)
      return
    }
    pendingState = state
    if (timer != null) return
    const delayMs = Math.max(0, options.intervalMs - (now() - lastEmittedAt))
    timer = setTimer(() => {
      timer = null
      flush()
    }, delayMs)
  }

  return {
    publish,
    flush,
    dispose: () => {
      if (timer != null) {
        clearTimer(timer)
        timer = null
      }
      pendingState = null
    },
  }
}
