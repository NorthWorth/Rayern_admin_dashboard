import { adminMetrics, USE_DEMO_DATA } from '../lib/api'
import type { AdminMetricBilling } from '../lib/types'

/**
 * Revenue domain service.
 *
 * Rayern is the source of truth for billing. The dashboard only reads the
 * `billing` block of `GET /api/v1/admin/metrics` (contract §2.3) and renders it
 * verbatim — MRR/ARR are never estimated, derived or recalculated here, and a
 * missing block is reported as `unavailable` rather than as zero revenue.
 */
export type RevenueState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'populated'; billing: AdminMetricBilling; syncedAt: string | null }

/** Demo-only billing block (banner-labelled demo data; never a real figure). */
const DEMO_BILLING: AdminMetricBilling = {
  currency: 'USD',
  amountUnit: 'minor_units',
  generatedAt: '2026-10-22T12:00:00.000Z',
  activePaidSubscribers: 14,
  freeUsers: 109,
  totalAccounts: 123,
  mrr: {
    amountMinor: 41320,
    amountMajor: 413.2,
    byPlan: [
      { plan: 'pro', subscriberCount: 10, mrrMinor: 19000 },
      { plan: 'premium', subscriberCount: 4, mrrMinor: 25280 },
    ],
  },
  arr: { amountMinor: 495840, amountMajor: 4958.4, definition: 'mrr_x_12' },
  planBreakdown: [
    { plan: 'pro', userCount: 10, subscriptionCount: 10, isPaid: true },
    { plan: 'premium', userCount: 4, subscriptionCount: 4, isPaid: true },
    { plan: 'starter', userCount: 109, subscriptionCount: 0, isPaid: false },
  ],
  definitions: {
    mrr: 'highest-paying qualifying plan per subscriber; annual plans normalized to monthly',
    arr: 'mrr_x_12',
  },
}

export const revenueService = {
  /**
   * Resolves the view state for the Revenue page:
   *  - `unavailable` — the metrics payload has no billing block (sync has not
   *    produced billing data yet); shown honestly, never as zeros.
   *  - `error` — the request or the metrics envelope failed.
   *  - `populated` — Rayern's billing block, unmodified.
   */
  async state(): Promise<RevenueState> {
    if (USE_DEMO_DATA) {
      return { kind: 'populated', billing: DEMO_BILLING, syncedAt: DEMO_BILLING.generatedAt }
    }

    try {
      const response = await adminMetrics()

      if (!response.success) {
        return { kind: 'error', message: String(response.error?.message ?? 'Metrics request failed') }
      }

      const billing = response.data?.billing ?? null
      if (!billing) {
        return { kind: 'unavailable' }
      }

      return { kind: 'populated', billing, syncedAt: null }
    } catch (err) {
      return {
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load revenue metrics',
      }
    }
  },
}
