import {
  getParentSubagentTimeoutConfig,
  hasParentSubagentDeadline,
  isParentSubagentDelegationBlocked,
  recordParentSubagentTimeout,
  registerParentSubagentDeadline,
  resetParentSubagentBreakers,
  resetParentSubagentDeadlines,
  resetParentSubagentTimeoutConfig,
  resetParentSubagentTimeoutSettingsGetter,
  setParentSubagentTimeoutConfig,
  setParentSubagentTimeoutSettingsGetter,
} from './pending-timeout-registry'

describe('parent subagent timeout config (settings getter)', () => {
  beforeEach(() => {
    resetParentSubagentTimeoutSettingsGetter()
    resetParentSubagentTimeoutConfig()
    resetParentSubagentBreakers()
  })

  afterEach(() => {
    resetParentSubagentDeadlines()
    resetParentSubagentBreakers()
    resetParentSubagentTimeoutConfig()
    resetParentSubagentTimeoutSettingsGetter()
    jest.useRealTimers()
  })

  it('reads the effective timeout config from the settings getter and re-reads it without restart', () => {
    setParentSubagentTimeoutSettingsGetter(() => ({
      timeoutMs: 30_000,
      maxConsecutiveTimeouts: 4,
      cooldownMs: 60_000,
    }))

    expect(getParentSubagentTimeoutConfig()).toEqual({
      timeoutMs: 30_000,
      maxConsecutiveTimeouts: 4,
      cooldownMs: 60_000,
    })

    // A settings change while the plugin is running: the getter is a live read
    // of current settings, so the new value takes effect without a restart.
    setParentSubagentTimeoutSettingsGetter(() => ({
      timeoutMs: 45_000,
      maxConsecutiveTimeouts: 3,
      cooldownMs: 90_000,
    }))

    expect(getParentSubagentTimeoutConfig()).toEqual({
      timeoutMs: 45_000,
      maxConsecutiveTimeouts: 3,
      cooldownMs: 90_000,
    })
  })

  it('falls back to the module override, then the defaults, when no settings getter is set', () => {
    setParentSubagentTimeoutConfig({
      timeoutMs: 5_000,
      maxConsecutiveTimeouts: 7,
      cooldownMs: 10_000,
    })
    expect(getParentSubagentTimeoutConfig()).toEqual({
      timeoutMs: 5_000,
      maxConsecutiveTimeouts: 7,
      cooldownMs: 10_000,
    })

    resetParentSubagentTimeoutConfig()
    expect(getParentSubagentTimeoutConfig()).toEqual({
      timeoutMs: 5 * 60 * 1000,
      maxConsecutiveTimeouts: 2,
      cooldownMs: 5 * 60 * 1000,
    })
  })

  it('registers a deadline at the timeout read from the settings getter (no restart)', () => {
    jest.useFakeTimers().setSystemTime(0)
    const onExpire = jest.fn()
    setParentSubagentTimeoutSettingsGetter(() => ({ timeoutMs: 4_000 }))

    registerParentSubagentDeadline({
      toolCallId: 'tc-config',
      runKey: 'conv',
      conversationId: 'conv',
      onExpire,
    })
    expect(hasParentSubagentDeadline('tc-config')).toBe(true)

    // t=3999 < deadlineAt (0 + 4000): not yet expired.
    jest.advanceTimersByTime(3_999)
    expect(onExpire).not.toHaveBeenCalled()

    // t=4000: the getter-driven deadline trips.
    jest.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith({
      toolCallId: 'tc-config',
      conversationId: 'conv',
    })
  })

  it('records timeouts against the breaker using the settings-getter maxConsecutive', () => {
    setParentSubagentTimeoutSettingsGetter(() => ({
      maxConsecutiveTimeouts: 3,
      cooldownMs: 5_000,
    }))

    // Default maxConsecutive is 2; the getter raises it to 3.
    recordParentSubagentTimeout('conv')
    recordParentSubagentTimeout('conv')
    expect(isParentSubagentDelegationBlocked('conv')).toBe(false)

    recordParentSubagentTimeout('conv')
    expect(isParentSubagentDelegationBlocked('conv')).toBe(true)
  })
})
