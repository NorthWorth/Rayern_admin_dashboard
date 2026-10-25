import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { AuditEvent, AuditFilters } from '../lib/types'
import { buildAuditEvents } from './demoData'

const demoEvents = buildAuditEvents()

function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function filterEvents(list: AuditEvent[], filters: AuditFilters): AuditEvent[] {
  const search = filters.search?.trim().toLowerCase()
  return list.filter((e) => {
    if (filters.actorKind && filters.actorKind !== 'all' && e.actorKind !== filters.actorKind) return false
    if (search) {
      const haystack = `${e.actor} ${e.action} ${e.target} ${Object.values(e.metadata).join(' ')}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

export const auditService = {
  list(filters: AuditFilters = {}): Promise<AuditEvent[]> {
    if (USE_DEMO_DATA) return delay(filterEvents(demoEvents, filters))
    return apiRequest<AuditEvent[]>('/audit')
  },
}
