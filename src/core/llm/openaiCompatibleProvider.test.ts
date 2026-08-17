import { OpenAICompatibleProvider } from './openaiCompatibleProvider'

describe('OpenAICompatibleProvider', () => {
  it('normalizes top-level array rerank responses', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'test-openai-compatible-rerank',
      name: 'Test OpenAI Compatible Rerank',
      presetType: 'openai-compatible',
      apiType: 'openai-compatible',
      apiKey: 'token',
      baseUrl: 'https://example.com/v1',
      enable: true,
      models: [],
      customHeaders: [],
      additionalSettings: {
        requestTransportMode: 'node',
      },
    } as never)
    const post = jest
      .fn()
      .mockResolvedValue([{ index: 0, score: 0.3522015644617017 }])
    ;(provider as unknown as { nodeClient: { post: typeof post } }).nodeClient =
      { post }

    await expect(
      provider.rerank('rerank-model', 'ok', ['hello'], { topN: 1 }),
    ).resolves.toEqual([{ index: 0, relevanceScore: 0.3522015644617017 }])
  })

  it('uses node transport for embeddings when requestTransportMode is node', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'test-openai-compatible',
      name: 'Test OpenAI Compatible',
      presetType: 'openai-compatible',
      apiType: 'openai-compatible',
      apiKey: 'token',
      baseUrl: 'https://example.com/v1',
      enable: true,
      models: [],
      customHeaders: [],
      additionalSettings: {
        requestTransportMode: 'node',
      },
    } as never)

    const nodeCreate = jest.fn().mockResolvedValue({
      data: [
        {
          embedding: [0.1, 0.2, 0.3],
        },
      ],
    })
    const browserCreate = jest.fn()
    const obsidianCreate = jest.fn()

    ;(
      provider as unknown as {
        nodeClient: { embeddings: { create: typeof nodeCreate } }
        browserClient: { embeddings: { create: typeof browserCreate } }
        obsidianClient: { embeddings: { create: typeof obsidianCreate } }
      }
    ).nodeClient = {
      embeddings: { create: nodeCreate },
    }
    ;(
      provider as unknown as {
        nodeClient: { embeddings: { create: typeof nodeCreate } }
        browserClient: { embeddings: { create: typeof browserCreate } }
        obsidianClient: { embeddings: { create: typeof obsidianCreate } }
      }
    ).browserClient = {
      embeddings: { create: browserCreate },
    }
    ;(
      provider as unknown as {
        nodeClient: { embeddings: { create: typeof nodeCreate } }
        browserClient: { embeddings: { create: typeof browserCreate } }
        obsidianClient: { embeddings: { create: typeof obsidianCreate } }
      }
    ).obsidianClient = {
      embeddings: { create: obsidianCreate },
    }

    await expect(
      provider.getEmbedding('text-embedding-3-small', 'hello'),
    ).resolves.toEqual([0.1, 0.2, 0.3])

    expect(nodeCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'hello',
      encoding_format: 'float',
    })
    expect(browserCreate).not.toHaveBeenCalled()
    expect(obsidianCreate).not.toHaveBeenCalled()
  })
})
