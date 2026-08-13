import { formatRelativeTime } from './relative-time'

const t = (_keyPath: string, fallback?: string) => fallback ?? _keyPath

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)

  it('renders recent timestamps as "just now"', () => {
    expect(formatRelativeTime(now - 5_000, now, t)).toBe('just now')
  })

  it('renders past times in the largest fitting unit', () => {
    expect(formatRelativeTime(now - 60_000, now, t)).toBe('1m ago')
    expect(formatRelativeTime(now - 45 * 60_000, now, t)).toBe('45m ago')
    expect(formatRelativeTime(now - 2 * 3_600_000, now, t)).toBe('2h ago')
    expect(formatRelativeTime(now - 3 * 86_400_000, now, t)).toBe('3d ago')
  })

  it('renders future times with "in …" phrasing', () => {
    expect(formatRelativeTime(now + 30_000, now, t)).toBe('in 30s')
    expect(formatRelativeTime(now + 10 * 60_000, now, t)).toBe('in 10m')
    expect(formatRelativeTime(now + 5 * 3_600_000, now, t)).toBe('in 5h')
    expect(formatRelativeTime(now + 2 * 86_400_000, now, t)).toBe('in 2d')
  })

  it('falls back to an absolute date for anything older than a week', () => {
    const old = now - 8 * 86_400_000
    expect(formatRelativeTime(old, now, t)).toBe(new Date(old).toLocaleString())
  })
})
