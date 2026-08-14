import { WebSseHub } from './WebSseHub'

describe('WebSseHub', () => {
  it('replays buffered events after the requested cursor', () => {
    const hub = new WebSseHub({
      replayTtlMs: 5 * 60_000,
      maxEventsPerRun: 200,
      now: () => 1_000,
    })

    hub.publish('run-1', {
      sequence: 1,
      eventType: 'text',
      eventJson: { type: 'text' },
      createdAtMs: 1_000,
    })
    hub.publish('run-1', {
      sequence: 2,
      eventType: 'completed',
      eventJson: { type: 'completed' },
      createdAtMs: 1_001,
    })

    expect(
      hub.getReplayEvents('run-1', 1).map((event) => event.sequence),
    ).toEqual([2])
  })

  it('caps replay events per run', () => {
    const hub = new WebSseHub({
      replayTtlMs: 5 * 60_000,
      maxEventsPerRun: 2,
      now: () => 1_000,
    })

    for (let sequence = 1; sequence <= 3; sequence++) {
      hub.publish('run-1', {
        sequence,
        eventType: 'text',
        eventJson: { sequence },
        createdAtMs: 1_000 + sequence,
      })
    }

    expect(hub.getReplayEvents('run-1').map((event) => event.sequence)).toEqual(
      [2, 3],
    )
  })

  it('notifies subscribers and supports unsubscribe', () => {
    const hub = new WebSseHub()
    const received: number[] = []
    const unsubscribe = hub.subscribe('run-1', (event) => {
      received.push(event.sequence)
    })

    hub.publish('run-1', {
      sequence: 1,
      eventType: 'text',
      eventJson: {},
      createdAtMs: 1,
    })
    unsubscribe()
    hub.publish('run-1', {
      sequence: 2,
      eventType: 'text',
      eventJson: {},
      createdAtMs: 2,
    })

    expect(received).toEqual([1])
  })

  it('closes subscribers for a session', () => {
    const hub = new WebSseHub()
    const closed: string[] = []
    hub.subscribe('run-1', jest.fn(), {
      sessionId: 'session-1',
      onClose: (code) => closed.push(code),
    })
    hub.subscribe('run-2', jest.fn(), {
      sessionId: 'session-2',
      onClose: (code) => closed.push(`other:${code}`),
    })

    hub.closeSession('session-1', 'token_revoked')
    hub.publish('run-1', {
      sequence: 1,
      eventType: 'text',
      eventJson: {},
      createdAtMs: 1,
    })

    expect(closed).toEqual(['token_revoked'])
  })

  it('closes subscribers when a run is cleared', () => {
    const hub = new WebSseHub()
    const closed: string[] = []
    hub.subscribe('run-1', jest.fn(), {
      onClose: (code) => closed.push(code),
    })

    hub.clearRun('run-1')

    expect(closed).toEqual(['run_closed'])
  })

  it('closes all subscribers when the hub is cleared', () => {
    const hub = new WebSseHub()
    const closed: string[] = []
    hub.subscribe('run-1', jest.fn(), {
      onClose: (code) => closed.push(code),
    })
    hub.subscribe('run-2', jest.fn(), {
      onClose: (code) => closed.push(code),
    })

    hub.clear()

    expect(closed).toEqual(['agent_unavailable', 'agent_unavailable'])
  })
})
