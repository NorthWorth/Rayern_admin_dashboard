import { apiRequest, buildQuery, USE_DEMO_DATA } from '../lib/api'
import type {
  AdminUserFilters,
  AdminUserRecord,
  AdminUsersPage,
  CampaignComposePayload,
  CampaignPreviewResponse,
  CampaignSendResponse,
} from '../lib/types'

/**
 * Campaign domain service — Rayern admin endpoints for recipient selection,
 * audience preview and campaign send (docs/ADMIN_DASHBOARD_BILLING_CONTRACT.md
 * §4 and §5).
 *
 * The dashboard backend proxies these paths verbatim to the Rayern backend
 * (server/src/routes/rayernAdmin.ts); request and response shapes are exactly
 * the contract's — no fields are added or invented here. Consent eligibility is
 * revalidated by Rayern inside the send call, so a selector from this client is
 * a request, never an authorization.
 */

interface Envelope<T> {
  success: boolean
  data?: T
  error?: { code?: string; message?: string }
}

function unwrap<T>(response: Envelope<T>): T {
  if (!response.success || response.data === undefined || response.data === null) {
    throw new Error(response.error?.message ?? 'Rayern request failed')
  }
  return response.data
}

/* ------------------------------- Demo fixture ----------------------------- */
/* Demo-mode only (banner-labelled). Never used when VITE_ADMIN_API_URL is set. */

interface DemoUser extends AdminUserRecord {
  firstName: string
  lastName: string
  accountStatus: 'active' | 'suspended'
}

const DEMO_USERS: DemoUser[] = [
  { id: 'd1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', accountStatus: 'active', createdAt: '2026-09-01T00:00:00.000Z', marketingConsent: { optedIn: true, source: 'settings' }, workspace: { name: 'Ada WS', plan: 'pro' }, subscription: { plan: 'pro', status: 'active', billingInterval: 'monthly', hasPaidAccess: true } },
  { id: 'd2', email: 'grace@example.com', firstName: 'Grace', lastName: 'Hopper', accountStatus: 'active', createdAt: '2026-09-05T00:00:00.000Z', marketingConsent: { optedIn: true, source: 'unsubscribe_link' }, workspace: { name: 'Grace WS', plan: 'premium' }, subscription: { plan: 'premium', status: 'active', billingInterval: 'annual', hasPaidAccess: true } },
  { id: 'd3', email: 'alan@example.com', firstName: 'Alan', lastName: 'Turing', accountStatus: 'active', createdAt: '2026-09-11T00:00:00.000Z', marketingConsent: { optedIn: false, source: 'settings' }, workspace: { name: 'Alan WS', plan: 'pro' }, subscription: { plan: 'pro', status: 'canceled', billingInterval: 'monthly', hasPaidAccess: false } },
  { id: 'd4', email: 'katherine@example.com', firstName: 'Katherine', lastName: 'Johnson', accountStatus: 'active', createdAt: '2026-09-18T00:00:00.000Z', marketingConsent: null, workspace: { name: 'KJ WS', plan: 'starter' }, subscription: null },
  { id: 'd5', email: 'linus@example.com', firstName: 'Linus', lastName: 'Torvalds', accountStatus: 'active', createdAt: '2026-10-01T00:00:00.000Z', marketingConsent: { optedIn: true, source: 'settings' }, workspace: { name: 'Linus WS', plan: 'business' }, subscription: { plan: 'business', status: 'past_due', billingInterval: 'monthly', hasPaidAccess: true } },
  { id: 'd6', email: 'margaret@example.com', firstName: 'Margaret', lastName: 'Hamilton', accountStatus: 'suspended', createdAt: '2026-10-04T00:00:00.000Z', marketingConsent: { optedIn: true, source: 'settings' }, workspace: { name: 'Margaret WS', plan: 'pro' }, subscription: { plan: 'pro', status: 'active', billingInterval: 'monthly', hasPaidAccess: true } },
  { id: 'd7', email: 'dennis@example.com', firstName: 'Dennis', lastName: 'Ritchie', accountStatus: 'active', createdAt: '2026-10-09T00:00:00.000Z', marketingConsent: { optedIn: false, source: 'settings' }, workspace: { name: 'Dennis WS', plan: 'starter' }, subscription: null },
  { id: 'd8', email: 'barbara@example.com', firstName: 'Barbara', lastName: 'Liskov', accountStatus: 'active', createdAt: '2026-10-15T00:00:00.000Z', marketingConsent: { optedIn: true, source: 'settings' }, workspace: { name: 'Barbara WS', plan: 'starter' }, subscription: null },
]

function demoMatches(user: DemoUser, filters: AdminUserFilters): boolean {
  const plan = user.subscription?.plan ?? 'starter'
  const status = user.subscription?.status ?? 'none'
  const optedIn = user.marketingConsent?.optedIn === true
  if (filters.plan && filters.plan !== 'all' && plan !== filters.plan) return false
  if (filters.subscriptionStatus && filters.subscriptionStatus !== 'all' && status !== filters.subscriptionStatus) return false
  if (filters.consent && filters.consent !== 'all' && (filters.consent === 'opted_in') !== optedIn) return false
  if (user.accountStatus !== 'active') return false
  return true
}

function demoResolveAudience(
  audience: CampaignComposePayload['audience'],
  filters: AdminUserFilters = {},
): { matched: DemoUser[]; skipped: Array<{ email: string; reason: string }> } {
  if (audience.type === 'all_eligible') {
    const matched = DEMO_USERS.filter((u) => demoMatches(u, { ...filters, consent: 'opted_in' }))
    const skipped = DEMO_USERS.filter((u) => !matched.includes(u)).map((u) => ({
      email: u.email,
      reason: u.accountStatus !== 'active' ? 'account_suspended' : 'not_opted_in',
    }))
    return { matched, skipped }
  }
  if (audience.type === 'filters') {
    const base: AdminUserFilters = {
      plan: audience.plan ?? filters.plan,
      subscriptionStatus: audience.subscriptionStatus ?? filters.subscriptionStatus,
      consent: filters.consent ?? 'opted_in',
    }
    const matched = DEMO_USERS.filter((u) => demoMatches(u, base))
    const skipped = DEMO_USERS.filter((u) => demoMatches(u, { ...base, consent: 'all' }) && !matched.includes(u)).map((u) => ({
      email: u.email,
      reason: 'not_opted_in',
    }))
    return { matched, skipped }
  }
  const matched: DemoUser[] = []
  const skipped: Array<{ email: string; reason: string }> = []
  for (const email of audience.emails) {
    const user = DEMO_USERS.find((u) => u.email.toLowerCase() === email.toLowerCase())
    if (!user) {
      skipped.push({ email, reason: 'unknown_address' })
      continue
    }
    if (user.accountStatus !== 'active') {
      skipped.push({ email, reason: 'account_suspended' })
      continue
    }
    if (user.marketingConsent?.optedIn !== true) {
      skipped.push({ email, reason: 'not_opted_in' })
      continue
    }
    matched.push(user)
  }
  return { matched, skipped }
}

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function demoPage(filters: AdminUserFilters): AdminUsersPage {
  const rows = DEMO_USERS.filter((u) => demoMatches(u, filters))
  const page = filters.page ?? 1
  const limit = filters.limit ?? 50
  const start = (page - 1) * limit
  return {
    pagination: {
      page,
      limit,
      totalResults: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / limit)),
    },
    filters: {
      plan: filters.plan && filters.plan !== 'all' ? filters.plan : null,
      subscriptionStatus:
        filters.subscriptionStatus && filters.subscriptionStatus !== 'all' ? filters.subscriptionStatus : null,
      consent: filters.consent && filters.consent !== 'all' ? filters.consent : null,
    },
    currency: 'USD',
    users: rows.slice(start, start + limit),
  }
}

/* -------------------------------- Service --------------------------------- */

export const campaignsService = {
  /**
   * `GET /api/v1/admin/users` (§4) — directory with `plan`,
   * `subscriptionStatus` and `consent` filters for recipient selection.
   */
  async listUsers(filters: AdminUserFilters = {}): Promise<AdminUsersPage> {
    if (USE_DEMO_DATA) return delay(demoPage(filters))
    const query = buildQuery({
      page: filters.page ?? 1,
      limit: filters.limit ?? 50,
      plan: filters.plan && filters.plan !== 'all' ? filters.plan : undefined,
      subscriptionStatus:
        filters.subscriptionStatus && filters.subscriptionStatus !== 'all' ? filters.subscriptionStatus : undefined,
      consent: filters.consent && filters.consent !== 'all' ? filters.consent : undefined,
    })
    const response = await apiRequest<Envelope<AdminUsersPage>>(`/api/v1/admin/users${query}`)
    return unwrap(response)
  },

  /**
   * `POST /api/v1/admin/campaigns/preview` (§5.2) — what this audience WOULD
   * reach, resolved and consent-checked server-side. Sends nothing.
   */
  async preview(audience: CampaignComposePayload['audience']): Promise<CampaignPreviewResponse> {
    if (USE_DEMO_DATA) {
      const { matched, skipped } = demoResolveAudience(audience)
      return delay(
        {
          audience,
          eligibleCount: matched.length,
          skippedCount: skipped.length,
          sizeCap: 2000,
          capped: false,
          preview: matched.slice(0, 20).map((u) => ({ email: u.email })),
          previewTruncated: matched.length > 20,
          skipped: skipped.map((s) => ({ email: s.email, reason: s.reason })),
        } as CampaignPreviewResponse,
        320,
      )
    }
    const response = await apiRequest<Envelope<CampaignPreviewResponse>>('/api/v1/admin/campaigns/preview', {
      method: 'POST',
      body: { audience },
    })
    return unwrap(response)
  },

  /**
   * `POST /api/v1/admin/campaigns/send` (§5.3) — sends to the audience the
   * SERVER resolves; recipients that fail consent revalidation come back in
   * `campaign.skipped` and are never delivered to.
   */
  async send(payload: CampaignComposePayload): Promise<CampaignSendResponse> {
    if (USE_DEMO_DATA) {
      const { matched, skipped } = demoResolveAudience(payload.audience)
      return delay(
        {
          duplicate: false,
          campaign: {
            id: `cmp_demo_${Date.now().toString(36)}`,
            status: skipped.length > 0 ? 'completed_with_failures' : 'completed',
            subject: payload.subject,
            audience: payload.audience,
            totals: {
              resolved: matched.length + skipped.length,
              accepted: matched.length,
              failed: 0,
              skipped: skipped.length,
            },
            accepted: matched.map((u) => ({ email: u.email, providerMessageId: `demo-${u.id}` })),
            failed: [],
            skipped: skipped.map((s) => ({ email: s.email, reason: s.reason })),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        } as CampaignSendResponse,
        420,
      )
    }
    const response = await apiRequest<Envelope<CampaignSendResponse>>('/api/v1/admin/campaigns/send', {
      method: 'POST',
      body: payload,
    })
    return unwrap(response)
  },
}
