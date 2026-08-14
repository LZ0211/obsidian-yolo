import { migrateFrom83To84 } from './83_to_84'

describe('migrateFrom83To84', () => {
  it('bumps version and defaults pluginUpdateNoticeEnabled to true', () => {
    const result = migrateFrom83To84({ version: 83 })

    expect(result.version).toBe(84)
    expect(result.pluginUpdateNoticeEnabled).toBe(true)
  })

  it('preserves an explicit false value', () => {
    const result = migrateFrom83To84({
      version: 83,
      pluginUpdateNoticeEnabled: false,
    })

    expect(result.pluginUpdateNoticeEnabled).toBe(false)
  })
})
