import type { StateIncident } from '../state/stateIncident'

import { UserNotificationPolicy } from './UserNotificationPolicy'

const incident = (overrides: Partial<StateIncident> = {}): StateIncident => ({
  incidentId: 'incident-1',
  domain: 'conversation',
  code: 'save_failed',
  severity: 'action_required',
  retryable: false,
  ...overrides,
})

test.each(['debug', 'recoverable'] as const)(
  'never turns %s incidents into Notice actions',
  (severity) => {
    const policy = new UserNotificationPolicy()
    expect(policy.handle(incident({ severity }))).not.toEqual(
      expect.objectContaining({ action: 'notice' }),
    )
  },
)

test('deduplicates one notice per incident and semantic failure', () => {
  const policy = new UserNotificationPolicy()
  expect(policy.handle(incident()).action).toBe('notice')
  expect(policy.handle(incident()).action).toBe('ignore')
  expect(policy.handle(incident({ incidentId: 'incident-2' })).action).toBe(
    'ignore',
  )
})
