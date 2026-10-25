/**
 * Rayern admin API proxy — the contract endpoints the dashboard frontend uses
 * for recipient selection and campaigns
 * (docs/ADMIN_DASHBOARD_BILLING_CONTRACT.md §4 and §5):
 *
 *   GET  /api/v1/admin/users              (page/limit/plan/subscriptionStatus/consent)
 *   POST /api/v1/admin/campaigns/preview  ({ audience })
 *   POST /api/v1/admin/campaigns/send     ({ subject, bodyHtml, audience, idempotencyKey })
 *
 * Design rules:
 *  - Requests and responses are forwarded VERBATIM to Rayern. No field is
 *    added, renamed or invented here; the dashboard speaks the contract.
 *  - Authorization and consent enforcement stay with Rayern. The audience
 *    selector is a request, never an authorization: Rayern resolves it inside
 *    the send call and revalidates consent per recipient, so this proxy can
 *    never widen the audience a caller may reach.
 *  - The browser never talks to Rayern directly and Rayern credentials never
 *    reach the frontend: the proxy authenticates server-side with the
 *    configured Rayern admin service account (RAYERN_API_BASE_URL +
 *    RAYERN_ADMIN_EMAIL + RAYERN_ADMIN_PASSWORD) and caches the short-lived
 *    session JWT, re-login-once on 401.
 *  - Unconfigured integration fails closed with 503 (never a silent empty
 *    audience), matching Rayern's own EMAIL_NOT_CONFIGURED behavior.
 */
import { Router } from 'express'
import type { Response as ExpressResponse } from 'express'
import { z } from 'zod'
import { config, rayernAdminProxyEnabled } from '../config'
import { requireAuth, requireAdmin } from '../auth'

const router = Router()

/* ------------------------------ Upstream auth ----------------------------- */

let cachedSession: { token: string; expiresAt: number } | null = null

/** Error carrying the HTTP status so responses can be mirrored faithfully. */
function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

/**
 * Extracts the session JWT from a Rayern login response. The contract documents
 * the login as the source of the admin access token but not the exact field
 * name, so the known envelope shapes are accepted defensively; an unrecognized
 * response fails loudly instead of silently issuing bad requests.
 */
function extractLoginToken(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const root = payload as Record<string, unknown>
  const candidates: unknown[] = [root.data, root]
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const obj = candidate as Record<string, unknown>
    for (const key of ['accessToken', 'token', 'access_token', 'jwt']) {
      const value = obj[key]
      // Accept any opaque token of plausible length (Rayern documents a JWT;
      // an empty/absent value must still fail loudly).
      if (typeof value === 'string' && value.trim().length >= 8) return value.trim()
    }
  }
  return null
}

/** Rayern access tokens live ~15 minutes; refresh a little before expiry. */
const SESSION_TTL_MS = 10 * 60_000

async function rayernSessionToken(): Promise<string> {
  if (cachedSession && cachedSession.expiresAt > Date.now()) return cachedSession.token

  const res = await fetch(`${config.rayern.apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.rayern.adminEmail, password: config.rayern.adminPassword }),
  })

  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }

  const token = res.ok ? extractLoginToken(payload) : null
  if (!token) {
    // Never log credentials or tokens — only the upstream status.
    throw statusError(
      res.status >= 400 && res.status < 600 ? res.status : 502,
      `Rayern admin login failed (HTTP ${res.status}); check RAYERN_ADMIN_EMAIL / RAYERN_ADMIN_PASSWORD`,
    )
  }

  cachedSession = { token, expiresAt: Date.now() + SESSION_TTL_MS }
  return token
}

interface UpstreamResponse {
  status: number
  payload: unknown
}

/** Forwards an authenticated request to Rayern, re-login once on 401. */
async function forwardToRayern(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<UpstreamResponse> {
  if (!rayernAdminProxyEnabled()) {
    throw statusError(
      503,
      'Rayern admin API is not configured (set RAYERN_API_BASE_URL, RAYERN_ADMIN_EMAIL and RAYERN_ADMIN_PASSWORD)',
    )
  }

  const call = async (): Promise<Response> => {
    const token = await rayernSessionToken()
    return fetch(`${config.rayern.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  let res = await call()
  if (res.status === 401) {
    // Session expired (or was rotated): drop the cached token and retry once.
    cachedSession = null
    res = await call()
  }

  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }

  if (payload === null) {
    throw statusError(502, `Rayern responded with an unreadable payload (HTTP ${res.status})`)
  }

  return { status: res.status, payload }
}

function relay(res: ExpressResponse, upstream: UpstreamResponse): void {
  // The Rayern envelope ({ success, data } / { success, error }) and its HTTP
  // status are passed through unchanged so the frontend sees the contract.
  res.status(upstream.status).json(upstream.payload)
}

/** Maps upstream/proxy failures onto the Rayern error envelope. */
function relayError(res: ExpressResponse, err: unknown): void {
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as { status: number }).status) : 502
  const message = err instanceof Error ? err.message : 'Unexpected error contacting the Rayern API'
  const code = status === 503 ? 'RAYERN_ADMIN_API_UNAVAILABLE' : 'RAYERN_UPSTREAM_ERROR'
  res.status(Number.isFinite(status) && status >= 400 && status < 600 ? status : 502).json({
    success: false,
    error: { code, message },
  })
}

/* ------------------------------- Validation -------------------------------- */

const Plan = z.enum(['starter', 'pro', 'business', 'premium'])
const SubscriptionStatus = z.enum(['none', 'active', 'non_renewing', 'past_due', 'canceled', 'expired'])

/**
 * Audience selector (contract §5.1). Zod strips anything outside this schema,
 * so a tampered body can never smuggle unknown fields upstream.
 */
const Audience = z.union([
  z.object({ type: z.literal('all_eligible') }),
  z.object({
    type: z.literal('filters'),
    plan: Plan.optional(),
    subscriptionStatus: SubscriptionStatus.optional(),
  }),
  z.object({
    type: z.literal('manual_emails'),
    emails: z
      .array(z.string().trim().min(3).max(254))
      .min(1)
      .max(500)
      .transform((emails) => [...new Set(emails.map((e) => e.toLowerCase()))]),
  }),
])

const UsersQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  plan: Plan.optional(),
  subscriptionStatus: SubscriptionStatus.optional(),
  consent: z.enum(['opted_in', 'opted_out']).optional(),
})

const PreviewBody = z.object({ audience: Audience })

const SendBody = z.object({
  subject: z.string().trim().min(1).max(200),
  bodyHtml: z.string().min(1).max(100_000),
  bodyText: z.string().max(200_000).optional(),
  audience: Audience,
  idempotencyKey: z.string().min(8).max(128).optional(),
})

/* --------------------------------- Routes ---------------------------------- */

router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = UsersQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid admin-users query (page ≥ 1, limit 1–100, plan/subscriptionStatus/consent from the contract enums)',
        },
      })
      return
    }
    const params = new URLSearchParams()
    if (parsed.data.page !== undefined) params.set('page', String(parsed.data.page))
    if (parsed.data.limit !== undefined) params.set('limit', String(parsed.data.limit))
    if (parsed.data.plan !== undefined) params.set('plan', parsed.data.plan)
    if (parsed.data.subscriptionStatus !== undefined) params.set('subscriptionStatus', parsed.data.subscriptionStatus)
    if (parsed.data.consent !== undefined) params.set('consent', parsed.data.consent)
    const qs = params.toString()
    relay(res, await forwardToRayern('GET', `/api/v1/admin/users${qs ? `?${qs}` : ''}`))
  } catch (err) {
    relayError(res, err)
  }
})

router.post('/admin/campaigns/preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = PreviewBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Body must be { audience } with a contract audience selector' },
      })
      return
    }
    relay(res, await forwardToRayern('POST', '/api/v1/admin/campaigns/preview', { audience: parsed.data.audience }))
  } catch (err) {
    relayError(res, err)
  }
})

router.post('/admin/campaigns/send', requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = SendBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Body must be { subject (≤200), bodyHtml (≤100000), audience, idempotencyKey? (≥8 chars) }',
        },
      })
      return
    }
    // Idempotency travels in the body (contract §5.3) so Rayern replays a
    // duplicate send instead of dispatching twice.
    relay(res, await forwardToRayern('POST', '/api/v1/admin/campaigns/send', parsed.data))
  } catch (err) {
    relayError(res, err)
  }
})

export default router
