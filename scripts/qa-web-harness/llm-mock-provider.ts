/**
 * MockProvider：可脚本化的 LLM mock（extends BaseLLMProvider）。
 *
 * 形态对齐 src/core/agent/llm-turn-executor.test.ts 的 MockProvider
 * （super({presetType:'openai', apiType:'openai-responses', id:...}) +
 * generateResponse/streamResponse），区别是：
 * - 流序列按“输入内容”路由：注册若干 (match, turn[]) 规则，streamResponse
 *   时按请求消息文本命中第一条规则，按顺序消费该规则的 turn 队列；
 * - turn 是 LLMResponseStreaming[]（文本流 / tool_call 流两种构造器）。
 *
 * 装配方式：harness-server.test.ts 用 jest.mock('../../src/core/llm/manager')
 * 把 getChatModelClient 替换为固定返回 {providerClient: 本单例, model:
 * TEST_MODEL}，因此 WebChatRuntimeAdapter 全链路（/api/agent/run →
 * resolveSharedContext → AgentService.run → llm-turn-executor →
 * executeSingleTurn → streamResponse）拿到的都是这个 mock。
 */
import { BaseLLMProvider } from '../../src/core/llm/base'
import type { ChatModel } from '../../src/types/chat-model.types'
import type {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../src/types/llm/response'
import type {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestMessage,
} from '../../src/types/llm/request'
import type { LLMProvider } from '../../src/types/provider.types'

export const HARNESS_PROVIDER_ID = 'harness-provider'
export const HARNESS_MODEL_ID = 'harness-model'
export const HARNESS_TOOL_NAME = 'harness__echo'

export const TEST_MODEL: ChatModel = {
  providerId: HARNESS_PROVIDER_ID,
  id: HARNESS_MODEL_ID,
  model: 'harness-model',
  name: 'Harness Model',
}

export type MockStreamTurn = LLMResponseStreaming[]

function baseChunk(): LLMResponseStreaming {
  return {
    id: `stream-${Math.random().toString(36).slice(2)}`,
    model: TEST_MODEL.model,
    object: 'chat.completion.chunk',
    choices: [{ finish_reason: null, delta: {} }],
  }
}

/** 文本流：每个 chunk 一段增量，最后收一个 finish_reason:'stop' 的 chunk。 */
export function textTurn(chunks: string[]): MockStreamTurn {
  const turn: MockStreamTurn = chunks.map((content) => ({
    ...baseChunk(),
    choices: [{ finish_reason: null, delta: { content } }],
  }))
  turn.push({
    ...baseChunk(),
    choices: [{ finish_reason: 'stop', delta: {} }],
  })
  return turn
}

/**
 * tool_call 流：一个 tool_calls delta chunk + finish_reason:'tool_calls'。
 * name 参数化：既有场景默认 'harness__echo' 保持不变；durable delegate 场景
 * 传 'yolo_local__delegate_subagent'。
 */
export function toolCallTurn(
  name: string = HARNESS_TOOL_NAME,
  args: Record<string, unknown> = {},
): MockStreamTurn {
  return [
    {
      ...baseChunk(),
      choices: [
        {
          finish_reason: null,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `tool-call-${Math.random().toString(36).slice(2)}`,
                type: 'function',
                function: {
                  name,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
    },
    {
      ...baseChunk(),
      choices: [{ finish_reason: 'tool_calls', delta: {} }],
    },
  ]
}

type ScriptRule = {
  match: RegExp
  turns: MockStreamTurn[]
  consumed: number
}

export class MockProvider extends BaseLLMProvider<LLMProvider> {
  private readonly rules: ScriptRule[] = []
  /** 每个 stream chunk 的间隔毫秒（>0 时流式过程可被浏览器观察到）。 */
  chunkDelayMs = 0
  readonly streamCalls: Array<{ request: LLMRequestStreaming; turn: MockStreamTurn }> =
    []

  constructor() {
    super({
      presetType: 'openai',
      apiType: 'openai-responses',
      id: HARNESS_PROVIDER_ID,
    })
  }

  /** 注册脚本规则：请求文本命中 match 时，按序消费 turns（每条流一次）。 */
  script(match: RegExp, turns: MockStreamTurn[]): void {
    this.rules.push({ match, turns, consumed: 0 })
  }

  private pickTurn(request: LLMRequestStreaming): MockStreamTurn {
    // 只匹配 user 消息：system prompt 里常含 "tool" 等字样，按全量文本匹配
    // 会把文本流规则误判成 tool 流规则。
    const requestText = request.messages
      .filter((m: RequestMessage) => m.role === 'user')
      .map((m: RequestMessage) =>
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((p) => (p.type === 'text' ? p.text : ''))
                .join(' ')
            : '',
      )
      .join('\n')
    for (const rule of this.rules) {
      if (!rule.match.test(requestText)) continue
      rule.match.lastIndex = 0
      const turn = rule.turns[rule.consumed] ?? rule.turns.at(-1) ?? []
      rule.consumed += 1
      this.streamCalls.push({ request, turn })
      return turn
    }
    process.stdout.write(
      `[mock-provider] no rule matched. user messages: ${JSON.stringify(
        requestText.slice(0, 500),
      )}\n`,
    )
    this.streamCalls.push({ request, turn: textTurn(['(no scripted rule)']) })
    return textTurn(['(no scripted rule)'])
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    _options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const turn = this.pickTurn(request)
    const delayMs = this.chunkDelayMs
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of turn) {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs))
          }
          yield chunk
        }
      },
    }
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    _options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    const turn = this.pickTurn(request as unknown as LLMRequestStreaming)
    const content = turn
      .flatMap((chunk) =>
        chunk.choices
          .map((choice) => choice.delta.content ?? '')
          .join(''),
      )
      .join('')
    return {
      id: `resp-${Math.random().toString(36).slice(2)}`,
      model: TEST_MODEL.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content },
        },
      ],
    }
  }

  getEmbedding(): Promise<number[]> {
    return Promise.resolve([])
  }
}

let singleton: MockProvider | null = null

/** jest.mock 工厂与 harness 装配共享的 provider 单例。 */
export function getHarnessMockProvider(): MockProvider {
  if (!singleton) {
    singleton = new MockProvider()
  }
  return singleton
}
