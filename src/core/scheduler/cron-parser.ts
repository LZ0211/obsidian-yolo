import { CronExpressionParser } from 'cron-parser'

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

/** `t` is threaded in (rather than called from a React hook) so this stays a pure, testable function; the caller supplies its own `useLanguage().t`. */
export function describeSchedule(
  schedule: ScheduleLike,
  t: (keyPath: string, fallback?: string) => string,
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
      return schedule.intervalSeconds
        ? t(
            'settings.scheduledTasks.describeInterval',
            'Runs every {seconds}s',
          ).replace('{seconds}', String(schedule.intervalSeconds))
        : t(
            'settings.scheduledTasks.describeIntervalUnset',
            'Runs on an interval',
          )
    case 'cron':
      return schedule.cronExpression
        ? t('settings.scheduledTasks.describeCron', 'Cron: {expr}').replace(
            '{expr}',
            schedule.cronExpression,
          )
        : t('settings.scheduledTasks.describeCronUnset', 'Cron expression')
  }
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
