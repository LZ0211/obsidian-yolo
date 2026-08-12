import * as vm from 'node:vm'
import { AgentLoopWorkerDriver, WORKER_SCRIPT } from './loop-worker'
import type { AgentWorkerInbound, AgentWorkerOutbound } from './types'

type TestDriver = {
  postMessage: (message: AgentWorkerInbound) => void
  outbound: AgentWorkerOutbound[]
}

const createInlineDriver = (): TestDriver => {
  const driver = new AgentLoopWorkerDriver()
  const outbound: AgentWorkerOutbound[] = []
  driver.subscribe((message) => outbound.push(message))
  return {
    postMessage: (message) => driver.postMessage(message),
    outbound,
  }
}

const createBlobDriver = (): TestDriver => {
  const outbound: AgentWorkerOutbound[] = []
  const self: {
    postMessage: (message: AgentWorkerOutbound) => void
    onmessage?: (event: { data: AgentWorkerInbound }) => void
  } = {
    postMessage: (message) => outbound.push(message),
  }
  vm.runInNewContext(WORKER_SCRIPT, { self })
  return {
    postMessage: (message) => {
      self.onmessage?.({ data: message })
    },
    outbound,
  }
}

const runSequence = (
  driver: TestDriver,
  messages: AgentWorkerInbound[],
): AgentWorkerOutbound[] => {
  for (const message of messages) {
    driver.postMessage(message)
  }
  return driver.outbound
}

/**
 * Drives the same message sequence through BOTH the stringified Blob script
 * path and the inline fallback driver, asserts their outbound streams are
 * byte-for-byte identical, and returns the inline stream for scenario checks.
 */
const expectParity = (
  messages: AgentWorkerInbound[],
): AgentWorkerOutbound[] => {
  const inline = runSequence(createInlineDriver(), messages)
  const blob = runSequence(createBlobDriver(), messages)
  expect(blob).toEqual(inline)
  return inline
}

const isDone = (
  message: AgentWorkerOutbound,
  reason: string,
): message is Extract<AgentWorkerOutbound, { type: 'done' }> =>
  message.type === 'done' && message.reason === reason

const findDoneReason = (
  outbound: AgentWorkerOutbound[],
  reason: string,
): Extract<AgentWorkerOutbound, { type: 'done' }> | undefined =>
  outbound.find((m) => isDone(m, reason))

const start = (
  runId: string,
  maxIterations = 10,
  maxRepeatedToolCalls?: number,
  graceEnabled?: boolean,
): AgentWorkerInbound => ({
  type: 'start',
  runId,
  maxIterations,
  ...(maxRepeatedToolCalls === undefined ? {} : { maxRepeatedToolCalls }),
  ...(graceEnabled === undefined ? {} : { graceEnabled }),
})

const toolCallLlmResult = (runId: string): AgentWorkerInbound => ({
  type: 'llm_result',
  runId,
  hasToolCalls: true,
  hasAssistantOutput: false,
})

const toolResult = (
  runId: string,
  options: {
    toolName?: string
    toolArgs?: unknown
    hasPendingTools?: boolean
    forceStopReason?: 'repeated_tool_failure' | 'repeated_read_call'
  } = {},
): AgentWorkerInbound => ({
  type: 'tool_result',
  runId,
  hasPendingTools: options.hasPendingTools ?? false,
  ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
  ...(options.toolArgs === undefined ? {} : { toolArgs: options.toolArgs }),
  ...(options.forceStopReason === undefined
    ? {}
    : { forceStopReason: options.forceStopReason }),
})

describe('loop-worker parity: Blob script vs inline driver', () => {
  test('three identical consecutive signatures stop with repeated_tool_call', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'repeated_tool_call',
    })
  })

  test('maxRepeatedToolCalls shortens the streak threshold', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId, 10, 2),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'js_eval', toolArgs: { code: 'a' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'js_eval', toolArgs: { code: 'a' } }),
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'repeated_tool_call',
    })
  })

  test('slightly different arguments never trigger the guard', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId),
      ...['x', 'y', 'x2', 'y2', 'z'].flatMap((query) => [
        toolCallLlmResult(runId),
        toolResult(runId, { toolName: 'fs_search', toolArgs: { query } }),
      ]),
    ])

    expect(findDoneReason(outbound, 'repeated_tool_call')).toBeUndefined()
  })

  test('a different tool name resets the consecutive streak', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_read', toolArgs: { path: '/p' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
    ])

    expect(findDoneReason(outbound, 'repeated_tool_call')).toBeUndefined()
  })

  test('argument key order does not change the signature', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId),
      toolCallLlmResult(runId),
      toolResult(runId, {
        toolName: 'fs_search',
        toolArgs: { query: 'x', limit: 5 },
      }),
      toolCallLlmResult(runId),
      toolResult(runId, {
        toolName: 'fs_search',
        toolArgs: { limit: 5, query: 'x' },
      }),
      toolCallLlmResult(runId),
      toolResult(runId, {
        toolName: 'fs_search',
        toolArgs: { query: 'x', limit: 5 },
      }),
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'repeated_tool_call',
    })
  })

  test('a server-prefixed and bare tool name share a signature', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId),
      toolCallLlmResult(runId),
      toolResult(runId, {
        toolName: 'someServer__fs_search',
        toolArgs: { query: 'x' },
      }),
      toolCallLlmResult(runId),
      toolResult(runId, {
        toolName: 'anotherServer__fs_search',
        toolArgs: { query: 'x' },
      }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'repeated_tool_call',
    })
  })

  test('existing repeated guards keep priority over the duplicate guard', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, {
        toolName: 'fs_search',
        toolArgs: { query: 'x' },
        forceStopReason: 'repeated_tool_failure',
      }),
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'repeated_tool_failure',
    })
  })

  test('duplicate guard fires before the approval pause', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, {
        toolName: 'fs_search',
        toolArgs: { query: 'x' },
        hasPendingTools: true,
      }),
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'repeated_tool_call',
    })
  })

  test('max_iterations still terminates the tool loop', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId, 2),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'max_iterations',
    })
  })

  test('grace disabled (default) never issues a tools-disabled request', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId, 2),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'max_iterations',
    })
    expect(
      outbound.filter(
        (m) => m.type === 'llm_request' && m.toolsDisabled === true,
      ),
    ).toHaveLength(0)
  })

  test('grace issues exactly one tools-disabled request past the budget', () => {
    const runId = 'r1'
    const outbound = expectParity([
      start(runId, 2, undefined, true),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
    ])

    const graceRequests = outbound.filter(
      (m): m is Extract<AgentWorkerOutbound, { type: 'llm_request' }> =>
        m.type === 'llm_request' && m.toolsDisabled === true,
    )
    expect(graceRequests).toHaveLength(1)
    expect(graceRequests[0]).toEqual({
      type: 'llm_request',
      runId,
      iteration: 3,
      toolsDisabled: true,
    })
    // No second grace request, and no further request after it.
    expect(
      outbound.filter((m) => m.type === 'llm_request' && m.iteration > 3),
    ).toHaveLength(0)
  })
})

describe('loop-worker inline driver', () => {
  test('approval placeholders do not count as completed attempts', () => {
    const runId = 'r1'
    const outbound = runSequence(createInlineDriver(), [
      start(runId),
      toolCallLlmResult(runId),
      toolResult(runId, { toolName: 'fs_search', toolArgs: { query: 'x' } }),
      toolCallLlmResult(runId),
      toolResult(runId, { hasPendingTools: true }),
    ])

    // 无 toolName 的占位结果不参与重复签名计数，settle 为 completed
    //（master 上游语义；backup 此处为 awaiting_approval）。
    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'completed',
    })
  })

  test('stop message settles the run as completed', () => {
    const runId = 'r1'
    const outbound = runSequence(createInlineDriver(), [
      start(runId),
      { type: 'stop', runId },
    ])

    expect(outbound[outbound.length - 1]).toEqual({
      type: 'done',
      runId,
      reason: 'completed',
    })
  })
})
