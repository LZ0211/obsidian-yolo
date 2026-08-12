import type {
  Response,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'

import { OpenAIResponsesProvider } from './openaiResponsesProvider'

const makeProvider = () =>
  new OpenAIResponsesProvider({
    id: 'openai-test',
    presetType: 'openai',
    apiType: 'openai-responses',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    customHeaders: [],
    additionalSettings: { requestTransportMode: 'node' },
  } as never)

const makeModel = () => ({ id: 'gpt-5.4', providerId: 'openai-test' }) as never

const overrideClients = (
  provider: OpenAIResponsesProvider,
  responses: { create: jest.Mock },
) => {
  const nodeClient = { apiKey: 'test-key', responses }
  const idleClient = { apiKey: 'test-key', responses: { create: jest.fn() } }
  ;(
    provider as unknown as {
      nodeClient: typeof nodeClient
      browserClient: typeof idleClient
      obsidianClient: typeof idleClient
    }
  ).nodeClient = nodeClient
  ;(provider as unknown as { browserClient: unknown }).browserClient =
    idleClient
  ;(provider as unknown as { obsidianClient: unknown }).obsidianClient =
    idleClient
}

const continuationRequest = {
  model: 'gpt-5.4',
  stream: false,
  continuation: {
    previousResponseId: 'resp_prev',
    pendingInputItems: [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '# Hello',
      },
    ],
    endTurn: false,
  },
  messages: [{ role: 'user', content: 'Read README.md' }],
}

const completedResponse = {
  id: 'resp_1',
  created_at: 123,
  model: 'gpt-5.4',
  status: 'completed',
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  output_text: 'Keep going',
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: 'auto',
  tools: [],
  top_p: null,
  max_output_tokens: null,
  previous_response_id: 'resp_prev',
  reasoning: null,
  store: false,
  truncation: 'disabled',
  user: null,
  usage: {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  },
  output: [
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Keep going', annotations: [] }],
    },
  ],
} as unknown as Response

describe('OpenAIResponsesProvider', () => {
  it('forwards the continuation into the non-streaming request body and threads end_turn to the finish reason', async () => {
    const provider = makeProvider()
    const nodeCreate = jest.fn().mockResolvedValue(completedResponse)
    overrideClients(provider, { create: nodeCreate })

    const result = await provider.generateResponse(
      makeModel(),
      continuationRequest as never,
    )

    expect(nodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        previous_response_id: 'resp_prev',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: '# Hello',
          },
        ],
        end_turn: false,
      }),
      expect.anything(),
    )
    expect(result.choices[0].finish_reason).toBe('end_turn_continue')
  })

  it('forwards the continuation into the streaming request body and uses end_turn in the stream finish reason', async () => {
    const provider = makeProvider()
    const nodeCreate = jest.fn().mockResolvedValue(
      (async function* stream() {
        yield {
          type: 'response.completed',
          response: completedResponse,
        } as ResponseStreamEvent
      })(),
    )
    overrideClients(provider, { create: nodeCreate })

    const iterable = await provider.streamResponse(makeModel(), {
      ...continuationRequest,
      stream: true,
    } as never)
    const chunks = []
    for await (const chunk of iterable) {
      chunks.push(chunk)
    }

    expect(nodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        previous_response_id: 'resp_prev',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: '# Hello',
          },
        ],
        end_turn: false,
      }),
      expect.anything(),
    )
    expect(chunks[0].choices[0].finish_reason).toBe('end_turn_continue')
  })

  it('does not thread end_turn when no continuation is present', async () => {
    const provider = makeProvider()
    const nodeCreate = jest.fn().mockResolvedValue(completedResponse)
    overrideClients(provider, { create: nodeCreate })

    const result = await provider.generateResponse(makeModel(), {
      model: 'gpt-5.4',
      stream: false,
      messages: [{ role: 'user', content: 'Read README.md' }],
    })

    expect(nodeCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({
        previous_response_id: expect.anything(),
        end_turn: expect.anything(),
      }),
      expect.anything(),
    )
    expect(result.choices[0].finish_reason).toBe('stop')
  })
})
