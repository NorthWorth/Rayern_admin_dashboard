import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { HealthTransition, HistoryRange, ServiceHistory, SystemOverview } from '../lib/types'
import { buildServiceHistory, buildSystemOverview, buildTransitions } from './demoData'

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export const systemService = {
  overview(): Promise<SystemOverview> {
    if (USE_DEMO_DATA) return delay(buildSystemOverview())
    return apiRequest<SystemOverview>('/system/overview')
  },

  /** Drill-down time series: platform → service → metric → time range. */
  history(service: string, range: HistoryRange): Promise<ServiceHistory> {
    if (USE_DEMO_DATA) return delay(buildServiceHistory(service, range), 200)
    return apiRequest<ServiceHistory>(
      `/system/history?service=${encodeURIComponent(service)}&range=${range}`,
    )
  },

  /** Deduplicated health-state transitions for the selected range. */
  transitions(range: HistoryRange = '24h', service?: string): Promise<HealthTransition[]> {
    if (USE_DEMO_DATA) return delay(buildTransitions(range), 200)
    const params = new URLSearchParams({ range })
    if (service) params.set('service', service)
    return apiRequest<HealthTransition[]>(`/system/transitions?${params.toString()}`)
  },
}
