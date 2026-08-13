/**
 * Minimal relative-time formatter for the scheduled-tasks UI (cards, run
 * history): "just now", "3m ago", "in 2h", … with the absolute time available
 * to callers as the `title` attribute. `t` is threaded in so the function
 * stays pure and testable; the caller supplies its own `useLanguage().t`.
 *
 * Units are intentionally coarse (second/minute/hour/day) — anything older
 * than a week is rendered as its absolute local date+time instead, since "13d
 * ago" is less useful than a concrete date.
 */
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export function formatRelativeTime(
  timestampMs: number,
  nowMs: number,
  t: (keyPath: string, fallback?: string) => string,
): string {
  const diff = timestampMs - nowMs
  const abs = Math.abs(diff)
  const future = diff > 0

  const render = (keyPath: string, fallback: string, count: number): string =>
    t(keyPath, fallback).replace('{count}', String(count))

  if (abs < MINUTE_MS) {
    return future
      ? t('settings.scheduledTasks.timeInSeconds', 'in {count}s').replace(
          '{count}',
          String(Math.max(1, Math.round(abs / 1000))),
        )
      : t('settings.scheduledTasks.timeJustNow', 'just now')
  }
  if (abs < HOUR_MS) {
    const minutes = Math.round(abs / MINUTE_MS)
    return future
      ? render('settings.scheduledTasks.timeInMinutes', 'in {count}m', minutes)
      : render(
          'settings.scheduledTasks.timeMinutesAgo',
          '{count}m ago',
          minutes,
        )
  }
  if (abs < DAY_MS) {
    const hours = Math.round(abs / HOUR_MS)
    return future
      ? render('settings.scheduledTasks.timeInHours', 'in {count}h', hours)
      : render('settings.scheduledTasks.timeHoursAgo', '{count}h ago', hours)
  }
  if (abs < WEEK_MS) {
    const days = Math.round(abs / DAY_MS)
    return future
      ? render('settings.scheduledTasks.timeInDays', 'in {count}d', days)
      : render('settings.scheduledTasks.timeDaysAgo', '{count}d ago', days)
  }
  // Older than a week: a concrete absolute time beats a fuzzy "13d ago".
  return new Date(timestampMs).toLocaleString()
}
