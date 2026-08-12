import { createIncidentFactory } from './stateIncident'

const sequenceIds = (prefix: string) => {
  let sequence = 0
  return {
    next: () => `${prefix}-${++sequence}`,
  }
}

test('retains one incident id across internal retries', () => {
  const factory = createIncidentFactory({ ids: sequenceIds('incident') })
  const incident = factory.fromFailure({
    domain: 'conversation',
    code: 'journal_write_failed',
    retryable: true,
  })
  expect(
    factory.retry(incident, {
      domain: 'conversation',
      code: 'journal_write_failed',
      retryable: true,
    }).incidentId,
  ).toBe(incident.incidentId)
})

test('classifies corruption as fatal and retryable storage as recoverable', () => {
  const factory = createIncidentFactory({ ids: sequenceIds('incident') })
  expect(
    factory.fromFailure({
      domain: 'conversation',
      code: 'journal_corrupt',
    }).severity,
  ).toBe('fatal')
  expect(
    factory.fromFailure({
      domain: 'conversation',
      code: 'temporary_io',
      retryable: true,
    }).severity,
  ).toBe('recoverable')
})
