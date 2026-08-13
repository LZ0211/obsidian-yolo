import {
  calculateNextRunTime,
  describeCronSchedule,
  describeIntervalSchedule,
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

  it('resolves times in a non-fixed-offset timezone (Asia/Kathmandu, +05:45)', () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0)
    const next = parseCronNextTime('0 9 * * *', from, 'Asia/Kathmandu')
    // 09:00 in Kathmandu is 03:15 UTC — a plain fixed +5h/+5.5h offset would
    // compute the wrong instant, so this also guards the DST-era semantics of
    // IANA-tz resolution beyond whole-hour offsets.
    expect(next).toBe(Date.UTC(2026, 0, 1, 3, 15, 0))
  })

  it('skips the nonexistent wall-clock time across the US spring-forward (America/New_York)', () => {
    // US DST 2026: spring forward on 2026-03-08 — 02:30 EST does not exist
    // (clocks jump 02:00 → 03:00). The next 02:30 occurrence after 03-07
    // must not land on a nonexistent instant.
    const from = Date.UTC(2026, 2, 7, 12, 0, 0) // 2026-03-07 12:00 UTC
    const next = parseCronNextTime('30 2 * * *', from, 'America/New_York')
    // The library resolves the skipped occurrence to 03:30 EDT (07:30 UTC),
    // which is the first wall-clock time >= 02:30 that actually exists.
    expect(next).toBe(Date.UTC(2026, 2, 8, 7, 30, 0))
    expect(new Date(next).getUTCHours()).toBe(7)
  })

  it('keeps 02:30 firing at the correct instant after the spring-forward day', () => {
    const from = Date.UTC(2026, 2, 8, 12, 0, 0) // 2026-03-08 12:00 UTC (after the jump)
    const next = parseCronNextTime('30 2 * * *', from, 'America/New_York')
    expect(next).toBe(Date.UTC(2026, 2, 9, 6, 30, 0)) // 02:30 EDT
  })

  it('fires on the first of the two repeated hours across the US fall-back (America/New_York)', () => {
    // US DST 2026: fall back on 2026-11-01 — 01:30 occurs twice (EDT then
    // EST). The occurrence after 10-31 resolves to the FIRST 01:30 (EDT,
    // 05:30 UTC); the library dedupes the repeated hour.
    const from = Date.UTC(2026, 9, 31, 12, 0, 0)
    const next = parseCronNextTime('30 1 * * *', from, 'America/New_York')
    expect(next).toBe(Date.UTC(2026, 10, 1, 5, 30, 0))

    // The following occurrence is the NEXT day's 01:30 EST (06:30 UTC) — the
    // second 01:30 of 11-01 is not fired again.
    const after = parseCronNextTime('30 1 * * *', next, 'America/New_York')
    expect(after).toBe(Date.UTC(2026, 10, 2, 6, 30, 0))
  })

  it('keeps the daily 09:00 instant across the spring-forward day', () => {
    const from = Date.UTC(2026, 2, 8, 6, 0, 0) // 2026-03-08 06:00 UTC = 01:00 EST
    const next = parseCronNextTime('0 9 * * *', from, 'America/New_York')
    expect(next).toBe(Date.UTC(2026, 2, 8, 13, 0, 0)) // 09:00 EDT
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
    ).toContain('Every minute')
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
    ).toContain('Daily at 09:00')
  })
})

describe('describeIntervalSchedule', () => {
  const t = (_keyPath: string, fallback?: string) => fallback ?? _keyPath

  it('promotes whole minutes and hours to readable units', () => {
    expect(describeIntervalSchedule(60, t)).toBe('Every minute')
    expect(describeIntervalSchedule(900, t)).toBe('Every 15 minutes')
    expect(describeIntervalSchedule(3600, t)).toBe('Every hour')
    expect(describeIntervalSchedule(7200, t)).toBe('Every 2 hours')
  })

  it('falls back to seconds for intervals that do not divide evenly', () => {
    expect(describeIntervalSchedule(90, t)).toBe('Runs every 90s')
  })

  it('handles a missing interval', () => {
    expect(describeIntervalSchedule(null, t)).toBe('Runs on an interval')
  })
})

describe('describeCronSchedule', () => {
  const t = (_keyPath: string, fallback?: string) => fallback ?? _keyPath

  it('translates common shapes into short human descriptions', () => {
    expect(describeCronSchedule('* * * * *', t)).toBe('Every minute')
    expect(describeCronSchedule('*/5 * * * *', t)).toBe('Every 5 minutes')
    expect(describeCronSchedule('0 * * * *', t)).toBe('Every hour')
    expect(describeCronSchedule('0 */2 * * *', t)).toBe('Every 2 hours')
    expect(describeCronSchedule('30 9 * * *', t)).toBe('Daily at 09:30')
    expect(describeCronSchedule('0 9 15 * *', t)).toBe(
      'Monthly on day 15 at 09:00',
    )
  })

  it('localizes the weekday name for weekly schedules', () => {
    expect(describeCronSchedule('0 9 * * 1', t)).toContain('Monday')
    expect(describeCronSchedule('0 9 * * 1', t, 'zh')).toContain('星期一')
    // cron 7 == Sunday, same as 0
    expect(describeCronSchedule('0 9 * * 7', t)).toContain('Sunday')
  })

  it('falls back to the raw expression for unrecognized shapes', () => {
    expect(describeCronSchedule('0 9 1 2 3', t)).toBe('0 9 1 2 3')
    expect(describeCronSchedule('*/5 9 * * 1,3,5', t)).toBe('*/5 9 * * 1,3,5')
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
