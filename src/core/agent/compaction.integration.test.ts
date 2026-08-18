/* eslint-disable import/no-nodejs-modules -- 集成测试在 Node 环境起真实 HTTP 服务，需要 node 内置模块 */
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ChatModel } from '../../types/chat-model.types'
import type { LLMResponseNonStreaming } from '../../types/llm/response'
import { MistralProvider } from '../llm/mistralProvider'

import {
  buildCompactedConversationState,
  createConversationCompactionSummary,
} from './compaction'

const TEST_MODEL: ChatModel = {
  providerId: 'test-provider',
  id: 'test-model',
  model: 'test-model',
  maxContextTokens: 128_000,
}

type CapturedRequest = {
  body: {
    messages?: { role: string; content: string }[]
    tools?: unknown[]
    tool_choice?: unknown
    stream?: boolean
  }
}

const startServer = (
  onRequest: (request: CapturedRequest) => unknown,
): Promise<{ server: Server; baseUrl: string; capture: CapturedRequest[] }> => {
  const capture: CapturedRequest[] = []
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const body = JSON.parse(raw) as CapturedRequest['body']
        const captured: CapturedRequest = { body }
        capture.push(captured)
        const response = onRequest(captured)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, capture })
    })
  })
}

const makeProvider = (baseUrl: string): MistralProvider =>
  new MistralProvider({
    presetType: 'openai',
    apiType: 'openai-chat',
    id: 'test-provider',
    name: 'test',
    baseUrl,
    apiKey: 'test-key',
    additionalSettings: { requestTransportMode: 'browser' },
  } as never)

const nonStreamingResponse = (
  content: string,
): LLMResponseNonStreaming => ({
  id: 'resp-1',
  model: 'test-model',
  object: 'chat.completion',
  choices: [
    {
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    },
  ],
})

const startSseServer = (
  chunks: string[],
): Promise<{ server: Server; baseUrl: string }> => {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` })
    })
  })
}

const sseChunk = (content: string, finishReason: string | null = null) => ({
  id: 'chunk-1',
  object: 'chat.completion.chunk',
  model: 'test-model',
  choices: [
    {
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    },
  ],
})

describe('compaction real-transport integration', () => {
  it('generates a summary through a real HTTP request with the cache-warm prefix', async () => {
    const { server, baseUrl, capture } = await startServer(() =>
      nonStreamingResponse(
        '<summary>用户修复了 fs_edit 的 line-range 参数校验；决定采用 oldText 定位方案。</summary>',
      ),
    )
    try {
      const provider = makeProvider(baseUrl)
      const requestMessages = [
        { role: 'user' as const, content: '历史消息一：修复 fs_edit 校验' },
        { role: 'assistant' as const, content: '好的，我改用了 oldText 定位。' },
      ]
      const turnMessages = [
        { role: 'user' as const, content: '继续：验证 line-range 模式' },
      ]

      const summary = await createConversationCompactionSummary({
        providerClient: provider,
        model: TEST_MODEL,
        requestMessages,
        turnMessages,
      })

      expect(summary).toContain('fs_edit 的 line-range 参数校验')
      expect(capture).toHaveLength(1)
      const sent = capture[0].body
      expect(sent.stream).not.toBe(true)
      // The prefix must be forwarded verbatim, the instruction appended last.
      expect(sent.messages).toHaveLength(requestMessages.length + turnMessages.length + 1)
      expect(sent.messages![0]).toEqual({ role: 'user', content: '历史消息一：修复 fs_edit 校验' })
      expect(sent.messages![1]).toEqual({ role: 'assistant', content: '好的，我改用了 oldText 定位。' })
      expect(sent.messages![2]).toEqual({ role: 'user', content: '继续：验证 line-range 模式' })
      const instruction = sent.messages![3] as { role: string; content: string }
      expect(instruction.role).toBe('user')
      expect(instruction.content).toContain('<summary>')
    } finally {
      server.close()
    }
  })

  it('forwards tools with tool_choice none when tools are provided', async () => {
    const { server, baseUrl, capture } = await startServer(() =>
      nonStreamingResponse('<summary>摘要</summary>'),
    )
    try {
      const provider = makeProvider(baseUrl)
      await createConversationCompactionSummary({
        providerClient: provider,
        model: TEST_MODEL,
        requestMessages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'fs_edit',
              description: 'x',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      })
      expect(capture[0].body.tool_choice).toBe('none')
      expect(capture[0].body.tools).toHaveLength(1)
    } finally {
      server.close()
    }
  })

  it('retries once over real HTTP when the first response is empty', async () => {
    let calls = 0
    const { server, baseUrl, capture } = await startServer(() => {
      calls += 1
      return calls === 1
        ? nonStreamingResponse('')
        : nonStreamingResponse('<summary>第二次成功</summary>')
    })
    try {
      const provider = makeProvider(baseUrl)
      const summary = await createConversationCompactionSummary({
        providerClient: provider,
        model: TEST_MODEL,
        requestMessages: [{ role: 'user', content: 'hi' }],
      })
      expect(summary).toContain('第二次成功')
      expect(capture).toHaveLength(2)
    } finally {
      server.close()
    }
  })

  it('parses a real SSE stream through the provider adapter', async () => {
    const { server, baseUrl } = await startSseServer([
      sseChunk('<summary>'),
      sseChunk('真实流式'),
      sseChunk('摘要'),
      sseChunk('</summary>', 'stop'),
    ] as never)
    try {
      const provider = makeProvider(baseUrl)
      const stream = await provider.streamResponse(
        TEST_MODEL,
        {
          model: TEST_MODEL.model,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
        { signal: new AbortController().signal },
      )
      let content = ''
      for await (const chunk of stream) {
        content += chunk.choices?.[0]?.delta?.content ?? ''
      }
      expect(content).toBe('<summary>真实流式摘要</summary>')
    } finally {
      server.close()
    }
  })

  it('builds a compacted state that records the trigger and summary', async () => {
    const messages = [
      {
        role: 'user',
        id: 'u1',
        content: '开始任务',
        metadata: {},
      },
      {
        role: 'assistant',
        id: 'a1',
        content: '好的',
        metadata: {},
        toolCallRequests: [],
      },
      {
        role: 'user',
        id: 'u2',
        content: '请压缩历史',
        metadata: {},
      },
      {
        role: 'assistant',
        id: 'a2',
        content: '我调用 context_compact 工具',
        metadata: {},
        toolCallRequests: [
          {
            id: 'tc1',
            name: 'yolo_local__context_compact',
            arguments: { value: {} },
          },
        ],
      },
      {
        role: 'tool',
        id: 't1',
        toolCalls: [
          {
            request: { id: 'tc1', name: 'yolo_local__context_compact', arguments: { value: {} } },
            response: {
              status: 'success',
              data: {
                text: JSON.stringify({
                  tool: 'context_compact',
                  operation: 'compact_restart',
                  toolCallId: null,
                  instruction: null,
                }),
              },
            },
          },
        ],
        metadata: {},
      },
    ]
    const compacted = await buildCompactedConversationState({
      messages: messages as never,
      summary: '摘要内容',
      summaryModelId: 'test-model',
    })
    expect(compacted).not.toBeNull()
    expect(compacted?.summary).toBe('摘要内容')
    expect(compacted?.triggerToolCallId).toBe('tc1')
    expect(compacted?.anchorMessageId).toBeDefined()
    expect(compacted?.summaryModelId).toBe('test-model')
  })
})
