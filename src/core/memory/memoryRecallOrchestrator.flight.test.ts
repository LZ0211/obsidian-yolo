import {
  clearFlightLog,
  getFlightEvents,
  setFlightLogEnabled,
} from '../../utils/debug/flightLog'

import { MemoryRecallOrchestrator } from './memoryRecallOrchestrator'

describe('MemoryRecallOrchestrator flight span', () => {
  beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    setFlightLogEnabled(true)
    clearFlightLog()
  })

  afterEach(() => {
    setFlightLogEnabled(false)
    clearFlightLog()
    jest.restoreAllMocks()
  })

  it('records a recall span with the hit count', async () => {
    const store = {
      query: jest.fn().mockResolvedValue([]),
      reinforce: jest.fn().mockResolvedValue(undefined),
    }
    const orchestrator = new MemoryRecallOrchestrator(
      store as never,
      {} as never,
      async () => null,
    )

    const result = await orchestrator.recall(
      { latestQuery: 'hello', recentUserMessages: [] },
      { scope: 'global', assistantId: null, partitionKey: 'global' },
      'fp',
    )

    expect(result.entries).toEqual([])
    const events = getFlightEvents()
    expect(events.map((event) => event.event)).toEqual([
      'span:recall:start',
      'span:recall:done',
    ])
    expect(events[1]?.detail).toMatch(/^hits=0 paths=lexical \d+ms$/)
  })

  it('records a recall span with error detail on failure', async () => {
    const store = {
      query: jest
        .fn()
        .mockRejectedValue(new Error('memory index unavailable')),
      reinforce: jest.fn().mockResolvedValue(undefined),
    }
    const orchestrator = new MemoryRecallOrchestrator(
      store as never,
      {} as never,
      async () => null,
    )

    await expect(
      orchestrator.recall(
        { latestQuery: 'hello', recentUserMessages: [] },
        { scope: 'global', assistantId: null, partitionKey: 'global' },
        'fp',
      ),
    ).rejects.toThrow('memory index unavailable')

    const done = getFlightEvents().find(
      (event) => event.event === 'span:recall:done',
    )
    expect(done?.detail).toContain('memory index unavailable')
  })
})
