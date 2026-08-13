import { CronExpressionParser } from 'cron-parser'

import type { Language } from '../../i18n'
import type { ScheduledTask } from './scheduledTasksStore'

export type ScheduleLike = Pick<
  ScheduledTask,
  | 'scheduleType'
  | 'timezone'
  | 'cronExpression'
  | 'intervalSeconds'
  | 'oneTimeDateTime'
>

export function parseCronNextTime(
  cronExpression: string,
  from: number,
  timezone?: string | null,
): number {
  const options: Parameters<typeof CronExpressionParser.parse>[1] = {
    currentDate: new Date(from),
  }
  if (timezone) options.tz = timezone
  const interval = CronExpressionParser.parse(cronExpression, {
    ...options,
  })
  return interval.next().toDate().getTime()
}

/**
 * `'once'` is handled defensively here (returning the stored time unchanged) even though the
 * real caller (ScheduledTaskScheduler.checkAndEnqueueScheduledTasks) special-cases one-time
 * tasks by disabling them outright instead of calling this function again.
 */
export function calculateNextRunTime(
  schedule: ScheduleLike,
  from: number,
): number | null {
  switch (schedule.scheduleType) {
    case 'once':
      return schedule.oneTimeDateTime ?? null
    case 'interval':
      if (schedule.intervalSeconds == null || schedule.intervalSeconds <= 0) {
        throw new Error('interval schedule requires a positive intervalSeconds')
      }
      return from + schedule.intervalSeconds * 1000
    case 'cron':
      if (!schedule.cronExpression) {
        throw new Error('cron schedule requires cronExpression')
      }
      return parseCronNextTime(schedule.cronExpression, from, schedule.timezone)
  }
}

/** `t` is threaded in (rather than called from a React hook) so this stays a pure, testable function; the caller supplies its own `useLanguage().t`. `language` is only used for weekday/month names in the human-readable cron description. */
export function describeSchedule(
  schedule: ScheduleLike,
  t: (keyPath: string, fallback?: string) => string,
  language: Language = 'en',
): string {
  switch (schedule.scheduleType) {
    case 'once':
      return schedule.oneTimeDateTime
        ? t(
            'settings.scheduledTasks.describeOnce',
            'Runs once: {date}',
          ).replace(
            '{date}',
            new Date(schedule.oneTimeDateTime).toLocaleString(),
          )
        : t('settings.scheduledTasks.describeOnceUnset', 'Runs once')
    case 'interval':
      return describeIntervalSchedule(schedule.intervalSeconds, t)
    case 'cron':
      return schedule.cronExpression
        ? describeCronSchedule(schedule.cronExpression, t, language)
        : t('settings.scheduledTasks.describeCronUnset', 'Cron expression')
  }
}

/** Human-readable interval description: units are promoted to minutes/hours when the interval divides evenly. */
export function describeIntervalSchedule(
  intervalSeconds: number | null,
  t: (keyPath: string, fallback?: string) => string,
): string {
  if (!intervalSeconds || intervalSeconds <= 0) {
    return t(
      'settings.scheduledTasks.describeIntervalUnset',
      'Runs on an interval',
    )
  }
  if (intervalSeconds % 3600 === 0) {
    const hours = intervalSeconds / 3600
    return t(
      hours === 1
        ? 'settings.scheduledTasks.describeIntervalHour'
        : 'settings.scheduledTasks.describeIntervalHours',
      hours === 1 ? 'Every hour' : 'Every {count} hours',
    ).replace('{count}', String(hours))
  }
  if (intervalSeconds % 60 === 0) {
    const minutes = intervalSeconds / 60
    return t(
      minutes === 1
        ? 'settings.scheduledTasks.describeIntervalMinute'
        : 'settings.scheduledTasks.describeIntervalMinutes',
      minutes === 1 ? 'Every minute' : 'Every {count} minutes',
    ).replace('{count}', String(minutes))
  }
  return t(
    'settings.scheduledTasks.describeInterval',
    'Runs every {seconds}s',
  ).replace('{seconds}', String(intervalSeconds))
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

const timeOfDay = (hours: number, minutes: number): string =>
  `${pad2(hours)}:${pad2(minutes)}`

/** Localized weekday name for a cron weekday field (0/7 = Sunday). */
function weekdayName(weekday: number, language: Language): string {
  const day = weekday % 7 // cron 0-6 with 0 = Sunday; Intl 0 = Sunday
  return new Intl.DateTimeFormat(language, { weekday: 'long' }).format(
    new Date(2026, 0, 4 + day), // 2026-01-04 is a Sunday
  )
}

/**
 * Human-readable translation of common cron shapes, used by the task card and
 * the editor's schedule field:
 *   - every-minute and star-slash-N minute fields   → every N minutes
 *   - hourly and star-slash-N hour fields           → every N hours
 *   - `M H * * *`                                   → daily at H:MM
 *   - `M H * * W`                                   → every {weekday} at H:MM
 *   - `M H D * *`                                   → monthly on day D at H:MM
 * Unrecognized shapes fall back to the raw expression. `language` is only
 * used for weekday names; the `t` fallbacks keep the function usable without
 * it in tests.
 */
export function describeCronSchedule(
  cronExpression: string,
  t: (keyPath: string, fallback?: string) => string,
  language: Language = 'en',
): string {
  const expr = cronExpression.trim()
  const everyMinutes = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(expr)
  if (everyMinutes) {
    const n = Number(everyMinutes[1])
    return n === 1
      ? t('settings.scheduledTasks.cronDescEveryMinute', 'Every minute')
      : t(
          'settings.scheduledTasks.cronDescEveryNMinutes',
          'Every {count} minutes',
        ).replace('{count}', String(n))
  }
  if (/^\*\s+\*\s+\*\s+\*\s+\*$/.test(expr)) {
    return t('settings.scheduledTasks.cronDescEveryMinute', 'Every minute')
  }
  const everyHours = /^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/.exec(expr)
  if (everyHours) {
    const n = Number(everyHours[1])
    return n === 1
      ? t('settings.scheduledTasks.cronDescEveryHour', 'Every hour')
      : t(
          'settings.scheduledTasks.cronDescEveryNHours',
          'Every {count} hours',
        ).replace('{count}', String(n))
  }
  if (/^0\s+\*\s+\*\s+\*\s+\*$/.test(expr)) {
    return t('settings.scheduledTasks.cronDescEveryHour', 'Every hour')
  }
  const weekly = /^(\d+)\s+(\d+)\s+\*\s+\*\s+(\d+)$/.exec(expr)
  if (weekly) {
    return t(
      'settings.scheduledTasks.cronDescWeekly',
      'Every {weekday} at {time}',
    )
      .replace('{weekday}', weekdayName(Number(weekly[3]), language))
      .replace('{time}', timeOfDay(Number(weekly[2]), Number(weekly[1])))
  }
  const monthly = /^(\d+)\s+(\d+)\s+(\d+)\s+\*\s+\*$/.exec(expr)
  if (monthly) {
    return t(
      'settings.scheduledTasks.cronDescMonthly',
      'Monthly on day {day} at {time}',
    )
      .replace('{day}', String(Number(monthly[3])))
      .replace('{time}', timeOfDay(Number(monthly[2]), Number(monthly[1])))
  }
  const daily = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(expr)
  if (daily) {
    return t(
      'settings.scheduledTasks.cronDescDaily',
      'Daily at {time}',
    ).replace('{time}', timeOfDay(Number(daily[2]), Number(daily[1])))
  }
  return expr // unrecognized shape: fall back to the raw expression
}

/** Validates a cron expression without needing a full ScheduledTask; returns the error message on failure. */
export function validateCronExpression(expr: string): string | null {
  try {
    CronExpressionParser.parse(expr)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
