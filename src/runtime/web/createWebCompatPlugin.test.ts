import { createWebCompatPlugin } from './createWebCompatPlugin'

describe('createWebCompatPlugin', () => {
  it('unwraps AgentService-style run payloads before forwarding to runtime.agent.run', async () => {
    const agentRun = jest.fn(async () => {})
    const runtime = {
      agent: {
        run: agentRun,
        getState: jest.fn(),
        getConversationRunSummary: jest.fn(),
        subscribe: jest.fn(),
        getMessages: jest.fn(),
        replaceConversationMessages: jest.fn(),
        abort: jest.fn(),
        approveToolCall: jest.fn(),
        rejectToolCall: jest.fn(),
        abortToolCall: jest.fn(),
        isRunning: jest.fn(),
        subscribeToRunSummaries: jest.fn(),
        enqueueUserMessage: jest.fn(),
        peekPendingUserMessages: jest.fn(),
        removePendingUserMessage: jest.fn(),
        subscribeToAbortedQueuedMessages: jest.fn(),
        compactConversation: jest.fn(),
      },
    }

    const plugin = createWebCompatPlugin({
      app: {},
      pluginInfo: {
        id: 'smart-rag',
        name: 'Smart RAG',
        version: 'web',
      },
      getRuntime: () => runtime as never,
      getMcpManager: async () => ({}),
    })

    const service = plugin.getAgentService() as {
      run: (input: unknown) => Promise<void>
    }
    await service.run({
      conversationId: 'conv-1',
      loopConfig: { enableTools: true },
      input: {
        conversationId: 'conv-1',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: null,
            promptContent: 'hello',
            mentionables: [],
            selectedSkills: [],
          },
        ],
      },
    })

    expect(agentRun).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: null,
          promptContent: 'hello',
          mentionables: [],
          selectedSkills: [],
        },
      ],
    })
  })

  it('provides an empty diagnostics surface when web has no local diagnostics store', () => {
    const runtime = {
      agent: {
        getState: jest.fn(),
        getConversationRunSummary: jest.fn(),
        subscribe: jest.fn(),
        getMessages: jest.fn(),
        replaceConversationMessages: jest.fn(),
        run: jest.fn(),
        abort: jest.fn(),
        approveToolCall: jest.fn(),
        rejectToolCall: jest.fn(),
        abortToolCall: jest.fn(),
        isRunning: jest.fn(),
        subscribeToRunSummaries: jest.fn(),
        enqueueUserMessage: jest.fn(),
        peekPendingUserMessages: jest.fn(),
        removePendingUserMessage: jest.fn(),
        subscribeToAbortedQueuedMessages: jest.fn(),
        compactConversation: jest.fn(),
      },
    }

    const plugin = createWebCompatPlugin({
      app: {},
      pluginInfo: { id: 'smart-rag', name: 'Smart RAG', version: 'web' },
      getRuntime: () => runtime as never,
      getMcpManager: async () => ({}),
    })

    const service = plugin.getAgentService() as {
      getConversationDiagnostics: (conversationId: string) => unknown[]
    }

    expect(service.getConversationDiagnostics('conv-1')).toEqual([])
  })
})
