import type { StateIncident } from '../state/stateIncident'

export type NotificationDecision =
  | { action: 'ignore' }
  | { action: 'inline'; incident: StateIncident }
  | { action: 'notice'; incident: StateIncident; dedupeKey: string }

export class UserNotificationPolicy {
  private readonly noticedIncidentIds = new Set<string>()
  private readonly semanticKeys = new Set<string>()
  private readonly semanticCapacity: number

  constructor(input: { semanticCapacity?: number } = {}) {
    this.semanticCapacity = Math.max(1, input.semanticCapacity ?? 256)
  }

  handle(incident: StateIncident): NotificationDecision {
    if (incident.severity === 'debug' || incident.severity === 'recoverable') {
      return { action: 'inline', incident }
    }

    const dedupeKey = [
      incident.domain,
      incident.code,
      incident.aggregateId ?? '',
      incident.commandId ?? '',
    ].join(':')
    if (
      this.noticedIncidentIds.has(incident.incidentId) ||
      this.semanticKeys.has(dedupeKey)
    ) {
      return { action: 'ignore' }
    }

    this.noticedIncidentIds.add(incident.incidentId)
    this.semanticKeys.add(dedupeKey)
    while (this.semanticKeys.size > this.semanticCapacity) {
      const oldest = this.semanticKeys.values().next().value
      if (oldest === undefined) break
      this.semanticKeys.delete(oldest)
    }
    return { action: 'notice', incident, dedupeKey }
  }

  clear(incidentId: string): void {
    this.noticedIncidentIds.add(incidentId)
  }
}
