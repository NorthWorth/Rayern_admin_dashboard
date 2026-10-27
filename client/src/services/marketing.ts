import { apiRequest, USE_DEMO_DATA } from '../lib/api'

/**
 * Marketing KPIs from the dashboard backend (`GET /marketing/metrics`):
 * aggregate consent counts and campaign totals. Recipient lists never leave
 * the server through this endpoint.
 */
export interface MarketingMetrics {
  consent: { optedIn: number; optedOut: number; unknown: number }
  mailable: number
  campaigns: {
    total: number
    sent30d: number
    recipients30d: number
    lastSentAt: string | null
  }
  recentCampaigns: Array<{
    id: string
    subject: string
    type: string
    bodyType: 'text' | 'html'
    audienceCount: number
    providerMessages: number
    status: string
    sentBy: string
    sentAt: string
  }>
}

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

const DEMO_METRICS: MarketingMetrics = {
  consent: { optedIn: 612, optedOut: 84, unknown: 3910 },
  mailable: 588,
  campaigns: { total: 12, sent30d: 3, recipients30d: 1810, lastSentAt: new Date(Date.now() - 6 * 86400000).toISOString() },
  recentCampaigns: [],
}

export const marketingService = {
  metrics(): Promise<MarketingMetrics> {
    if (USE_DEMO_DATA) return delay(DEMO_METRICS)
    return apiRequest<MarketingMetrics>('/marketing/metrics')
  },
}
