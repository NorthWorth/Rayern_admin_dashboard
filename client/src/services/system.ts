import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { SystemOverview } from '../lib/types'
import { buildSystemOverview } from './demoData'

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export const systemService = {
  overview(): Promise<SystemOverview> {
    if (USE_DEMO_DATA) return delay(buildSystemOverview())
    return apiRequest<SystemOverview>('/system/overview')
  },
}
