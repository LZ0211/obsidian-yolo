import { migrateFrom84To85 } from './84_to_85'

describe('migrateFrom84To85', () => {
  it('bumps version and defaults mineru to disabled with empty connection', () => {
    const result = migrateFrom84To85({ version: 84 })

    expect(result.version).toBe(85)
    expect(result.mineru).toEqual({ enabled: false, baseUrl: '', apiKey: '' })
  })

  it('preserves an existing mineru configuration', () => {
    const result = migrateFrom84To85({
      version: 84,
      mineru: {
        enabled: true,
        baseUrl: 'http://localhost:7860',
        apiKey: 'Bearer xxx',
      },
    })

    expect(result.version).toBe(85)
    expect(result.mineru).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:7860',
      apiKey: 'Bearer xxx',
    })
  })
})
