import type { IdGenerator } from './contracts'

export type StateIncidentDomain =
  | 'conversation'
  | 'session'
  | 'search'
  | 'maintenance'

export type StateIncidentSeverity =
  | 'debug'
  | 'recoverable'
  | 'action_required'
  | 'fatal'

export type StateIncident = {
  incidentId: string
  domain: StateIncidentDomain
  code: string
  severity: StateIncidentSeverity
  commandId?: string
  correlationId?: string
  aggregateId?: string
  retryable: boolean
  cause?: unknown
}

export type RawStateFailure = {
  domain: StateIncidentDomain
  code: string
  severity?: StateIncidentSeverity
  commandId?: string
  correlationId?: string
  aggregateId?: string
  retryable?: boolean
  cause?: unknown
}

export type StateIncidentFactory = {
  fromFailure(failure: RawStateFailure): StateIncident
  retry(incident: StateIncident, failure: RawStateFailure): StateIncident
}

const isStateIncident = (value: unknown): value is StateIncident =>
  typeof value === 'object' &&
  value !== null &&
  'incidentId' in value &&
  typeof (value as { incidentId?: unknown }).incidentId === 'string'

const inferSeverity = (failure: RawStateFailure): StateIncidentSeverity => {
  if (failure.severity) return failure.severity
  if (/corrupt|integrity|schema|fatal/i.test(failure.code)) return 'fatal'
  if (failure.retryable) return 'recoverable'
  return 'action_required'
}

const nextId = (ids: IdGenerator | (() => string)): string =>
  typeof ids === 'function' ? ids() : ids.next('incident')

export const createIncidentFactory = (input: {
  ids: IdGenerator | (() => string)
}): StateIncidentFactory => {
  const fromFailure = (failure: RawStateFailure): StateIncident => {
    if (isStateIncident(failure)) return failure
    return {
      incidentId: nextId(input.ids),
      domain: failure.domain,
      code: failure.code,
      severity: inferSeverity(failure),
      commandId: failure.commandId,
      correlationId: failure.correlationId,
      aggregateId: failure.aggregateId,
      retryable: failure.retryable ?? false,
      cause: failure.cause,
    }
  }

  return {
    fromFailure,
    retry: (incident, failure) => ({
      ...fromFailure(failure),
      incidentId: incident.incidentId,
      severity: incident.severity,
      domain: incident.domain,
      code: incident.code,
    }),
  }
}
