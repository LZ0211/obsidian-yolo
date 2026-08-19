import {
  clearFlightLog,
  getFlightEvents,
  setFlightLogEnabled,
} from '../../../utils/debug/flightLog'

import { backgroundTaskCompletionBus } from './completion-bus'
import type { BackgroundTaskCompletedEvent } from './completion-bus'

const makeEvent = (): Extract<
  BackgroundTaskCompletedEvent,
  { kind: 'terminal_command' }
> => ({
  kind: 'terminal_command',
  taskId: 'bash_test001',
  conversationId: 'conv-1',
  record: {
    taskId: 'bash_test001',
    conversationId: 'conv-1',
    source: {
      type: 'llm_tool_call',
      assistantMessageId: 'assistant-1',
      toolCallId: 'tool-1',
    },
    title: 'echo done',
    status: 'completed',
    createdAt: 1,
    completedAt: 2,
    stdoutBuffer: 'done',
    stderrBuffer: '',
    exitCode: 0,
    abortController: new AbortController(),
  },
})

describe('backgroundTaskCompletionBus', () => {
  it('notifies subscribers and respects unsubscribe', () => {
    const subscriber = jest.fn()
    const unsubscribe =
      backgroundTaskCompletionBus.subscribeCompleted(subscriber)

    const event = makeEvent()
    backgroundTaskCompletionBus.pushCompleted(event)
    expect(subscriber).toHaveBeenCalledWith(event)

    unsubscribe()
    backgroundTaskCompletionBus.pushCompleted(makeEvent())
    expect(subscriber).toHaveBeenCalledTimes(1)
  })

  it('passes a subagent completion event with cumulative usage to subscribers', () => {
    const subscriber = jest.fn()
    const unsubscribe = backgroundTaskCompletionBus.subscribeCompleted(subscriber)
    try {
      const event: Extract<
        BackgroundTaskCompletedEvent,
        { kind: 'subagent' }
      > = {
        kind: 'subagent',
        taskId: 'sub_usage001',
        conversationId: 'conv-1',
        usage: { inputTokens: 150, outputTokens: 30 },
        record: {
          taskId: 'sub_usage001',
          conversationId: 'conv-1',
          source: {
            type: 'llm_tool_call',
            assistantMessageId: 'assistant-1',
            toolCallId: 'tool-1',
          },
          title: 'research',
          status: 'completed',
          createdAt: 1,
          completedAt: 2,
          prompt: 'do the research',
          result: {
            taskId: 'sub_usage001',
            status: 'completed',
            content: 'done',
            durationMs: 1,
            toolUseCount: 1,
          },
        },
      }

      backgroundTaskCompletionBus.pushCompleted(event)
      expect(subscriber).toHaveBeenCalledWith(event)
    } finally {
      unsubscribe()
    }
  })

  it('notifies subscribers about terminal waiting events', () => {
    const subscriber = jest.fn()
    const unsubscribe = backgroundTaskCompletionBus.subscribe(subscriber)
    const completed = makeEvent()
    const runningRecord = { ...completed.record }
    delete runningRecord.completedAt
    const waiting = {
      kind: 'terminal_command_waiting' as const,
      taskId: completed.taskId,
      conversationId: completed.conversationId,
      occurredAt: 3,
      record: {
        ...runningRecord,
        status: 'running' as const,
        stdoutBuffer: 'ready',
        stderrBuffer: 'warn',
        exitCode: null,
      },
    }

    backgroundTaskCompletionBus.pushTerminalWaiting(waiting)
    expect(subscriber).toHaveBeenCalledWith(waiting)

    unsubscribe()
  })

  it('keeps completed-only subscribers isolated from terminal waiting events', () => {
    const subscriber = jest.fn()
    const unsubscribe =
      backgroundTaskCompletionBus.subscribeCompleted(subscriber)
    const completed = makeEvent()
    const runningRecord = { ...completed.record }
    delete runningRecord.completedAt

    backgroundTaskCompletionBus.pushTerminalWaiting({
      kind: 'terminal_command_waiting',
      taskId: completed.taskId,
      conversationId: completed.conversationId,
      occurredAt: 3,
      record: {
        ...runningRecord,
        status: 'running',
        stdoutBuffer: 'ready',
        stderrBuffer: '',
        exitCode: null,
      },
    })

    expect(subscriber).not.toHaveBeenCalled()

    unsubscribe()
  })
})

describe('background task completion bus flight events', () => {
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

  it('records a task-completed event when a background task settles', () => {
    backgroundTaskCompletionBus.pushCompleted({
      kind: 'subagent',
      taskId: 't1',
      conversationId: 'c1',
      record: {} as never,
    })

    const event = getFlightEvents().find(
      (entry) => entry.event === 'task-completed',
    )
    expect(event).toMatchObject({
      scope: 'background',
      id: 'c1',
      detail: expect.stringContaining('kind=subagent taskId=t1'),
    })
  })
})
