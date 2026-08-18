import type { ChatMessage } from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
import type { LLMProvider } from '../../types/provider.types'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { markRequestErrorNonRetryable } from '../ai/requestRetry'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

import {
  buildAutoContextCompactionNoticeMessage,
  buildCompactedConversationState,
  buildCompactionInstructionMessage,
  buildCompactionResumeMessage,
  buildCompactionSummaryMessage,
  buildManualCompactionState,
  createConversationCompactionSummary,
  getAutoContextCompactionPromptTrigger,
  getLatestAssistantContextUsage,
  resolveAutoContextCompactionNoticeTier,
  shouldPromptAutoContextCompactionTier,
  shouldTriggerAutoContextCompaction,
} from './compaction'

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

const mockedExecuteSingleTurn = executeSingleTurn as jest.MockedFunction<
  typeof executeSingleTurn
>

const fakeProviderClient = {} as unknown as BaseLLMProvider<LLMProvider>
const fakeModel = {
  providerId: 'provider',
  id: 'model-id',
  model: 'model-name',
} as ChatModel

const stubSingleTurnResult = (content: string, toolCalls = []) =>
  ({
    content,
    toolCalls,
  }) as Awaited<ReturnType<typeof executeSingleTurn>>

describe('createConversationCompactionSummary', () => {
  beforeEach(() => {
    mockedExecuteSingleTurn.mockReset()
  })

  const prefix: RequestMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'first user message' },
    { role: 'assistant', content: 'assistant reply' },
  ]
  const tools: RequestTool[] = [
    {
      type: 'function',
      function: {
        name: 'fs_read',
        parameters: { type: 'object', properties: {} },
      },
    },
  ]

  it('reuses the prefix verbatim, appends the instruction, and forwards tools with tool_choice none', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>SUMMARY BODY</summary>'),
    )

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      tools,
    })

    expect(summary).toBe('SUMMARY BODY')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(1)
    const call = mockedExecuteSingleTurn.mock.calls[0][0]
    // Prefix is reused byte-for-byte at the head of the request.
    expect(call.request.messages.slice(0, prefix.length)).toEqual(prefix)
    // Tools forwarded, tool calls forbidden, standard purpose, buffered delivery.
    expect(call.tools).toBe(tools)
    expect(call.tool_choice).toBe('none')
    expect(call.purpose).toBe('standard')
    expect(call.deliveryMode).toBe('buffered')
    // Tail message is the compaction instruction.
    const tail = call.request.messages.at(-1)
    expect(tail?.role).toBe('user')
    expect(typeof tail?.content === 'string' && tail.content).toContain(
      'COMPACTION MODE',
    )
  })

  it('forwards the abort signal to the summary request', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )
    const controller = new AbortController()

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      signal: controller.signal,
    })

    expect(mockedExecuteSingleTurn.mock.calls[0][0].signal).toBe(
      controller.signal,
    )
  })

  it('does not retry an aborted summary request', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = new DOMException('aborted', 'AbortError')
    mockedExecuteSingleTurn.mockRejectedValueOnce(error)

    await expect(
      createConversationCompactionSummary({
        providerClient: fakeProviderClient,
        model: fakeModel,
        requestMessages: prefix,
        signal: controller.signal,
      }),
    ).rejects.toBe(error)
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(1)
  })

  it('appends turn messages between the prefix and the instruction', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )
    const turnMessages: RequestMessage[] = [
      { role: 'assistant', content: 'calling compact' },
    ]

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      turnMessages,
    })

    const call = mockedExecuteSingleTurn.mock.calls[0][0]
    expect(call.request.messages).toHaveLength(
      prefix.length + turnMessages.length + 1,
    )
    expect(call.request.messages[prefix.length]).toEqual(turnMessages[0])
  })

  it('does not retry a buffered request classified as non-retryable', async () => {
    const error = markRequestErrorNonRetryable(new Error('buffered failure'))
    mockedExecuteSingleTurn.mockRejectedValueOnce(error)

    await expect(
      createConversationCompactionSummary({
        providerClient: fakeProviderClient,
        model: fakeModel,
        requestMessages: prefix,
      }),
    ).rejects.toBe(error)
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(1)
  })

  it('injects focusInstruction into the instruction message', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      focusInstruction: 'keep the API contract details',
    })

    const tail =
      mockedExecuteSingleTurn.mock.calls[0][0].request.messages.at(-1)
    const content = typeof tail?.content === 'string' ? tail.content : ''
    expect(content).toContain(
      '<focus_instruction>keep the API contract details</focus_instruction>',
    )
  })

  it('omits the focus_instruction block when none is provided', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    const tail =
      mockedExecuteSingleTurn.mock.calls[0][0].request.messages.at(-1)
    const content = typeof tail?.content === 'string' ? tail.content : ''
    expect(content).not.toContain('<focus_instruction>')
  })

  it('parses a bare summary without tags as a fallback', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('  plain summary text  '),
    )

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    expect(summary).toBe('plain summary text')
  })

  it('retries once when the first response is empty, then succeeds', async () => {
    mockedExecuteSingleTurn
      .mockResolvedValueOnce(stubSingleTurnResult('<summary>   </summary>'))
      .mockResolvedValueOnce(
        stubSingleTurnResult('<summary>recovered</summary>'),
      )

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    expect(summary).toBe('recovered')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(2)
  })

  it('retries on an empty summary even when stray tool calls are present', async () => {
    // An empty summary triggers the retry; the stray tool call is incidental.
    mockedExecuteSingleTurn
      .mockResolvedValueOnce(
        stubSingleTurnResult('', [{ name: 'fs_read' }] as never),
      )
      .mockResolvedValueOnce(stubSingleTurnResult('<summary>ok</summary>'))

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    expect(summary).toBe('ok')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(2)
  })

  it('accepts a non-empty summary even when stray tool calls are returned', async () => {
    // Providers that ignore tool_choice:'none' (Gemini, etc.) may still emit a
    // tool call; as long as summary text exists we accept it without retrying.
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>kept</summary>', [
        { name: 'fs_read' },
      ] as never),
    )

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    expect(summary).toBe('kept')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(1)
  })

  it('forwards the reasoning level into the request', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      reasoningLevel: 'high',
    })

    const call = mockedExecuteSingleTurn.mock.calls[0][0]
    expect((call.request as { reasoningLevel?: unknown }).reasoningLevel).toBe(
      'high',
    )
  })

  it('omits tool_choice when no tools are provided', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    const call = mockedExecuteSingleTurn.mock.calls[0][0]
    expect(call.tool_choice).toBeUndefined()
  })

  it('throws when both attempts yield an empty summary', async () => {
    mockedExecuteSingleTurn
      .mockResolvedValueOnce(stubSingleTurnResult(''))
      .mockResolvedValueOnce(stubSingleTurnResult(''))

    await expect(
      createConversationCompactionSummary({
        providerClient: fakeProviderClient,
        model: fakeModel,
        requestMessages: prefix,
      }),
    ).rejects.toThrow('empty summary')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(2)
  })
})

const baseAutoOptions = {
  autoContextCompactionEnabled: true,
  autoContextCompactionThresholdMode: 'tokens' as const,
  autoContextCompactionThresholdTokens: 100,
  autoContextCompactionThresholdRatio: 0.8,
}

const userMsg = (id: string): ChatMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: 'hi',
  mentionables: [],
})

const assistantMsg = (
  id: string,
  usage?: { prompt_tokens: number; cache_read_input_tokens?: number },
  model?: Pick<ChatModel, 'maxContextTokens'>,
): ChatMessage => ({
  role: 'assistant',
  id,
  content: 'ok',
  metadata: usage
    ? {
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: 0,
          total_tokens: usage.prompt_tokens,
          ...(usage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: usage.cache_read_input_tokens }
            : {}),
        },
        model: model
          ? ({
              providerId: 'provider',
              id: 'model-id',
              model: 'model-name',
              maxContextTokens: model.maxContextTokens,
            } satisfies ChatModel)
          : undefined,
      }
    : undefined,
})

describe('buildCompactionInstructionMessage selective retention rules', () => {
  const instruction = buildCompactionInstructionMessage(null).content
  expect(typeof instruction).toBe('string')
  const text = instruction as string

  it('keeps the most recent user messages verbatim and distills earlier ones', () => {
    expect(text).toContain('最近 3 条 user 消息按时间逐字保留')
    expect(text).toContain('更早的 user 消息提炼意图')
  })

  it('states the KEEP list for verbatim key sentences', () => {
    expect(text).toContain('KEEP 清单')
    expect(text).toContain('显式约束、硬性要求、拍板决定')
  })

  it('states the PROTECTED set that is never compressed', () => {
    expect(text).toContain('保护集 (PROTECTED)')
    expect(text).toContain('当前正在执行的步骤与未完成的操作')
    expect(text).toContain('用户最近 3 条消息，逐字保留')
    expect(text).toContain('用户显式约束、偏好覆盖与更正')
    expect(text).toContain('关键文件路径、版本号、ID、错误串，原样保留')
  })

  it('states the DROP rule: repeated reads / polling / logs keep only the conclusion plus a reference', () => {
    expect(text).toContain('可丢弃 (DROP)')
    expect(text).toContain('只留结论 + 引用')
    expect(text).toContain('工具再读原文')
  })

  it('states the space-constrained priority order', () => {
    expect(text).toContain(
      '用户约束 > 决策与理由 > 错误与失败 > 路径与实体 > 过程细节',
    )
  })
})

describe('compaction summary/resume reference-only semantics', () => {
  it('injects the summary as background reference, not active instructions', () => {
    const message = buildCompactionSummaryMessage({
      anchorMessageId: 'a1',
      summary: 'SUMMARY BODY',
      compactedAt: 1,
    })
    const text = message.content as string
    expect(text).toContain('background reference only')
    expect(text).toContain('historical snapshot, not active instructions')
    expect(text).toContain(
      'The most recent user message is the sole authority for the current task',
    )
    expect(text).toContain('SUMMARY BODY')
  })

  it('resume message keeps the summary reference-only and names the latest user message as the single authority', () => {
    const text = buildCompactionResumeMessage().content as string
    expect(text).toContain('background reference only')
    expect(text).toContain('not an active instruction set')
    expect(text).toContain(
      'is the single authoritative statement of the current task',
    )
  })
})

describe('shouldTriggerAutoContextCompaction', () => {
  it('returns false when disabled', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionEnabled: false,
        },
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('tokens mode: below threshold', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 50 }),
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('tokens mode: at threshold', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 100 }),
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('ratio mode: below ratio', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 70 }, { maxContextTokens: 100 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 100,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('ratio mode: at ratio', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 80 }, { maxContextTokens: 100 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 100,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('ratio mode: missing maxContextTokens', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 99 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
        },
        maxContextTokens: undefined,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('ratio mode: uses the same maxContextTokens source as the header ring', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg(
            'a1',
            { prompt_tokens: 800 },
            { maxContextTokens: 1000 },
          ),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('still triggers when the latest visible usage comes from an earlier assistant message', () => {
    const emptyArgs = createCompleteToolCallArguments({ value: {} })
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
          {
            role: 'tool',
            id: 't1',
            toolCalls: [
              {
                request: {
                  id: 'x',
                  name: 'y',
                  arguments: emptyArgs,
                },
                response: {
                  status: ToolCallResponseStatus.Success,
                  data: { type: 'text', text: '{}' },
                },
              },
            ],
          },
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('assistant missing prompt_tokens', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1')],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('run active', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: true,
      }),
    ).toBe(false)
  })

  it('does not repeat compaction for same assistant anchor', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [
          {
            anchorMessageId: 'a1',
            summary: 's',
            compactedAt: 1,
          },
        ],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })
})

describe('auto context compaction runtime notice', () => {
  it('returns a prompt trigger and builds a hidden user notice when threshold is reached', () => {
    const trigger = getAutoContextCompactionPromptTrigger({
      messages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 120 })],
      chatOptions: baseAutoOptions,
      maxContextTokens: 1000,
      compactionState: [],
    })

    expect(trigger?.assistantMessage.id).toBe('a1')
    if (!trigger) {
      throw new Error('Expected auto compaction prompt trigger')
    }

    const notice = buildAutoContextCompactionNoticeMessage({
      trigger,
      chatOptions: baseAutoOptions,
    })

    expect(notice.role).toBe('user')
    expect(notice.content).toContain('<auto_context_compaction_notice>')
    expect(notice.content).toContain('120 prompt tokens')
    expect(notice.content).toContain('context_compact')
    expect(notice.content).toContain('not a user-authored message')
  })

  it('does not prompt the same assistant usage twice in one runtime run', () => {
    const trigger = getAutoContextCompactionPromptTrigger({
      messages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 120 })],
      chatOptions: baseAutoOptions,
      maxContextTokens: 1000,
      compactionState: [],
      promptedAssistantMessageIds: new Set(['a1']),
    })

    expect(trigger).toBeNull()
  })

  it('does not prompt after that assistant message already anchored a compaction', () => {
    const trigger = getAutoContextCompactionPromptTrigger({
      messages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 120 })],
      chatOptions: baseAutoOptions,
      maxContextTokens: 1000,
      compactionState: [
        {
          anchorMessageId: 'a1',
          summary: 's',
          compactedAt: 1,
        },
      ],
    })

    expect(trigger).toBeNull()
  })

  it('returns the resolved tier on the trigger', () => {
    const trigger = getAutoContextCompactionPromptTrigger({
      messages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 80 })],
      chatOptions: baseAutoOptions,
      maxContextTokens: 1000,
      compactionState: [],
    })

    expect(trigger?.tier).toBe('warn')
  })
})

describe('resolveAutoContextCompactionNoticeTier', () => {
  const usage = (promptTokens: number, ratio: number | null) => ({
    assistantMessage: assistantMsg('a1', {
      prompt_tokens: promptTokens,
    }) as ChatMessage & { role: 'assistant' },
    promptTokens,
    maxContextTokens: ratio === null ? null : 1000,
    ratio,
  })

  it('tokens mode: derives tiers proportionally from the configured threshold', () => {
    const options = { ...baseAutoOptions }
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(49, null),
        chatOptions: options,
      }),
    ).toBeNull()
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(50, null),
        chatOptions: options,
      }),
    ).toBe('soft')
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(74, null),
        chatOptions: options,
      }),
    ).toBe('soft')
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(75, null),
        chatOptions: options,
      }),
    ).toBe('warn')
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(99, null),
        chatOptions: options,
      }),
    ).toBe('warn')
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(100, null),
        chatOptions: options,
      }),
    ).toBe('must')
  })

  it('ratio mode: derives tiers proportionally from the configured ratio', () => {
    const options = {
      ...baseAutoOptions,
      autoContextCompactionThresholdMode: 'ratio' as const,
      autoContextCompactionThresholdRatio: 0.8,
    }
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(0, 0.39),
        chatOptions: options,
      }),
    ).toBeNull()
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(0, 0.4),
        chatOptions: options,
      }),
    ).toBe('soft')
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(0, 0.6),
        chatOptions: options,
      }),
    ).toBe('warn')
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(0, 0.8),
        chatOptions: options,
      }),
    ).toBe('must')
  })

  it('ratio mode: returns null when the context window is unknown', () => {
    expect(
      resolveAutoContextCompactionNoticeTier({
        latestContextUsage: usage(120, null),
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio' as const,
        },
      }),
    ).toBeNull()
  })

  it('does not prompt when the compaction anchor is the following tool message', () => {
    const emptyArgs = createCompleteToolCallArguments({ value: {} })
    expect(
      getAutoContextCompactionPromptTrigger({
        messages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 120 }),
          {
            role: 'tool',
            id: 'tool-compact',
            toolCalls: [
              {
                request: {
                  id: 'compact-1',
                  name: 'context_compact',
                  arguments: emptyArgs,
                },
                response: {
                  status: ToolCallResponseStatus.Success,
                  data: {
                    type: 'text',
                    text: JSON.stringify({
                      tool: 'context_compact',
                      operation: 'compact_restart',
                    }),
                  },
                },
              },
            ],
          },
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [
          {
            anchorMessageId: 'tool-compact',
            triggerToolCallId: 'compact-1',
            summary: 's',
            compactedAt: 1,
          },
        ],
      }),
    ).toBeNull()
  })
})

describe('shouldPromptAutoContextCompactionTier per-run dedup', () => {
  it('prompts when nothing was prompted yet', () => {
    expect(
      shouldPromptAutoContextCompactionTier({
        tier: 'soft',
        promptedTier: null,
      }),
    ).toBe(true)
  })

  it('does not re-prompt an equal or lower tier within the same run', () => {
    expect(
      shouldPromptAutoContextCompactionTier({
        tier: 'soft',
        promptedTier: 'soft',
      }),
    ).toBe(false)
    expect(
      shouldPromptAutoContextCompactionTier({
        tier: 'warn',
        promptedTier: 'warn',
      }),
    ).toBe(false)
    expect(
      shouldPromptAutoContextCompactionTier({
        tier: 'must',
        promptedTier: 'must',
      }),
    ).toBe(false)
    expect(
      shouldPromptAutoContextCompactionTier({
        tier: 'soft',
        promptedTier: 'must',
      }),
    ).toBe(false)
  })

  it('re-prompts when a strictly higher tier is reached', () => {
    expect(
      shouldPromptAutoContextCompactionTier({
        tier: 'warn',
        promptedTier: 'soft',
      }),
    ).toBe(true)
    expect(
      shouldPromptAutoContextCompactionTier({
        tier: 'must',
        promptedTier: 'soft',
      }),
    ).toBe(true)
    expect(
      shouldPromptAutoContextCompactionTier({
        tier: 'must',
        promptedTier: 'warn',
      }),
    ).toBe(true)
  })
})

describe('auto context compaction notice tiers', () => {
  const noticeFor = (promptTokens: number) => {
    const trigger = getAutoContextCompactionPromptTrigger({
      messages: [
        userMsg('u1'),
        assistantMsg('a1', { prompt_tokens: promptTokens }),
      ],
      chatOptions: baseAutoOptions,
      maxContextTokens: 1000,
      compactionState: [],
    })
    if (!trigger) {
      throw new Error('Expected auto compaction prompt trigger')
    }
    return buildAutoContextCompactionNoticeMessage({
      trigger,
      chatOptions: baseAutoOptions,
    }).content as string
  }

  it('soft tier wording suggests considering compaction', () => {
    const content = noticeFor(50)
    expect(content).toContain('Consider compacting in the near future')
    expect(content).toContain('<auto_context_compaction_notice>')
  })

  it('warn tier wording strongly recommends compaction', () => {
    const content = noticeFor(80)
    expect(content).toContain('Compacting soon is strongly recommended')
  })

  it('must tier keeps the threshold-reached wording', () => {
    const content = noticeFor(120)
    expect(content).toContain(
      "has reached the user's automatic context compaction threshold",
    )
  })
})

describe('buildManualCompactionState loadedDeferredToolSchemas persistence', () => {
  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  it('persists disclosed on-demand tool schemas after manual compaction', async () => {
    const messages: ChatMessage[] = [
      userMsg('u1'),
      {
        role: 'tool' as const,
        id: 't-search',
        toolCalls: [
          {
            request: {
              id: 'call-search',
              name: 'yolo_local__load_tool_schemas',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text' as const,
                text: JSON.stringify({
                  tool: 'load_tool_schemas',
                  loadedToolNames: ['server__tool_a'],
                  matches: [
                    {
                      name: 'server__tool_a',
                      description: 'Tool A description',
                      parameters: {
                        type: 'object',
                        properties: { value: { type: 'string' } },
                        required: ['value'],
                      },
                    },
                  ],
                }),
              },
            },
          },
        ],
      },
    ]

    const state = await buildManualCompactionState({
      messages,
      summary: 'short summary',
    })
    expect(state?.loadedDeferredToolNames).toEqual(['server__tool_a'])
    expect(state?.loadedDeferredToolSchemas).toEqual([
      {
        name: 'server__tool_a',
        description: 'Tool A description',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ])
  })

  it('drops oversized schemas from the compaction registry', async () => {
    const hugeProperties: Record<string, unknown> = {}
    // Inflate the schema well past the 2000-token guard.
    for (let i = 0; i < 5000; i += 1) {
      hugeProperties[`field_${i}`] = {
        type: 'string',
        description: 'x'.repeat(40),
      }
    }
    const messages: ChatMessage[] = [
      userMsg('u1'),
      {
        role: 'tool' as const,
        id: 't-search',
        toolCalls: [
          {
            request: {
              id: 'call-search',
              name: 'yolo_local__load_tool_schemas',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text' as const,
                text: JSON.stringify({
                  tool: 'load_tool_schemas',
                  loadedToolNames: ['server__big_tool'],
                  matches: [
                    {
                      name: 'server__big_tool',
                      description: 'huge schema',
                      parameters: {
                        type: 'object',
                        properties: hugeProperties,
                      },
                    },
                  ],
                }),
              },
            },
          },
        ],
      },
    ]

    const state = await buildManualCompactionState({
      messages,
      summary: 's',
    })
    expect(state?.loadedDeferredToolSchemas ?? []).toEqual([])
    // Loaded names list still tracks the tool by name, since the model is told
    // to re-disclose it via load_tool_schemas.
    expect(state?.loadedDeferredToolNames).toEqual(['server__big_tool'])
  })
})

describe('getLatestAssistantContextUsage', () => {
  it('matches the header ring data source by using the latest assistant with prompt tokens', () => {
    const contextUsage = getLatestAssistantContextUsage({
      messages: [
        userMsg('u1'),
        assistantMsg('a1', {
          prompt_tokens: 100,
          cache_read_input_tokens: 40,
        }),
        {
          role: 'tool',
          id: 't1',
          toolCalls: [],
        },
      ],
      maxContextTokens: 1000,
    })

    expect(contextUsage).toEqual(
      expect.objectContaining({
        promptTokens: 100,
        maxContextTokens: 1000,
        ratio: 0.1,
        cacheHitRate: 0.4,
      }),
    )
  })

  it('returns usage with null max when the context window is unknown', () => {
    const contextUsage = getLatestAssistantContextUsage({
      messages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 100 })],
      maxContextTokens: undefined,
    })

    expect(contextUsage).toEqual(
      expect.objectContaining({
        promptTokens: 100,
        maxContextTokens: null,
        ratio: null,
      }),
    )
  })
})

describe('buildCompactedConversationState retainRecentTurns', () => {
  const compactToolMsg = (id: string, text: string): ChatMessage => ({
    role: 'tool',
    id,
    toolCalls: [
      {
        request: {
          id: 'tc-compact',
          name: 'context_compact',
          arguments: createCompleteToolCallArguments({ value: {} }),
        },
        response: {
          status: ToolCallResponseStatus.Success,
          data: { type: 'text', text },
        },
      },
    ],
    metadata: {},
  })

  const compactResult = (retainRecentTurns: number): string =>
    JSON.stringify({
      tool: 'context_compact',
      operation: 'compact_restart',
      retainRecentTurns,
    })

  it('keeps the most recent N user turns and compacts only what precedes them', async () => {
    const messages = [
      userMsg('u1'),
      assistantMsg('a1'),
      userMsg('u2'),
      compactToolMsg('t1', compactResult(2)),
      userMsg('u3'),
      assistantMsg('a3'),
      userMsg('u4'),
    ]

    const compacted = await buildCompactedConversationState({
      messages,
      summary: '摘要',
      summaryModelId: 'm',
    })

    expect(compacted).not.toBeNull()
    // Retention starts at u3 (index 4); the anchor is the message before it.
    expect(compacted?.anchorMessageId).toBe('t1')
    expect(compacted?.compactedMessageCount).toBe(4)
    expect(compacted?.triggerToolCallId).toBeUndefined()
    expect(compacted?.summary).toBe('摘要')
  })

  it('returns null when the retention window covers the whole history', async () => {
    const messages = [
      userMsg('u1'),
      compactToolMsg('t1', compactResult(10)),
      userMsg('u2'),
    ]

    const compacted = await buildCompactedConversationState({
      messages,
      summary: '摘要',
    })

    expect(compacted).toBeNull()
  })

  it('ignores invalid retainRecentTurns values and falls back to full compaction', async () => {
    const messages = [
      userMsg('u1'),
      compactToolMsg(
        't1',
        JSON.stringify({
          tool: 'context_compact',
          operation: 'compact_restart',
          retainRecentTurns: 'two',
        }),
      ),
    ]

    const compacted = await buildCompactedConversationState({
      messages,
      summary: '摘要',
    })

    expect(compacted).not.toBeNull()
    expect(compacted?.triggerToolCallId).toBe('tc-compact')
  })
})
