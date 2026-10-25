import { apiRequest, buildQuery, USE_DEMO_DATA } from '../lib/api'
import type {
  CampaignComposePayload,
  CampaignPreview,
  CampaignSendResult,
  ConsentStatus,
  ConsentSummary,
  DirectoryEntry,
  DirectoryFilters,
  MarketingMetrics,
  Paged,
} from '../lib/types'
import { buildMarketingDirectory, buildMarketingMetrics, buildUsers } from './demoData'

/**
 * Marketing domain service — consent-gated campaign operations.
 *
 * API contract (verified against the dashboard backend): the base URL comes
 * from VITE_ADMIN_API_URL and routes are ROOT-MOUNTED — there is NO /api/v1
 * (or any other) prefix. Paths here are appended verbatim by apiRequest, the
 * same client (and Bearer-token interceptor) every other service uses.
 */
const demoDirectory = buildMarketingDirectory(buildUsers())

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export const marketingService = {
  /** Aggregate consent + campaign KPIs (GET /marketing/metrics). */
  metrics(): Promise<MarketingMetrics> {
    if (USE_DEMO_DATA) return delay(buildMarketingMetrics(demoDirectory))
    return apiRequest<MarketingMetrics>('/marketing/metrics')
  },

  /** Account directory with consent state (GET /marketing/directory). */
  directory(
    filters: DirectoryFilters & { page?: number; pageSize?: number },
  ): Promise<Paged<DirectoryEntry>> {
    if (USE_DEMO_DATA) {
      const search = filters.search?.trim().toLowerCase() ?? ''
      const filtered = demoDirectory.filter((d) => {
        if (filters.consent && filters.consent !== 'all' && d.consent !== filters.consent) return false
        if (search && !`${d.name} ${d.email}`.toLowerCase().includes(search)) return false
        return true
      })
      const page = filters.page ?? 1
      const pageSize = filters.pageSize ?? 25
      const start = (page - 1) * pageSize
      return delay({
        items: filtered.slice(start, start + pageSize),
        total: filtered.length,
        page,
        pageSize,
      })
    }
    return apiRequest<Paged<DirectoryEntry>>(`/marketing/directory${buildQuery({ ...filters })}`)
  },

  /** Consent summary counts (GET /marketing/consent). */
  consent(): Promise<ConsentSummary> {
    if (USE_DEMO_DATA) {
      const m = buildMarketingMetrics(demoDirectory)
      return delay({ ...m.consent, mailable: m.mailable, total: demoDirectory.length })
    }
    return apiRequest<ConsentSummary>('/marketing/consent')
  },

  /** Record an explicit consent decision (PATCH /marketing/consent/:accountId). */
  setConsent(
    accountId: string,
    status: ConsentStatus,
  ): Promise<{ id: string; consent: ConsentStatus; consentUpdatedAt: string }> {
    if (USE_DEMO_DATA) {
      const row = demoDirectory.find((d) => d.id === accountId)
      if (row) {
        row.consent = status
        row.consentUpdatedAt = status === 'unknown' ? null : new Date().toISOString()
      }
      return delay({ id: accountId, consent: status, consentUpdatedAt: new Date().toISOString() })
    }
    return apiRequest<{ id: string; consent: ConsentStatus; consentUpdatedAt: string }>(
      `/marketing/consent/${accountId}`,
      { method: 'PATCH', body: { status } },
    )
  },

  /** Server-side preview: sanitized body + live audience counts. */
  previewCampaign(payload: CampaignComposePayload): Promise<CampaignPreview> {
    if (USE_DEMO_DATA) {
      return delay({
        subject: payload.subject,
        bodyType: payload.bodyType,
        type: payload.type,
        from: 'Rayern <support@rayern.com.ng>',
        body: payload.message,
        wrappedHtml:
          payload.bodyType === 'html'
            ? '<!doctype html><html><head><meta charset="utf-8"></head><body>' + payload.message + '</body></html>'
            : null,
        audience: {
          mailable: demoDirectory.filter((d) => d.consent === 'opted_in' && d.status === 'active').length,
          optedOut: demoDirectory.filter((d) => d.consent === 'opted_out').length,
          unknown: demoDirectory.filter((d) => d.consent === 'unknown').length,
        },
      }, 400)
    }
    return apiRequest<CampaignPreview>('/marketing/campaigns/preview', { method: 'POST', body: payload })
  },

  /**
   * Sends a campaign to every active account with an explicit opt-in. The
   * audience is resolved server-side — the client can never choose recipients.
   * A client-generated idempotency key makes a retried/double-clicked send
   * replay the original result instead of sending twice.
   */
  sendCampaign(payload: CampaignComposePayload): Promise<CampaignSendResult> {
    if (USE_DEMO_DATA) {
      const audience = demoDirectory.filter((d) => d.consent === 'opted_in' && d.status === 'active')
      return delay(
        {
          id: `mc_${Date.now().toString(36)}`,
          recipientCount: audience.length,
          status: 'sent',
          sentAt: new Date().toISOString(),
        },
        420,
      )
    }
    return apiRequest<CampaignSendResult>('/marketing/campaigns/send', { method: 'POST', body: payload })
  },
}
