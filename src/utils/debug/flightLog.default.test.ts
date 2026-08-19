import { isFlightLogEnabled } from './flightLog'

describe('flightLog module default', () => {
  it('is disabled by default until the settings toggle enables it', () => {
    expect(isFlightLogEnabled()).toBe(false)
  })
})
