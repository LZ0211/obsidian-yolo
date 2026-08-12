import { getMigratedProviders } from './migrationUtils'

describe('migration array merging', () => {
  it('matches providers by type and id while retaining custom providers', () => {
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
