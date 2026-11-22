import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { SchedulerStatusResponse, SystemOverview } from '../lib/types'
import { buildSystemOverview } from './demoData'

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export const systemService = {
  overview(): Promise<SystemOverview> {
    if (USE_DEMO_DATA) return delay(buildSystemOverview())
    return apiRequest<SystemOverview>('/system/overview')
  },
  /**
   * Independent scheduler status, proxied server-side by the dashboard
   * backend — the browser never talks to the scheduler and holds no token.
   */
  scheduler(): Promise<SchedulerStatusResponse> {
    if (USE_DEMO_DATA) {
      return delay({
        configured: false,
        reachable: false,
        reason: 'Demo mode — no dashboard backend is connected.',
        checkedAt: new Date().toISOString(),
        status: null,
      })
    }
    return apiRequest<SchedulerStatusResponse>('/system/scheduler')
  },
}
