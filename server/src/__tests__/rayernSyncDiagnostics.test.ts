/**
 * Outbound Rayern failure diagnostics, end to end (local, no live backend):
 *
 *   mock Rayern --GET /internal/dashboard-metrics--> syncOnce()
 *              --> capture at the HTTP layer --> rayern_sync_diagnostics
 *              --> GET /rayern/sync-diagnostics (admin session)
 *
 * Covers the four failure classes the dashboard can hit when calling Rayern —
 * connection refused, HTTP error, unusable 2xx body, and a 429 with
 * `Retry-After` — and proves the records are sanitized, bounded, exposed only
 * through an authenticated route, and never disturb last-known-good data or the
 * existing rate-limit backoff.
 *
 * Ports differ from the other embedded-database suites (54391/54392 here,
 * 54395/54396 instrumentation sync, 54398/54399 revenue pipeline) so the files
 * can run concurrently.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import express from 'express'
import type { AddressInfo } from 'node:net'

const SYNC_PORT = 54392
const EMBEDDED_PORT = 54391
const MONITORING_TOKEN = 'diag-monitoring-token'

let mockRayern: Server
let payload: unknown = { success: true, data: {} }
let responseStatus = 200
let responseHeaders: Record<string, string> = {}
let listening = false

async function startMock(): Promise<void> {
  await new Promise<void>((resolve) => mockRayern.listen(SYNC_PORT, '127.0.0.1', () => resolve()))
  listening = true
}

const ACCOUNTS = {
  totalAccounts: 42,
  newAccounts30d: 4,
  verifiedAccounts: 40,
  unverifiedAccounts: 2,
  deletedAccounts30d: 0,
  deletionRequestsPending: 0,
  registrationsTrend: [{ date: '2026-10-01', count: 2 }],
  planBreakdown: [{ plan: 'starter', count: 38 }],
}

beforeAll(async () => {
  mockRayern = createServer((_req, res) => {
    res.statusCode = responseStatus
    for (const [name, value] of Object.entries(responseHeaders)) res.setHeader(name, value)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(payload))
  })
  // Deliberately NOT listening yet: the first test needs a refused connection.

  process.env.RAYERN_SYNC_ENDPOINT = `http://127.0.0.1:${SYNC_PORT}/internal/dashboard-metrics`
  process.env.RAYERN_MONITORING_TOKEN = MONITORING_TOKEN
  process.env.EMBEDDED_PG_PORT = String(EMBEDDED_PORT)
  process.env.TELEMETRY_ENABLED = 'false'
  delete process.env.DATABASE_URL
  vi.resetModules()

  const db = await import('../db')
  await db.startEmbeddedDbIfConfigured()
  await db.initDb()
  db.setDbReady(true)
})

afterAll(async () => {
  if (listening) {
    await new Promise<void>((resolve) => mockRayern.close(() => resolve()))
  } else {
    mockRayern.closeAllConnections?.()
    await new Promise<void>((resolve) => mockRayern.close(() => resolve()))
  }
})

describe('server-side Rayern sync diagnostics', () => {
  it('records a network failure when Rayern cannot be reached', async () => {
    responseHeaders = {}
    payload = {}
    responseStatus = 200

    const { syncOnce } = await import('../rayernSync')
    const { listSyncDiagnostics } = await import('../syncDiagnostics')

    const result = await syncOnce('manual')
    expect(result.ok).toBe(false)

    const { diagnostics } = await listSyncDiagnostics(10)
    const network = diagnostics.find((d) => d.outcome === 'network_error' || d.outcome === 'timeout')
    expect(network).toBeDefined()
    expect(network?.status).toBeNull()
    expect(network?.source).toBe('sync')
    expect(network?.endpoint).toBe('/internal/dashboard-metrics')
    expect(network?.method).toBe('GET')
    expect(network?.errorCode).toBe('RAYERN_UNREACHABLE')
    expect(network?.durationMs).toBeGreaterThanOrEqual(0)
    expect(network?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('captures an HTTP failure with a sanitized body, headers and request id', async () => {
    await startMock()
    responseStatus = 500
    responseHeaders = {
      server: 'rayern-edge',
      'x-request-id': 'req_diag_500',
      'x-edge-node': 'fra1',
      'x-api-key': 'sk_live_should_never_be_stored',
      'retry-after': '30',
    }
    payload = {
      success: false,
      error: { code: 'INTERNAL', message: 'aggregation failed for ada@example.com token=abc123' },
    }

    const { syncOnce } = await import('../rayernSync')
    const { listSyncDiagnostics } = await import('../syncDiagnostics')

    const result = await syncOnce('manual')
    expect(result.ok).toBe(false)

    const { diagnostics } = await listSyncDiagnostics(10)
    const http = diagnostics.find((d) => d.status === 500)
    expect(http).toBeDefined()
    expect(http?.outcome).toBe('http_error')
    expect(http?.errorCode).toBe('UPSTREAM_500')
    expect(http?.requestId).toBe('req_diag_500')
    expect(http?.message).toContain('HTTP 500')

    // Response body is retained but sanitized before storage.
    expect(http?.responseBody).toBeTruthy()
    expect(http?.responseBody).not.toContain('ada@example.com')
    expect(http?.responseBody).not.toContain('abc123')
    expect(http?.responseBody).toContain('[redacted-email]')

    // Diagnostic headers survive; credential-shaped ones never do.
    expect(http?.headers.server).toBe('rayern-edge')
    expect(http?.headers['x-request-id']).toBe('req_diag_500')
    expect(http?.headers['x-edge-node']).toBe('fra1')
    expect(http?.headers['retry-after']).toBe('30')
    expect(http?.headers['x-api-key']).toBeUndefined()
  })

  it('keeps last-known-good aggregates when a later pull fails', async () => {
    payload = {
      success: true,
      data: { accounts: ACCOUNTS, workspaces: null, billing: null, services: [], telemetry: {} },
    }
    responseStatus = 200
    responseHeaders = { 'x-request-id': 'req_diag_ok' }

    const { syncOnce, readSyncedAggregates } = await import('../rayernSync')

    const ok = await syncOnce('manual')
    expect(ok.ok).toBe(true)
    const synced = await readSyncedAggregates()
    expect(synced.syncedAt).not.toBeNull()
    expect(synced.accounts?.totalAccounts).toBe(42)

    // Now fail the next pull: the stored aggregates must be untouched.
    responseStatus = 503
    responseHeaders = {}
    payload = { success: false, error: { code: 'UNAVAILABLE', message: 'maintenance' } }

    const failed = await syncOnce('manual')
    expect(failed.ok).toBe(false)

    const after = await readSyncedAggregates()
    expect(after.accounts?.totalAccounts).toBe(42)
    expect(after.syncedAt).not.toBeNull()

    const { listSyncDiagnostics } = await import('../syncDiagnostics')
    const { diagnostics } = await listSyncDiagnostics(10)
    expect(diagnostics.some((d) => d.status === 503)).toBe(true)
    // The earlier successful pull is not a diagnostic — only failures are.
    expect(diagnostics.some((d) => d.status === 200)).toBe(false)
  })

  it('exposes the records through an authenticated, admin-only route', async () => {
    const { rayernInternalRouter } = await import('../routes/rayernInternal')
    const { authenticate, requireAdmin, signAdminToken } = await import('../auth')

    const app = express()
    app.use(express.json())
    app.use(authenticate)
    app.use('/rayern', requireAdmin, rayernInternalRouter)

    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`

    try {
      // Anonymous callers are rejected before the handler runs.
      const anonymous = await fetch(`${base}/rayern/sync-diagnostics`)
      expect(anonymous.status).toBe(401)

      const token = signAdminToken({ sub: '1', email: 'admin@rayern.com.ng', name: 'Admin', role: 'admin' })
      const res = await fetch(`${base}/rayern/sync-diagnostics?limit=5`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        diagnostics: Array<Record<string, unknown>>
        meta: { maxEntries: number; note: string }
      }
      expect(Array.isArray(body.diagnostics)).toBe(true)
      expect(body.diagnostics.length).toBeGreaterThan(0)
      expect(body.diagnostics.length).toBeLessThanOrEqual(5)
      expect(body.meta.maxEntries).toBe(200)

      // No credential can ever come back out of this endpoint.
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain(MONITORING_TOKEN)
      expect(serialized).not.toContain('sk_live_should_never_be_stored')
      expect(serialized).not.toContain('Authorization')
      expect(serialized).not.toContain('ada@example.com')

      // Query bounds are validated before anything is read.
      const invalid = await fetch(`${base}/rayern/sync-diagnostics?limit=9999`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(invalid.status).toBe(400)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('records a 429 with Retry-After and preserves the existing backoff window', async () => {
    responseStatus = 429
    responseHeaders = { 'retry-after': '45', server: 'rayern-edge', 'x-request-id': 'req_diag_429' }
    payload = { success: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }

    const { syncOnce } = await import('../rayernSync')
    const { listSyncDiagnostics } = await import('../syncDiagnostics')

    const limited = await syncOnce('manual')
    expect(limited.ok).toBe(false)

    const { diagnostics } = await listSyncDiagnostics(10)
    const rateLimited = diagnostics.find((d) => d.status === 429)
    expect(rateLimited).toBeDefined()
    expect(rateLimited?.errorCode).toBe('RAYERN_RATE_LIMITED')
    expect(rateLimited?.headers['retry-after']).toBe('45')
    expect(rateLimited?.requestId).toBe('req_diag_429')

    // Existing behaviour: the in-memory backoff window skips the next pull
    // entirely — no extra outbound request, no extra diagnostic record.
    const skipped = await syncOnce('manual')
    expect(skipped.ok).toBe(false)
    expect(skipped.skipped).toBe('rate-limited')

    const after = await listSyncDiagnostics(10)
    expect(after.diagnostics.filter((d) => d.status === 429)).toHaveLength(1)
  })
})
