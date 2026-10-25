/**
 * Verifies the dashboard→Rayern admin proxy (contract §4/§5):
 *  - dashboard admin auth is required before anything reaches Rayern,
 *  - documented query/body schemas are validated (unknown values → 400),
 *  - requests/responses are forwarded verbatim (audience selector, envelope,
 *    201 status, per-recipient skip reasons from Rayern's consent revalidation),
 *  - an unconfigured integration fails closed with 503.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RequestHandler } from 'express'

interface RecordedRequest {
  method: string
  url: string
  auth: string | null
  body: unknown
}

const requests: RecordedRequest[] = []
let upstream: Server
let upstreamBase = ''
let apiBase = ''
let appServer: Server
let adminToken = ''
let authenticate: RequestHandler

const UPSTREAM_TOKEN = 'rayern.session.jwt.value'

async function listen(server: Server): Promise<number> {
  if (server.listening) return (server.address() as AddressInfo).port
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

/** Issues an authenticated request against the dashboard test app. */
function api(path: string, init: RequestInit = {}, token: string | null = adminToken): Promise<Response> {
  return fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
}

beforeAll(async () => {
  // Mock Rayern backend: login + the two admin endpoints under test.
  upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      requests.push({
        method: req.method ?? '',
        url: `${url.pathname}${url.search}`,
        auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
        body,
      })
      res.setHeader('Content-Type', 'application/json')

      if (url.pathname === '/api/v1/auth/login') {
        if (body?.email !== 'admin@rayern.test' || body?.password !== 'correct-horse') {
          res.statusCode = 401
          res.end(JSON.stringify({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Bad login' } }))
          return
        }
        res.end(JSON.stringify({ success: true, data: { accessToken: UPSTREAM_TOKEN } }))
        return
      }

      if (req.headers.authorization !== `Bearer ${UPSTREAM_TOKEN}`) {
        res.statusCode = 401
        res.end(JSON.stringify({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Token rejected' } }))
        return
      }

      if (url.pathname === '/api/v1/admin/users') {
        res.end(
          JSON.stringify({
            success: true,
            data: {
              pagination: { page: 1, limit: 50, totalResults: 1, totalPages: 1 },
              filters: {
                plan: url.searchParams.get('plan'),
                subscriptionStatus: url.searchParams.get('subscriptionStatus'),
                consent: url.searchParams.get('consent'),
              },
              currency: 'USD',
              users: [{ id: 'u1', email: 'ada@example.com', marketingConsent: { optedIn: true } }],
            },
          }),
        )
        return
      }

      if (url.pathname === '/api/v1/admin/campaigns/preview') {
        res.end(
          JSON.stringify({
            success: true,
            data: {
              audience: body?.audience,
              eligibleCount: 1,
              skippedCount: 1,
              sizeCap: 2000,
              capped: false,
              preview: [{ email: 'ada@example.com' }],
              previewTruncated: false,
              skipped: [{ email: 'x@external.test', reason: 'unknown_address' }],
            },
          }),
        )
        return
      }

      if (url.pathname === '/api/v1/admin/campaigns/send') {
        res.statusCode = 201
        res.end(
          JSON.stringify({
            success: true,
            data: {
              duplicate: false,
              campaign: {
                id: 'c1',
                status: 'completed_with_failures',
                subject: body?.subject,
                audience: body?.audience,
                totals: { resolved: 2, accepted: 1, failed: 0, skipped: 1 },
                accepted: [{ email: 'ada@example.com', providerMessageId: 'pm1' }],
                failed: [],
                skipped: [{ email: 'alan@example.com', reason: 'not_opted_in' }],
              },
            },
          }),
        )
        return
      }

      res.statusCode = 404
      res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown path' } }))
    })
  })
  const upstreamPort = await listen(upstream)
  upstreamBase = `http://127.0.0.1:${upstreamPort}`

  process.env.RAYERN_API_BASE_URL = upstreamBase
  process.env.RAYERN_ADMIN_EMAIL = 'admin@rayern.test'
  process.env.RAYERN_ADMIN_PASSWORD = 'correct-horse'
  process.env.ADMIN_JWT_SECRET = 'proxy-test-secret'
  // config.ts reads env at import time — load the router only after it is set.
  vi.resetModules()

  const [{ default: rayernRoutes }, authModule] = await Promise.all([import('../routes/rayernAdmin'), import('../auth')])
  authenticate = authModule.authenticate
  adminToken = authModule.signAdminToken({ sub: 'a1', email: 'ops@rayern.test', name: 'Ops', role: 'admin' })

  const app = express()
  app.use(express.json())
  app.use(authenticate)
  app.use('/api/v1', rayernRoutes)
  appServer = app.listen(0)
  apiBase = `http://127.0.0.1:${await listen(appServer)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => appServer?.close(() => resolve()))
  await new Promise<void>((resolve) => upstream?.close(() => resolve()))
})

beforeEach(() => {
  requests.length = 0
})

describe('authorization', () => {
  it('rejects unauthenticated callers before anything reaches Rayern', async () => {
    const res = await api('/api/v1/admin/users', {}, null)
    expect(res.status).toBe(401)
    expect(requests).toHaveLength(0)
  })

  it('rejects a garbage token', async () => {
    const res = await api('/api/v1/admin/users', {}, 'not-a-jwt')
    expect(res.status).toBe(401)
    expect(requests).toHaveLength(0)
  })
})

describe('GET /api/v1/admin/users', () => {
  it('forwards the documented filters with the Rayern service session', async () => {
    const res = await api('/api/v1/admin/users?limit=50&plan=pro&subscriptionStatus=active&consent=opted_in')
    expect(res.status).toBe(200)

    // Login once with the configured service account, then the admin call.
    const login = requests.find((r) => r.url === '/api/v1/auth/login')
    expect(login).toBeDefined()
    expect(login?.body).toEqual({ email: 'admin@rayern.test', password: 'correct-horse' })

    const users = requests.find((r) => r.url.startsWith('/api/v1/admin/users'))
    expect(users?.url).toContain('plan=pro')
    expect(users?.url).toContain('subscriptionStatus=active')
    expect(users?.url).toContain('consent=opted_in')
    expect(users?.auth).toBe(`Bearer ${UPSTREAM_TOKEN}`)

    const payload = (await res.json()) as { success: boolean; data: { users: Array<{ email: string }> } }
    expect(payload.success).toBe(true)
    expect(payload.data.users[0].email).toBe('ada@example.com')
  })

  it('rejects values outside the contract enums without calling Rayern', async () => {
    const res = await api('/api/v1/admin/users?plan=platinum')
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { success: boolean; error: { code: string } }
    expect(payload.success).toBe(false)
    expect(payload.error.code).toBe('VALIDATION_ERROR')
    expect(requests).toHaveLength(0)
  })
})

describe('POST /api/v1/admin/campaigns/preview', () => {
  it('forwards the audience selector verbatim and relays the server preview', async () => {
    const res = await api('/api/v1/admin/campaigns/preview', {
      method: 'POST',
      body: JSON.stringify({ audience: { type: 'filters', plan: 'pro', subscriptionStatus: 'active' } }),
    })
    expect(res.status).toBe(200)

    const upstreamCall = requests.find((r) => r.url === '/api/v1/admin/campaigns/preview')
    expect(upstreamCall?.body).toEqual({
      audience: { type: 'filters', plan: 'pro', subscriptionStatus: 'active' },
    })

    const payload = (await res.json()) as {
      success: boolean
      data: { eligibleCount: number; skipped: Array<{ email: string; reason: string }> }
    }
    expect(payload.data.eligibleCount).toBe(1)
    expect(payload.data.skipped[0].reason).toBe('unknown_address')
  })

  it('rejects a malformed audience selector', async () => {
    const res = await api('/api/v1/admin/campaigns/preview', {
      method: 'POST',
      body: JSON.stringify({ audience: { type: 'everything' } }),
    })
    expect(res.status).toBe(400)
    expect(requests).toHaveLength(0)
  })
})

describe('POST /api/v1/admin/campaigns/send', () => {
  it('forwards the payload and surfaces Rayern-side consent rejection of an ineligible recipient', async () => {
    const res = await api('/api/v1/admin/campaigns/send', {
      method: 'POST',
      body: JSON.stringify({
        subject: 'Hello',
        bodyHtml: '<p>Hi</p>',
        audience: { type: 'manual_emails', emails: ['Ada@Example.com', 'ada@example.com'] },
        idempotencyKey: '2f6b0f6e-9f3b-4f3f-9f3b-2f6b0f6e9f3b',
      }),
    })
    expect(res.status).toBe(201)

    const upstreamCall = requests.find((r) => r.url === '/api/v1/admin/campaigns/send')
    // Deduplicated, lowercased manual list — nothing else added or removed.
    expect(upstreamCall?.body).toEqual({
      subject: 'Hello',
      bodyHtml: '<p>Hi</p>',
      audience: { type: 'manual_emails', emails: ['ada@example.com'] },
      idempotencyKey: '2f6b0f6e-9f3b-4f3f-9f3b-2f6b0f6e9f3b',
    })

    const payload = (await res.json()) as {
      data: { campaign: { totals: { accepted: number; skipped: number }; skipped: Array<{ email: string; reason: string }> } }
    }
    // The client is told exactly whom the server refused, and why.
    expect(payload.data.campaign.totals).toEqual({ resolved: 2, accepted: 1, failed: 0, skipped: 1 })
    expect(payload.data.campaign.skipped[0]).toEqual({ email: 'alan@example.com', reason: 'not_opted_in' })
  })

  it('rejects an invalid send payload without touching Rayern', async () => {
    const res = await api('/api/v1/admin/campaigns/send', {
      method: 'POST',
      body: JSON.stringify({ subject: '', bodyHtml: 'x', audience: { type: 'all_eligible' } }),
    })
    expect(res.status).toBe(400)
    expect(requests).toHaveLength(0)
  })
})

describe('unconfigured integration', () => {
  it('fails closed with 503 instead of inventing an audience', async () => {
    delete process.env.RAYERN_API_BASE_URL
    delete process.env.RAYERN_ADMIN_EMAIL
    delete process.env.RAYERN_ADMIN_PASSWORD
    vi.resetModules()

    const { default: unconfiguredRoutes } = await import('../routes/rayernAdmin')
    const { authenticate: freshAuthenticate } = await import('../auth')
    const app = express()
    app.use(express.json())
    app.use(freshAuthenticate)
    app.use('/api/v1', unconfiguredRoutes)
    const server = app.listen(0)
    const port = await listen(server)

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/campaigns/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ audience: { type: 'all_eligible' } }),
      })
      expect(res.status).toBe(503)
      const payload = (await res.json()) as { success: boolean; error: { code: string; message: string } }
      expect(payload.success).toBe(false)
      expect(payload.error.code).toBe('RAYERN_ADMIN_API_UNAVAILABLE')
      expect(requests).toHaveLength(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // Restore for any later suites in this file.
      process.env.RAYERN_API_BASE_URL = upstreamBase
      process.env.RAYERN_ADMIN_EMAIL = 'admin@rayern.test'
      process.env.RAYERN_ADMIN_PASSWORD = 'correct-horse'
      vi.resetModules()
    }
  })
})
