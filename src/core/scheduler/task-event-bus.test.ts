import {
  type TaskEvent,
  TaskEventBus,
  type TaskEventChannel,
} from './task-event-bus'

class FakeTaskEventChannel implements TaskEventChannel {
  readonly posted: unknown[] = []
  closed = false
  private listener: ((event: MessageEvent<unknown>) => void) | null = null

  addEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listener = listener
  }

  removeEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (this.listener === listener) this.listener = null
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  close(): void {
    this.closed = true
  }

  deliver(message: TaskEvent): void {
    this.listener?.({ data: message } as MessageEvent<TaskEvent>)
  }
}

describe('TaskEventBus', () => {
  it('broadcasts local events once and handles remote events without echoing', () => {
    const channel = new FakeTaskEventChannel()
    const bus = new TaskEventBus({ channel })
    const received: TaskEvent[] = []
    bus.subscribeAll((event) => received.push(event))

    const localEvent: TaskEvent = { type: 'queue_changed' }
    const remoteEvent: TaskEvent = {
      type: 'tasks_batch_updated',
      taskIds: ['task-1'],
    }

    bus.emit(localEvent)
    channel.deliver(remoteEvent)

    expect(received).toEqual([localEvent, remoteEvent])
    expect(channel.posted).toEqual([localEvent])
  })

  it('dispose closes the channel and ignores later events', () => {
    const channel = new FakeTaskEventChannel()
    const bus = new TaskEventBus({ channel })
    const received: TaskEvent[] = []
    bus.subscribeAll((event) => received.push(event))

    bus.dispose()
    channel.deliver({ type: 'queue_changed' })
    bus.emit({ type: 'queue_changed' })

    expect(received).toEqual([])
    expect(channel.posted).toEqual([])
    expect(channel.closed).toBe(true)
  })
})
