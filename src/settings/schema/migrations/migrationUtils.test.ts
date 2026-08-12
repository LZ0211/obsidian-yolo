import {
  getMigratedChatModels,
  getMigratedProviders,
} from './migrationUtils'

describe('migration array merging', () => {
  it('deep-merges user nested fields with defaults instead of overwriting them', () => {
    const result = getMigratedChatModels(
      {
        chatModels: [
          {
            id: 'model-a',
            providerType: 'openai',
            providerId: 'openai',
            model: 'model-a',
            thinking: { budget_tokens: 4096, customFlag: true },
          },
        ],
      },
      [
        {
          id: 'model-a',
          providerType: 'openai',
          providerId: 'openai',
          model: 'model-a',
          thinking: { budget_tokens: 8192 },
          web_search_options: { search_context_size: 'high' },
        },
      ],
    )

    expect(result).toEqual([
      {
        id: 'model-a',
        providerType: 'openai',
        providerId: 'openai',
        model: 'model-a',
        // 冲突标量以默认值为准（8192），用户独有子字段 customFlag 保留
        thinking: { budget_tokens: 8192, customFlag: true },
        // 用户未设置时默认值生效
        web_search_options: { search_context_size: 'high' },
      },
    ])
  })

  it('deep-merges provider defaults without dropping user-only fields', () => {
    const result = getMigratedProviders(
      {
        providers: [
          { type: 'openai', id: 'shared', apiKey: 'user-key' },
          { type: 'custom', id: 'custom', baseUrl: 'https://proxy.test' },
        ],
      },
      [{ type: 'openai', id: 'shared' }],
    )

    expect(result).toEqual([
      { type: 'openai', id: 'shared', apiKey: 'user-key' },
      { type: 'custom', id: 'custom', baseUrl: 'https://proxy.test' },
    ])
  })
})
