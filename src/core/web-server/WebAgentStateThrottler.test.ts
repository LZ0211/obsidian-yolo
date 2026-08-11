import { createWebAgentStateThrottler } from './WebAgentStateThrottler'

type State = { id: number }

describe('createWebAgentStateThrottler', () => {
  it('coalesces rapid state updates into the latest pending state', () => {
    let now = 0
    const timers: Array<() => void> = []
    const emitted: State[] = []
    const throttler = createWebAgentStateThrottler<State>({
      intervalMs: 250,
      now: () => now,
      setTimer: (callback) => {
        timers.push(callback)
        return 1
      },
      clearTimer: () => {
        timers.length = 0
      },
      emit: (state) => emitted.push(state),
    })

    throttler.publish({ id: 1 })
    now = 10
    throttler.publish({ id: 2 })
    throttler.publish({ id: 3 })

    expect(emitted).toEqual([{ id: 1 }])
    now = 250
    timers.shift()?.()
    expect(emitted).toEqual([{ id: 1 }, { id: 3 }])
  })

  it('flushes a pending state immediately', () => {
    let now = 0
    const timers: Array<() => void> = []
    const emitted: State[] = []
    const throttler = createWebAgentStateThrottler<State>({
      intervalMs: 250,
      now: () => now,
      setTimer: (callback) => {
        timers.push(callback)
        return 1
      },
      clearTimer: () => {
        timers.length = 0
      },
      emit: (state) => emitted.push(state),
    })

    throttler.publish({ id: 1 })
    now = 10
    throttler.publish({ id: 2 })
    throttler.flush()

    expect(emitted).toEqual([{ id: 1 }, { id: 2 }])
    expect(timers).toEqual([])
  })
})
