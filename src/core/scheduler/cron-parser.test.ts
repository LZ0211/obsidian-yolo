import {
  calculateNextRunTime,
  describeSchedule,
  parseCronNextTime,
  validateCronExpression,
} from './cron-parser'

describe('parseCronNextTime', () => {
  it('returns the next matching occurrence after the given time', () => {
    const from = new Date(2026, 0, 1, 0, 0, 0).getTime()
    const next = parseCronNextTime('0 9 * * *', from)
    expect(new Date(next).getHours()).toBe(9)
    expect(next).toBeGreaterThan(from)
  })

  it('throws with a descriptive message for an invalid expression', () => {
    expect(() => parseCronNextTime('not a cron', Date.now())).toThrow()
  })

  it('computes cron occurrences in the task timezone', () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0)
    const next = parseCronNextTime('0 9 * * *', from, 'Asia/Shanghai')
    expect(next).toBe(Date.UTC(2026, 0, 1, 1, 0, 0))
  })
})

describe('calculateNextRunTime', () => {
  it('returns the stored time unchanged for a one-time schedule', () => {
    const next = calculateNextRunTime(
      {
        scheduleType: 'once',
        cronExpression: null,
        intervalSeconds: null,
        oneTimeDateTime: 12345,
      },
      1000,
    )
    expect(next).toBe(12345)
  })

  it('adds intervalSeconds * 1000 to `from` for an interval schedule', () => {
    const next = calculateNextRunTime(
      {
        scheduleType: 'interval',
        cronExpression: null,
        intervalSeconds: 60,
        oneTimeDateTime: null,
      },
      1000,
    )
    expect(next).toBe(1000 + 60_000)
  })

  it('throws when an interval schedule has no positive intervalSeconds', () => {
    expect(() =>
      calculateNextRunTime(
        {
          scheduleType: 'interval',
          cronExpression: null,
          intervalSeconds: null,
          oneTimeDateTime: null,
        },
        1000,
      ),
    ).toThrow()
  })

  it('delegates to parseCronNextTime for a cron schedule', () => {
    const from = new Date(2026, 0, 1, 0, 0, 0).getTime()
    const next = calculateNextRunTime(
      {
        scheduleType: 'cron',
        cronExpression: '0 9 * * *',
        intervalSeconds: null,
        oneTimeDateTime: null,
      },
      from,
    )
    expect(new Date(next!).getHours()).toBe(9)
  })

  it('throws when a cron schedule has no cronExpression', () => {
    expect(() =>
      calculateNextRunTime(
        {
          scheduleType: 'cron',
          cronExpression: null,
          intervalSeconds: null,
          oneTimeDateTime: null,
        },
        1000,
      ),
    ).toThrow()
  })
})

describe('describeSchedule', () => {
  const t = (_keyPath: string, fallback?: string) => fallback ?? _keyPath

  it('describes each schedule type using the supplied translator', () => {
    expect(
      describeSchedule(
        {
          scheduleType: 'interval',
          cronExpression: null,
          intervalSeconds: 60,
          oneTimeDateTime: null,
        },
        t,
      ),
    ).toContain('60')
    expect(
      describeSchedule(
        {
          scheduleType: 'cron',
          cronExpression: '0 9 * * *',
          intervalSeconds: null,
          oneTimeDateTime: null,
        },
        t,
      ),
    ).toContain('0 9 * * *')
  })
})

describe('validateCronExpression', () => {
  it('returns null for a valid expression', () => {
    expect(validateCronExpression('0 9 * * *')).toBeNull()
  })

  it('returns an error message for an invalid expression', () => {
    expect(validateCronExpression('not a cron')).not.toBeNull()
  })
})
