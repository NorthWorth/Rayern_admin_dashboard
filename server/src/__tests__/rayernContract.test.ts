/**
 * Contract regression tests using the shape Rayern's producer ACTUALLY emits.
 *
 * These exist because the previous fixtures were invented: they used `count`
 * where Rayern sends `visitors` / `users` / `usersRegistered`, so the dashboard
 * silently dropped real data while its own tests passed.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

const EMBEDDED_PORT = 54391

beforeAll(async () => {
  process.env.RAYERN_SNAPSHOT_TOKEN = 'contract-test-token'
  process.env.EMBEDDED_PG_PORT = String(EMBEDDED_PORT)
  process.env.TELEMETRY_ENABLED = 'false'
  delete process.env.DATABASE_URL
  delete process.env.RAYERN_BILLING_CURRENCY
  vi.resetModules()
  const db = await import('../db')
  await db.startEmbeddedDbIfConfigured()
  await db.initDb()
  db.setDbReady(true)
})

/** Producer-shaped snapshot: field names exactly as Rayern emits them. */
function producerSnapshot(snapshotId: string, generatedAt: string) {
  return {
    success: true,
    data: {
      snapshotId,
      generatedAt,
      version: '1.0.0',
      accounts: {
        totalAccounts: 420,
        newAccounts30d: 33,
        verifiedAccounts: 380,
        unverifiedAccounts: 40,
        // Rayern does not track deletion accounting at all.
        deletedAccounts30d: null,
        deletionRequestsPending: null,
        registrationsTrend: [{ date: '2026-11-18', count: 4 }],
        planBreakdown: [{ plan: 'pro', count: 90 }],
      },
      workspaces: {
        totalWorkspaces: 260,
        newWorkspaces30d: 12,
        avgMembersPerWorkspace: 1.4,
        planBreakdown: [{ plan: 'pro', count: 90 }],
      },
      billing: {
        currency: 'NGN',
        amountUnit: 'minor_units',
        generatedAt,
        activePaidSubscribers: 90,
        freeUsers: 330,
        totalAccounts: 420,
        mrr: { amountMinor: 45_000_00, amountMajor: 450_000, byPlan: [] },
        arr: { amountMinor: 540_000_00, amountMajor: 5_400_000, definition: 'mrr * 12' },
        planBreakdown: [],
        definitions: {},
      },
      services: [],
      telemetry: {},
      funnel: {
        hasVisitorData: true,
        visits30d: 1200,
        signupIntents30d: 140,
        registrations30d: 33,
        activated30d: 20,
        attributedSignups30d: 22,
        daily: [{ date: '2026-11-18', visits: 40, signupIntents: 5, registrations: 2, activated: 1 }],
        // Producer shape: { source, visitors }
        topSources: [
          { source: 'google', visitors: 300 },
          { source: 'twitter', visitors: 120 },
        ],
      },
      engagement: {
        dau: 88,
        wau: 210,
        mau: 350,
        // Producer shape: { date, users }
        dailyActiveUsers: [
          { date: '2026-11-17', users: 84 },
          { date: '2026-11-18', users: 88 },
        ],
        // Producer shape: { weekStart, usersRegistered, retainedNextWeek, retentionPct }
        cohorts: [
          { weekStart: '2026-11-02', usersRegistered: 60, retainedNextWeek: 30, retentionPct: 50 },
          { weekStart: '2026-11-09', usersRegistered: 44, retainedNextWeek: null, retentionPct: null },
        ],
      },
      marketingConsent: { totalRegisteredUsers: 420, optedIn: 300, optedOut: 120 },
    },
  }
}

describe('normalisers read the real producer field names', () => {
  it('maps funnel.topSources[].visitors', async () => {
    const { normalizeFunnel } = await import('../instrumentation')
    const dto = normalizeFunnel({ topSources: [{ source: 'google', visitors: 300 }] })
    expect(dto.topSources).toEqual([{ source: 'google', count: 300 }])
  })

  it('maps engagement.dailyActiveUsers[].users', async () => {
    const { normalizeEngagement } = await import('../instrumentation')
    const dto = normalizeEngagement({ dailyActiveUsers: [{ date: '2026-11-18', users: 88 }] })
    expect(dto.dailyActiveUsers).toEqual([{ date: '2026-11-18', count: 88 }])
  })

  it('maps engagement.cohorts[].usersRegistered as cohort size', async () => {
    const { normalizeEngagement } = await import('../instrumentation')
    const dto = normalizeEngagement({
      cohorts: [{ weekStart: '2026-11-02', usersRegistered: 60, retainedNextWeek: 30, retentionPct: 50 }],
    })
    expect(dto.cohorts[0].size).toBe(60)
    expect(dto.cohorts[0].retainedNextWeek).toBe(30)
  })

  it('never turns a missing cohort size into 0', async () => {
    const { normalizeEngagement } = await import('../instrumentation')
    const dto = normalizeEngagement({ cohorts: [{ weekStart: '2026-11-02' }] })
    expect(dto.cohorts[0].size).toBeNull()
  })
})

describe('complete producer snapshot survives ingestion → local API DTO', () => {
  it('persists every block and exposes the previously lost fields', async () => {
    const { ingestRayernSnapshot } = await import('../rayernIngestion')
    const { readInstrumentationBlocks, readSyncedAggregates } = await import('../rayernSync')
    const { normalizeInstrumentation } = await import('../instrumentation')

    const result = await ingestRayernSnapshot(producerSnapshot('contract-1', '2026-11-18T08:00:00.000Z'))
    expect(result.ok).toBe(true)
    expect(result.sections).toEqual(
      expect.arrayContaining(['accounts', 'workspaces', 'billing', 'funnel', 'engagement', 'marketingConsent']),
    )

    const { blocks } = await readInstrumentationBlocks()
    const dto = normalizeInstrumentation(blocks)

    expect(dto.funnel?.topSources).toEqual([
      { source: 'google', count: 300 },
      { source: 'twitter', count: 120 },
    ])
    expect(dto.engagement?.dailyActiveUsers[1]).toEqual({ date: '2026-11-18', count: 88 })
    expect(dto.engagement?.cohorts[0].size).toBe(60)
    expect(dto.marketingConsent).toMatchObject({ optedIn: 300, optedOut: 120, reconciles: true })

    const aggregates = await readSyncedAggregates()
    // Non-USD currency is accepted and travels with the payload unchanged.
    expect(aggregates.billing?.currency).toBe('NGN')
    // Unmeasured counts stay unavailable rather than becoming 0.
    expect(aggregates.accounts?.deletedAccounts30d).toBeNull()
    expect(aggregates.accounts?.deletionRequestsPending).toBeNull()
  })

  it('rejects a snapshot whose currency is not a valid ISO code', async () => {
    const { ingestRayernSnapshot } = await import('../rayernIngestion')
    const bad = producerSnapshot('contract-bad-currency', '2026-11-18T09:00:00.000Z')
    bad.data.billing.currency = 'NAIRA'
    const result = await ingestRayernSnapshot(bad)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    // The diagnostic names the failing path instead of silently discarding.
    expect(result.error).toContain('billing.currency')
  })

  it('treats a repeat delivery as an idempotent success', async () => {
    const { ingestRayernSnapshot } = await import('../rayernIngestion')
    const again = await ingestRayernSnapshot(producerSnapshot('contract-1', '2026-11-18T08:00:00.000Z'))
    expect(again.ok).toBe(true)
    expect(again.idempotent).toBe(true)
  })

  it('reports a push-only deployment as enabled, fresh and push-transported', async () => {
    const { getSyncStatus } = await import('../rayernSync')
    // No RAYERN_SYNC_ENDPOINT in this test environment: pull is not configured.
    const status = await getSyncStatus()
    expect(status.transport).toBe('push')
    expect(status.enabled).toBe(true)
    expect(status.pullEnabled).toBe(false)
    expect(status.lastSuccessTransport).toBe('push')
    expect(status.stale).toBe(false)
  })

  it('rolls back a half-written snapshot (atomic persistence)', async () => {
    const { withTransaction, query } = await import('../db')
    await expect(
      withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO rayern_sync_state (key, payload, updated_at) VALUES ('atomic-probe', '{}'::jsonb, now())`,
        )
        throw new Error('simulated failure mid-ingestion')
      }),
    ).rejects.toThrow('simulated failure')

    const rows = await query<{ key: string }>(`SELECT key FROM rayern_sync_state WHERE key = 'atomic-probe'`)
    expect(rows).toHaveLength(0)
  })

  it('ignores an older snapshot instead of overwriting newer data', async () => {
    const { ingestRayernSnapshot } = await import('../rayernIngestion')
    const older = producerSnapshot('contract-0', '2026-11-01T00:00:00.000Z')
    for (const key of ['funnel', 'engagement', 'marketingConsent', 'workspaces', 'billing'] as const) {
      delete (older.data as Record<string, unknown>)[key]
    }
    ;(older.data.accounts as Record<string, unknown>).totalAccounts = 1
    const result = await ingestRayernSnapshot(older)
    expect(result.ok).toBe(true)
    expect(result.idempotent).toBe(true)

    const { readSyncedAggregates } = await import('../rayernSync')
    const aggregates = await readSyncedAggregates()
    expect(aggregates.accounts?.totalAccounts).toBe(420)
  })
})
