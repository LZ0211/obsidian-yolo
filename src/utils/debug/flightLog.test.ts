import {
  clearFlightLog,
  flushFlightLog,
  formatFlightLog,
  getFlightEvents,
  isFlightLogEnabled,
  logFlightEvent,
  setFlightLogEnabled,
  setFlightLogSink,
  startFlightSpan,
  watchFlight,
} from './flightLog'

describe('flightLog', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-08-18T10:00:00.000Z'))
    setFlightLogEnabled(true)
    clearFlightLog()
  })

  afterEach(() => {
    jest.useRealTimers()
    setFlightLogEnabled(true)
    clearFlightLog()
  })

  const silenceConsole = () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  }

  it('appends events with a gap from the previous event', () => {
    silenceConsole()
    logFlightEvent('run', 'start', { id: 'c1:1' })
    jest.advanceTimersByTime(250)
    logFlightEvent('llm', 'start', { id: 'c1:1', detail: 'model=gpt' })

    const events = getFlightEvents()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ scope: 'run', event: 'start', id: 'c1:1', gapMs: 0 })
    expect(events[1]).toMatchObject({
      scope: 'llm',
      event: 'start',
      id: 'c1:1',
      detail: 'model=gpt',
      gapMs: 250,
    })
  })

  it('keeps the buffer bounded to the newest events', () => {
    silenceConsole()
    for (let index = 0; index < 1050; index += 1) {
      logFlightEvent('run', `e${index}`)
    }
    const events = getFlightEvents()
    expect(events).toHaveLength(1000)
    expect(events[0]?.event).toBe('e50')
    expect(events[999]?.event).toBe('e1049')
  })

  it('does not record when disabled', () => {
    silenceConsole()
    setFlightLogEnabled(false)
    logFlightEvent('run', 'start')
    expect(getFlightEvents()).toHaveLength(0)
    expect(isFlightLogEnabled()).toBe(false)
  })

  it('clearFlightLog empties the buffer', () => {
    silenceConsole()
    logFlightEvent('run', 'start')
    clearFlightLog()
    expect(getFlightEvents()).toHaveLength(0)
  })

  it('flight span records start and done with duration', () => {
    silenceConsole()
    const span = startFlightSpan('llm', 'request', { id: 'c1:1' })
    jest.advanceTimersByTime(1_200)
    span.finish()

    const events = getFlightEvents()
    expect(events.map((event) => event.event)).toEqual([
      'span:request:start',
      'span:request:done',
    ])
    expect(events[1]).toMatchObject({
      scope: 'llm',
      id: 'c1:1',
      detail: '1200ms',
    })
  })

  it('flight span cancel does not emit done', () => {
    silenceConsole()
    const span = startFlightSpan('llm', 'request', { id: 'c1:1' })
    span.cancel()
    expect(getFlightEvents().map((event) => event.event)).toEqual([
      'span:request:start',
      'span:request:cancelled',
    ])
  })

  it('flight span finish is idempotent', () => {
    silenceConsole()
    const span = startFlightSpan('llm', 'request')
    span.finish()
    span.finish()
    expect(
      getFlightEvents().filter((event) => event.event === 'span:request:done'),
    ).toHaveLength(1)
  })

  it('watchFlight emits stall events at cadence after the timeout until cleared', () => {
    silenceConsole()
    const clearWatch = watchFlight('c1:1', 'run', 30_000)
    // 5s interval ticks; stalls fire at 30s and 35s.
    jest.advanceTimersByTime(35_000)
    expect(
      getFlightEvents().filter((event) => event.event === 'stall'),
    ).toHaveLength(2)
    jest.advanceTimersByTime(10_000)
    expect(
      getFlightEvents().filter((event) => event.event === 'stall'),
    ).toHaveLength(4)
    clearWatch()
    jest.advanceTimersByTime(60_000)
    expect(
      getFlightEvents().filter((event) => event.event === 'stall'),
    ).toHaveLength(4)
  })

  it('watchFlight without timeout does not stall', () => {
    silenceConsole()
    const clearWatch = watchFlight('c1:1', 'run', 30_000)
    jest.advanceTimersByTime(10_000)
    clearWatch()
    expect(
      getFlightEvents().filter((event) => event.event === 'stall'),
    ).toHaveLength(0)
  })

  it('formats the log chronologically', () => {
    silenceConsole()
    logFlightEvent('run', 'start', { id: 'c1:1' })
    jest.advanceTimersByTime(100)
    logFlightEvent('memory', 'lane-start', { id: 'c1:1' })

    const formatted = formatFlightLog()
    expect(formatted).toContain('[run:start] [c1:1]')
    expect(formatted).toContain('[memory:lane-start] [c1:1]')
    expect(formatted).toContain('+100ms')
    expect(formatted.split('\n')).toHaveLength(2)
  })

  it('warns on console for stall events', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    const clearWatch = watchFlight('c1:1', 'run', 30_000)
    jest.advanceTimersByTime(35_000)
    clearWatch()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[run:stall]'),
    )
  })

  describe('file sink', () => {
    const writeChunk = jest.fn(async (_chunk: string) => undefined)

    beforeEach(() => {
      writeChunk.mockClear()
      setFlightLogSink({ writeChunk })
    })

    afterEach(async () => {
      setFlightLogSink(null)
      await flushFlightLog()
    })

    it('flushes buffered events to the sink on the throttle cadence', () => {
      silenceConsole()
      logFlightEvent('run', 'start', { id: 'c1:1' })
      logFlightEvent('llm', 'start', { id: 'c1:1' })
      expect(writeChunk).not.toHaveBeenCalled()
      jest.advanceTimersByTime(600)
      expect(writeChunk).toHaveBeenCalledTimes(1)
      const chunk = writeChunk.mock.calls[0]?.[0]
      expect(chunk).toContain('[run:start] [c1:1]')
      expect(chunk).toContain('[llm:start] [c1:1]')
      expect(chunk.trim().split('\n')).toHaveLength(2)
    })

    it('flushFlightLog writes pending events immediately', async () => {
      silenceConsole()
      logFlightEvent('memory', 'enqueue', { id: 'c1:1' })
      await flushFlightLog()
      expect(writeChunk).toHaveBeenCalledTimes(1)
      expect(writeChunk.mock.calls[0]?.[0]).toContain('[memory:enqueue]')
    })

    it('disables the sink after a write failure', async () => {
      silenceConsole()
      writeChunk.mockRejectedValueOnce(new Error('disk full'))
      logFlightEvent('run', 'start')
      await flushFlightLog()
      jest.advanceTimersByTime(600)
      logFlightEvent('run', 'done')
      jest.advanceTimersByTime(600)
      expect(writeChunk).toHaveBeenCalledTimes(1)
    })

    it('detaching the sink flushes the pending chunk', async () => {
      silenceConsole()
      logFlightEvent('run', 'start', { id: 'c1:1' })
      setFlightLogSink(null)
      await flushFlightLog()
      expect(writeChunk).toHaveBeenCalledTimes(1)
    })
  })
})
