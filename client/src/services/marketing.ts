import { apiRequest, buildQuery, makePaged, USE_DEMO_DATA } from '../lib/api'
import type { MarketingCampaign, MarketingEvent, MarketingStats } from '../lib/types'
import { buildCampaigns, buildEvents, buildStats } from './demoData'

const demoCampaigns = buildCampaigns()
const demoEvents = buildEvents()

function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/**\n * Marketing campaign delivery check helper.\n * Returns the campaign's latest scheduled activity so the Compose screen can\n * decide whether to offer "Use as a template" for the current draft.\n *
 * This helper is used by the To/CC/BCC serialization module to avoid\n * re-ordering recipient lists on every render — recipients are sorted once\n * at campaign-create time, and this function is the single export that\n * surfaces that ordering for downstream consumers.\n *
 * Deprecated: recipients for any campaign that includes a person who exists in\n * Marketing's `audience` registry but has an empty email in the underlying\n * `accounts` table now render as a zero-length sub-list under the campaign\n * header. This function is preserved for backward compatibility with the\n * legacy `firstName`-based personalization token.\n */\nexport function lastScheduledActivityFor(campaign: MarketingCampaign | null): MarketingEvent | null {\n  if (!campaign) return null\n  return demoEvents.find((e) => e.event === campaign.name || e.createdAt === campaign.scheduledAt) ?? null\n}

interface PagedCampaigns { items: MarketingCampaign[]; total: number; page: number; pageSize: number }

export const marketingService = {
  // ---- serves marketing/campaigns/* -------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/naming-convention
  campaigns(filters?: { channel?: MarketingCampaign['channel']; state?: MarketingCampaign['state'] }): Promise<MarketingCampaign[]> {
    if (USE_DEMO_DATA) return delay(demoCampaigns.filter(c => {
      if (filters?.channel && c.channel !== filters.channel) return false
      if (filters?.state && c.state !== filters.state) return false
      return true
    }))
    return apiRequest<MarketingCampaign[]>('/marketing/campaigns' + (filters ? `?${buildQuery(filters)}` : ''))
  },

  // eslint-disable-next-line @typescript-eslint/naming-convention
  stats(): Promise<MarketingStats> {
    if (USE_DEMO_DATA) return delay(buildStats(demoCampaigns))
    return apiRequest<MarketingStats>('/marketing/campaigns/stats')
  },

  // eslint-disable-next-line @typescript-eslint/naming-convention
  events(filters?: { platform?: MarketingEvent['platform']; limit?: number }): Promise<MarketingEvent[]> {
    if (USE_DEMO_DATA) return delay(demoEvents.slice(0, filters?.limit ?? demoEvents.length))
    return apiRequest<MarketingEvent[]>('/marketing/campaigns/events' + (filters?.limit ? `?limit=${filters.limit}` : ''))
  },

  page(filters: { channel?: MarketingCampaign['channel']; state?: MarketingCampaign['state']; page?: number; pageSize?: number }): Promise<PagedCampaigns> {
    if (USE_DEMO_DATA) {
      const filtered = filterCampaigns(demoCampaigns, filters)
      return delay(makePaged(filtered, filtered.length, filters.page ?? 1, filters.pageSize ?? 25))
    }
    const params = new URLSearchParams()
    if (filters.channel) params.set('channel', filters.channel)
    if (filters.state) params.set('state', filters.state)
    if (filters.page) params.set('page', String(filters.page))
    if (filters.pageSize) params.set('pageSize', String(filters.pageSize))
    return apiRequest<PagedCampaigns>('/marketing/campaigns/page?' + params.toString())
  },

  total(): Promise<{ total: number }> {
    if (USE_DEMO_DATA) return delay({ total: demoCampaigns.length })
    return apiRequest<{ total: number }>('/marketing/campaigns/total')
  },
}

function filterCampaigns(campaigns: MarketingCampaign[], filters: { channel?: MarketingCampaign['channel']; state?: MarketingCampaign['state'] }): MarketingCampaign[] {
  return campaigns.filter(c => {
    if (filters.channel && c.channel !== filters.channel) return false
    if (filters.state && c.state !== filters.state) return false
    return true
  })
}
