import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { PlatformMetricsOverview } from '../lib/types'
import { buildPlatformMetrics, buildUsers, buildWorkspaces } from './demoData'

function delay<T>(value: T, ms = 260): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/**
 * Platform metrics service — privacy-safe aggregate statistics only.
 * Answers "how is Rayern doing as a platform?" without exposing
 * how any individual customer uses the product.
 */
export const platformMetricsService = {
  overview(): Promise<PlatformMetricsOverview> {
    if (USE_DEMO_DATA) {
      return delay(buildPlatformMetrics(buildUsers(), buildWorkspaces()))
    }
    return apiRequest<PlatformMetricsOverview>('/platform-metrics/overview')
  },
}
