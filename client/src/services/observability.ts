import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { ObservabilityOverview } from '../lib/types'
import { buildObservability } from './demoData'

function delay<T>(value: T, ms = 260): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/** Observability service — answers "what is the software doing?" (OpenTelemetry-backed later). */
export const observabilityService = {
  overview(): Promise<ObservabilityOverview> {
    if (USE_DEMO_DATA) return delay(buildObservability())
    return apiRequest<ObservabilityOverview>('/observability/overview')
  },
}
