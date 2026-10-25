import { adminMetrics } from '../lib/api'
import type { AdminMetricBilling, AdminMetricResponse } from '../lib/types'

export type BillingViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | {
      kind: 'populated'
      billing: AdminMetricBilling
    }

export async function billingState(): Promise<BillingViewState> {
  try {
    const response = await adminMetrics()

    if (!response.success) {
      return { kind: 'error', message: String(response.error?.message ?? 'Metrics request failed') }
    }

    const billing = response.data.billing
    if (!billing) {
      return { kind: 'unavailable' }
    }

    return { kind: 'populated', billing }
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'Failed to load billing metrics' }
  }
}
