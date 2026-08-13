import type { McpManager } from '../../mcp/mcpManager'
import type { NativeAgentRuntime } from '../native-runtime'

import {
  type SubagentRuntimeEntry,
  subagentRuntimeRegistry,
} from './runtime-registry'

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
  const registeredTaskIds = new Set<string>()

  const register = (entry: SubagentRuntimeEntry): SubagentRuntimeEntry => {
    subagentRuntimeRegistry.register(entry)
    registeredTaskIds.add(entry.taskId)
    return entry
  }

  // Singleton — reset between tests.
  afterEach(() => {
    for (const taskId of registeredTaskIds) {
      subagentRuntimeRegistry.unregister(taskId)
    }
    registeredTaskIds.clear()
  })

  it('register / getByTaskId / unregister round-trips', () => {
    const entry = makeEntry({ taskId: 'sub_a' })
    subagentRuntimeRegistry.register(entry)
    expect(subagentRuntimeRegistry.getByTaskId('sub_a')).toBe(entry)

    subagentRuntimeRegistry.unregister('sub_a')
    expect(subagentRuntimeRegistry.getByTaskId('sub_a')).toBeUndefined()
  })

  it('findByToolCallId returns the owning entry', () => {
    const entryA = register(
      makeEntry({
        taskId: 'sub_a',
        runtime: makeRuntime(['call-1', 'call-2']),
      }),
    )
    const entryB = register(
      makeEntry({
        taskId: 'sub_b',
        runtime: makeRuntime(['call-3']),
      }),
    )

    expect(subagentRuntimeRegistry.findByToolCallId('call-2')).toBe(entryA)
    expect(subagentRuntimeRegistry.findByToolCallId('call-3')).toBe(entryB)
    expect(subagentRuntimeRegistry.findByToolCallId('unknown')).toBeUndefined()
  })

  it('getByTaskId returns undefined after unregister', () => {
    const entryA = makeEntry({ taskId: 'sub_a' })
    const entryB = makeEntry({ taskId: 'sub_b' })
    subagentRuntimeRegistry.register(entryA)
    subagentRuntimeRegistry.register(entryB)
    registeredTaskIds.add('sub_a')
    registeredTaskIds.add('sub_b')

    expect(subagentRuntimeRegistry.getByTaskId('sub_a')).toBe(entryA)
    expect(subagentRuntimeRegistry.getByTaskId('sub_b')).toBe(entryB)

    subagentRuntimeRegistry.unregister('sub_a')
    expect(subagentRuntimeRegistry.getByTaskId('sub_a')).toBeUndefined()
    expect(subagentRuntimeRegistry.getByTaskId('sub_b')).toBe(entryB)
  })
})
