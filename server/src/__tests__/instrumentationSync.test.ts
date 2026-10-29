/**
 * Instrumentation blocks through the pull-sync (local, no live backend):
 *
 *   mock Rayern --GET /internal/dashboard-metrics--> syncOnce()
 *              --> extractInstrumentation() --> rayern_sync_state
 *              --> readInstrumentationBlocks() --> normalizeInstrumentation()
 *
 * Proves the contract's persistence rules end to end:
 *
 *  1. Blocks arrive in the SAME envelope as the core aggregates and are
 *     stored under their own keys.
 *  2. A structurally invalid block is dropped without failing the sync that
 *     already carried valid accounts/workspaces data.
 *  3. A later sync that omits a block keeps the last known-good snapshot
 *     (same behaviour as `billing`), and `syncedAt` still reports freshness.
 *  4. An explicit upstream `null` (per-block aggregation guard) overwrites the
 *     stored object and reads back as `null` — never as `{}`/empty data.
 *
 * Ports are distinct from revenuePipeline.test.ts (54398/54399) so the two
 * embedded-database suites can run concurrently.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'

const SYNC_PORT = 54396
const EMBEDDED_PORT = 54395

let mockRayern: Server
let payload: unknown = { success: true, data: {} }

const FUNNEL_BLOCK = {
  hasVisitorData: true,
  visits30d: 1000,
  signupIntents30d: 200,
  registrations30d: 150,
  activated30d: 90,
  attributedSignups30d: 30,
  daily: [{ date: '2026-10-28', visits: 40, signupIntents: 8, registrations: 6, activated: 3 }],
  topSources: [{ source: 'google', count: 10 }],
}

const ACCOUNTS = {
  totalAccounts: 123,
  newAccounts30d: 12,
  verifiedAccounts: 100,
  unverifiedAccounts: 23,
  deletedAccounts30d: 0,
  deletionRequestsPending: 0,
  registrationsTrend: [{ date: '2026-10-01', count: 3 }],
  planBreakdown: [{ plan: 'starter', count: 109 }],
}

beforeAll(async () => {
  mockRayern = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(payload))
  })
  await new Promise<void>((resolve) => mockRayern.listen(SYNC_PORT, '127.0.0.1', () => resolve()))

  // Environment is read at module import time — set it before any import of
  // config/db/rayernSync (no live Rayern credentials involved).
  process.env.RAYERN_SYNC_ENDPOINT = `http://127.0.0.1:${SYNC_PORT}/internal/dashboard-metrics`
  process.env.RAYERN_MONITORING_TOKEN = 'instrumentation-monitoring-token'
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

describe('instrumentation blocks through the pull-sync', () => {
  it('persists valid blocks, drops an invalid one, and keeps the upstream null sentinel', async () => {
    payload = {
      success: true,
      data: {
        accounts: ACCOUNTS,
        workspaces: null,
        billing: null,
        services: [],
        telemetry: {},
        funnel: FUNNEL_BLOCK,
        marketingConsent: { totalRegisteredUsers: 10, optedIn: 6, optedOut: 4 },
        engagement: null, // upstream aggregation guard
        clientErrors: 'not-an-object', // structurally invalid → dropped, never stored
      },
    }

    const { syncOnce, readInstrumentationBlocks } = await import('../rayernSync')
    const result = await syncOnce('manual')
    expect(result.ok).toBe(true)
    expect(result.sections).toEqual(expect.arrayContaining(['funnel', 'marketingConsent', 'engagement']))
    expect(result.sections).not.toContain('clientErrors')

    const { blocks, syncedAt } = await readInstrumentationBlocks()
    expect(blocks.funnel).toMatchObject({ visits30d: 1000, registrations30d: 150 })
    expect(blocks.marketingConsent).toEqual({ totalRegisteredUsers: 10, optedIn: 6, optedOut: 4 })
    expect(blocks.engagement).toBeNull() // explicit null, NOT {}
    expect(blocks.clientErrors).toBeUndefined() // never received, NOT empty
    expect(syncedAt).not.toBeNull()

    // The DTO layer the API serves is derived from exactly these blocks.
    const { normalizeInstrumentation } = await import('../instrumentation')
    const dto = normalizeInstrumentation(blocks)
    expect(dto.funnel?.conversion.registrationToActivationPct).toBe(60)
    expect(dto.marketingConsent?.reconciles).toBe(true)
    expect(dto.engagement).toBeNull()
    expect(dto.clientErrors).toBeNull()
  })

  it('keeps the last snapshot when a later sync carries no instrumentation blocks', async () => {
    payload = {
      success: true,
      data: { accounts: ACCOUNTS, workspaces: null, billing: null, services: [], telemetry: {} },
    }

    const { syncOnce, readInstrumentationBlocks } = await import('../rayernSync')
    const result = await syncOnce('manual')
    expect(result.ok).toBe(true)

    const { blocks, syncedAt } = await readInstrumentationBlocks()
    expect(blocks.funnel).toMatchObject({ visits30d: 1000 })
    expect(blocks.marketingConsent).toEqual({ totalRegisteredUsers: 10, optedIn: 6, optedOut: 4 })
    expect(syncedAt).not.toBeNull()
  })

  it('an explicit upstream null replaces the stored object instead of leaving stale data', async () => {
    payload = {
      success: true,
      data: {
        accounts: ACCOUNTS,
        workspaces: null,
        billing: null,
        services: [],
        telemetry: {},
        funnel: null, // Rayern's per-block guard fired this round
      },
    }

    const { syncOnce, readInstrumentationBlocks } = await import('../rayernSync')
    const result = await syncOnce('manual')
    expect(result.ok).toBe(true)

    const { blocks } = await readInstrumentationBlocks()
    expect(blocks.funnel).toBeNull()

    const { normalizeInstrumentation } = await import('../instrumentation')
    expect(normalizeInstrumentation(blocks).funnel).toBeNull()

    // Blocks that were not part of this payload are untouched.
    expect(blocks.marketingConsent).toEqual({ totalRegisteredUsers: 10, optedIn: 6, optedOut: 4 })
  })

  it('a failed sync does not mark instrumentation as freshly synchronized', async () => {
    const { readInstrumentationBlocks, isSyncRunning, syncOnce } = await import('../rayernSync')
    const before = await readInstrumentationBlocks()

    // A transport failure: nothing is stored, the previous snapshot survives.
    payload = { success: false, error: { code: 'INTERNAL', message: 'aggregation failed' } }
    const result = await syncOnce('manual')
    expect(result.ok).toBe(false)
    expect(isSyncRunning()).toBe(false)

    const after = await readInstrumentationBlocks()
    expect(after.blocks.funnel).toEqual(before.blocks.funnel)
    expect(after.blocks.marketingConsent).toEqual(before.blocks.marketingConsent)
  })
})
