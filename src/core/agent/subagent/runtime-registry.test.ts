import type { McpManager } from '../../mcp/mcpManager'
import type { NativeAgentRuntime } from '../native-runtime'

import {
  type SubagentRuntimeEntry,
  subagentRuntimeRegistry,
} from './runtime-registry'
import { makeSubagentRunKey } from './session-types'

const makeRuntime = (toolCallIds: string[] = []): NativeAgentRuntime =>
  ({
    findToolCall: jest.fn().mockImplementation((toolCallId: string) =>
      toolCallIds.includes(toolCallId)
        ? {
            toolMessage: { id: 'msg', role: 'tool', toolCalls: [] },
            toolCall: {
              request: { id: toolCallId, name: 'tool', arguments: undefined },
              response: { status: 'pending_approval' },
            },
          }
        : null,
    ),
  }) as unknown as NativeAgentRuntime

const makeEntry = (
  overrides: Partial<SubagentRuntimeEntry>,
): SubagentRuntimeEntry => ({
  taskId: 'sub_1',
  runtime: makeRuntime(),
  mcpManager: {} as McpManager,
  parentConversationId: 'conv-parent',
  parentToolCallId: 'parent-tool-call',
  resumeRun: jest.fn().mockResolvedValue(undefined),
  ...overrides,
})

describe('subagentRuntimeRegistry', () => {
  // Singleton — reset between tests.
  afterEach(() => {
    for (const entry of subagentRuntimeRegistry.list()) {
      subagentRuntimeRegistry.unregister(entry.taskId)
    }
  })

  it('register / getByTaskId / unregister round-trips', () => {
    const entry = makeEntry({ taskId: 'sub_a' })
    subagentRuntimeRegistry.register(entry)
    expect(subagentRuntimeRegistry.getByTaskId('sub_a')).toBe(entry)

    subagentRuntimeRegistry.unregister('sub_a')
    expect(subagentRuntimeRegistry.getByTaskId('sub_a')).toBeUndefined()
  })

  it('findByToolCallId returns the owning entry', () => {
    const entryA = makeEntry({
      taskId: 'sub_a',
      runtime: makeRuntime(['call-1', 'call-2']),
    })
    const entryB = makeEntry({
      taskId: 'sub_b',
      runtime: makeRuntime(['call-3']),
    })
    subagentRuntimeRegistry.register(entryA)
    subagentRuntimeRegistry.register(entryB)

    expect(subagentRuntimeRegistry.findByToolCallId('call-2')).toBe(entryA)
    expect(subagentRuntimeRegistry.findByToolCallId('call-3')).toBe(entryB)
    expect(subagentRuntimeRegistry.findByToolCallId('unknown')).toBeUndefined()
  })

  it('list returns currently-registered entries', () => {
    const entryA = makeEntry({ taskId: 'sub_a' })
    const entryB = makeEntry({ taskId: 'sub_b' })
    subagentRuntimeRegistry.register(entryA)
    subagentRuntimeRegistry.register(entryB)

    expect(subagentRuntimeRegistry.list()).toEqual(
      expect.arrayContaining([entryA, entryB]),
    )

    subagentRuntimeRegistry.unregister('sub_a')
    expect(subagentRuntimeRegistry.list()).toEqual([entryB])
  })

  it('resolves the active session entry for durable session identity', () => {
    const entry = makeEntry({
      taskId: 'sub_session',
      sessionId: 'sub_session',
      runSequence: 2,
      runKey: 'sub_session:2',
    })
    subagentRuntimeRegistry.register(entry)

    expect(subagentRuntimeRegistry.getActiveForSession('sub_session')).toBe(
      entry,
    )
    expect(subagentRuntimeRegistry.getByTaskId('sub_session')).toBe(entry)
  })

  it('treats the task id as the session id for legacy entries', () => {
    const entry = makeEntry({ taskId: 'sub_legacy' })
    subagentRuntimeRegistry.register(entry)

    expect(subagentRuntimeRegistry.getActiveForSession('sub_legacy')).toBe(
      entry,
    )
  })

  it('reserves one run per session before runtime registration', () => {
    const reserve = subagentRuntimeRegistry.reserve.bind(
      subagentRuntimeRegistry,
    )
    const releaseReservation =
      subagentRuntimeRegistry.releaseReservation.bind(
        subagentRuntimeRegistry,
      )
    reserve({
      sessionId: 'session_reserved',
      runSequence: 1,
      runKey: makeSubagentRunKey('session_reserved', 1),
    })

    // A second run for the same session must be rejected while reserved.
    expect(() =>
      reserve({
        sessionId: 'session_reserved',
        runSequence: 2,
        runKey: makeSubagentRunKey('session_reserved', 2),
      }),
    ).toThrow('already has an active run')

    releaseReservation('session_reserved:1')

    // After release the session accepts a fresh run.
    expect(() =>
      reserve({
        sessionId: 'session_reserved',
        runSequence: 2,
        runKey: makeSubagentRunKey('session_reserved', 2),
      }),
    ).not.toThrow()
    releaseReservation('session_reserved:2')
  })

  it('rejects a reservation while the session already has an active run', () => {
    const entry = makeEntry({
      taskId: 'session_busy',
      sessionId: 'session_busy',
      runSequence: 1,
      runKey: 'session_busy:1',
    })
    subagentRuntimeRegistry.register(entry)

    expect(() =>
      subagentRuntimeRegistry.reserve({
        sessionId: 'session_busy',
        runSequence: 2,
        runKey: makeSubagentRunKey('session_busy', 2),
      }),
    ).toThrow('already has an active run')
  })

  it('rejects a duplicate reservation for the same run key', () => {
    const runKey = makeSubagentRunKey('session_dup', 1)
    subagentRuntimeRegistry.reserve({
      sessionId: 'session_dup',
      runSequence: 1,
      runKey,
    })

    expect(() =>
      subagentRuntimeRegistry.reserve({
        sessionId: 'session_dup',
        runSequence: 1,
        runKey,
      }),
    ).toThrow('already reserved')

    subagentRuntimeRegistry.releaseReservation(runKey)
  })

  it('releaseReservation accepts either the run key or the session id', () => {
    subagentRuntimeRegistry.reserve({
      sessionId: 'session_sid',
      runSequence: 3,
      runKey: makeSubagentRunKey('session_sid', 3),
    })

    subagentRuntimeRegistry.releaseReservation('session_sid')

    expect(() =>
      subagentRuntimeRegistry.reserve({
        sessionId: 'session_sid',
        runSequence: 4,
        runKey: makeSubagentRunKey('session_sid', 4),
      }),
    ).not.toThrow()
    subagentRuntimeRegistry.releaseReservation('session_sid:4')
  })

  it('is a no-op when releasing an unknown reservation', () => {
    expect(() =>
      subagentRuntimeRegistry.releaseReservation('unknown-run'),
    ).not.toThrow()
  })
})
