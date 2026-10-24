import type { AdminMetricBilling } from './types'
import { readSyncedAggregates } from './rayernSync'

/**
 * Billing service for the dashboard.
 *
 * Rayern is the source of truth for billing. The dashboard consumes the
 * billing block persisted by the Rayern pull-sync worker and never
 * recalculates MRR/ARR/subscriber counts from local account records.
 *
 * When no billing data has been synchronized yet, this service returns null
 * so the frontend can render an explicit unavailable state instead of
 * presenting missing data as zero revenue or zero subscribers.
 */
export const billingService = {
  async current(): Promise<AdminMetricBilling | null> {
    const synced = await readSyncedAggregates()
    return synced.billing ?? null
  },

  /** Explicit "no data yet" sentinel for the frontend. */
  async hasBillingData(): Promise<boolean> {
    const synced = await readSyncedAggregates()
    return Boolean(synced.billing)
  },
}
