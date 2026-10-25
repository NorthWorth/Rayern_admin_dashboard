/**
 * Revenue pipeline end-to-end (local, no live backend):
 *
 *   mock Rayern  --GET /internal/dashboard-metrics-->  pull-sync worker
 *              --> contract validation + storage  --> billingService.current()
 *
 * Proves the dashboard consumes Rayern's billing block exactly as reported
 * (never recalculated), that the configured endpoint + monitoring token are
 * used, that the { success, data } envelope is unwrapped, and that a later
 * sync without a billing block keeps the last known billing data instead of
 * erasing it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'

interface Recorded {
  url: string
  auth: string | null
}

const requests: Recorded[] = []
const SYNC_PORT = 54399
const EMBEDDED_PORT = 54398

const BILLING_BLOCK = {
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
    { plan: 'starter', userCount: 109, subscriptionCount: 0, isPaid: false },
  ],
  definitions: { mrr: 'highest plan per qualifying user', arr: 'mrr_x_12' },
}

let mockRayern: Server
let payload: unknown = { success: true, data: {} }

beforeAll(async () => {
  mockRayern = createServer((req, res) => {
    requests.push({ url: req.url ?? '', auth: req.headers.authorization ?? null })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(payload))
  })
  await new Promise<void>((resolve) => mockRayern.listen(SYNC_PORT, '127.0.0.1', () => resolve()))

  // Environment is read at module import time — set it before any import of
  // config/db/rayernSync (no live Rayern credentials involved).
  process.env.RAYERN_SYNC_ENDPOINT = `http://127.0.0.1:${SYNC_PORT}/internal/dashboard-metrics`
  process.env.RAYERN_MONITORING_TOKEN = 'pipeline-monitoring-token'
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
  await new Promise<void>((resolve) => mockRayern?.close(() => resolve()))
})

describe('Rayern sync → billing metrics pipeline', () => {
  it('stores Rayern’s billing block verbatim (no dashboard recalculation)', async () => {
    payload = {
      success: true,
      data: {
        accounts: {
          totalAccounts: 123,
          newAccounts30d: 12,
          verifiedAccounts: 100,
          unverifiedAccounts: 23,
          deletedAccounts30d: null,
          deletionRequestsPending: null,
          registrationsTrend: [{ date: '2026-10-01', count: 3 }],
          planBreakdown: [{ plan: 'starter', count: 109 }],
        },
        workspaces: { totalWorkspaces: 120, newWorkspaces30d: 11, avgMembersPerWorkspace: 1.2 },
        billing: BILLING_BLOCK,
        services: [],
        telemetry: {},
      },
    }

    const { syncOnce } = await import('../rayernSync')
    const result = await syncOnce('manual')

    expect(result).toEqual({ ok: true, sections: expect.arrayContaining(['billing', 'accounts', 'workspaces']) })

    // The pull used the configured endpoint and the monitoring service token.
    const last = requests.at(-1)
    expect(last?.url).toBe('/internal/dashboard-metrics')
    expect(last?.auth).toBe('Bearer pipeline-monitoring-token')

    const { billingService } = await import('../billingService')
    const billing = await billingService.current()
    expect(billing).toEqual(BILLING_BLOCK)

    const { readSyncedAggregates } = await import('../rayernSync')
    const synced = await readSyncedAggregates()
    expect(synced.syncedAt).not.toBeNull()
    expect(synced.billing?.mrr.amountMajor).toBe(413.2)
    expect(synced.billing?.arr.definition).toBe('mrr_x_12')
  })

  it('keeps the last billing block when a later sync carries no billing section', async () => {
    payload = {
      success: true,
      data: {
        accounts: {
          totalAccounts: 130,
          newAccounts30d: 7,
          verifiedAccounts: 105,
          unverifiedAccounts: 25,
          deletedAccounts30d: null,
          deletionRequestsPending: null,
          registrationsTrend: [],
          planBreakdown: [],
        },
        workspaces: null,
        billing: null,
        services: [],
      },
    }

    const { syncOnce, readSyncedAggregates } = await import('../rayernSync')
    const result = await syncOnce('manual')
    expect(result.ok).toBe(true)

    const synced = await readSyncedAggregates()
    // Billing never disappears silently: the previous known-good block stays.
    expect(synced.billing?.mrr.amountMajor).toBe(413.2)
    expect(synced.accounts?.totalAccounts).toBe(130)
  })

  it('reports the explicit no-data sentinel when no billing block is stored', async () => {
    const { query } = await import('../db')
    await query(`DELETE FROM rayern_sync_state WHERE key = 'billing'`)

    const { billingService } = await import('../billingService')
    expect(await billingService.hasBillingData()).toBe(false)
    expect(await billingService.current()).toBeNull()

    // A subsequent sync restores the authoritative block.
    payload = {
      success: true,
      data: {
        accounts: {
          totalAccounts: 123,
          newAccounts30d: 12,
          verifiedAccounts: 100,
          unverifiedAccounts: 23,
          deletedAccounts30d: null,
          deletionRequestsPending: null,
          registrationsTrend: [],
          planBreakdown: [],
        },
        billing: BILLING_BLOCK,
      },
    }
    const { syncOnce } = await import('../rayernSync')
    expect((await syncOnce('manual')).ok).toBe(true)
    expect(await billingService.hasBillingData()).toBe(true)
  })
})
