import { describe, it, expect, beforeAll, vi } from 'vitest'

const EMBEDDED_PORT = 54392

beforeAll(async () => {
  process.env.EMBEDDED_PG_PORT = String(EMBEDDED_PORT)
  process.env.TELEMETRY_ENABLED = 'false'
  process.env.RAYERN_SNAPSHOT_TOKEN = 'test-snapshot-token'
  process.env.RAYERN_MONITORING_TOKEN = 'test-monitoring-token'
  delete process.env.DATABASE_URL
  vi.resetModules()

  const db = await import('../db')
  await db.startEmbeddedDbIfConfigured()
  await db.initDb()
  db.setDbReady(true)
})

interface AudienceRecordInput {
  email: string
  firstName?: string | null
  lastName?: string | null
  status?: 'active' | 'suspended' | 'closed'
  emailVerified?: boolean
  workspacePlan?: string | null
  subscription?: { plan?: string; status?: string; hasPaidAccess?: boolean } | null
  marketingConsent?: { optedIn?: boolean; consentedAt?: string; updatedAt?: string; source?: string | null }
  updatedAt?: string
}

function record(email: string, overrides: Partial<AudienceRecordInput> = {}): AudienceRecordInput {
  return {
    email,
    firstName: 'Test',
    lastName: email.split('@')[0],
    status: 'active',
    emailVerified: true,
    marketingConsent: { optedIn: true, consentedAt: '2026-11-01T00:00:00.000Z', source: 'settings' },
    ...overrides,
  }
}

/** Invokes a GET handler from an Express router directly (routes are plain handlers). */
async function invokeGet(router: { stack: unknown[] }, path: string): Promise<{ status: number; body: any }> {
  const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route.methods?.get)
  if (!layer) throw new Error(`GET ${path} is not registered`)
  const handler = layer.route.stack[0].handle
  let body: any
  let status = 200
  const res = {
    status(code: number) {
      status = code
      return this
    },
    json(payload: unknown) {
      body = payload
      return this
    },
  }
  await handler({} as any, res as any, (err: unknown) => {
    throw err instanceof Error ? err : new Error(String(err))
  })
  return { status, body }
}

describe('rayern audience ingestion', () => {
  it('persists a complete snapshot and advances the push sync metadata', async () => {
    const { ingestRayernAudience } = await import('../rayernAudienceIngestion')
    const { getSyncStatus } = await import('../rayernSync')

    const result = await ingestRayernAudience({
      syncId: 'aud-1',
      complete: true,
      audience: [
        record('alice@example.com', { workspacePlan: 'pro', subscription: { plan: 'pro', status: 'active', hasPaidAccess: true } }),
        record('bob@example.com', { status: 'suspended' }),
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.received).toBe(2)
    expect(result.upserted).toBe(2)
    expect(result.removed).toBe(0)

    const { listAudience } = await import('../rayernAudienceIngestion')
    const rows = await listAudience()
    expect(rows.map((r) => r.email)).toEqual(['alice@example.com', 'bob@example.com'])
    expect(rows[0].subscriptionPlan).toBe('pro')
    expect(rows[0].consentSource).toBe('settings')

    const sync = await getSyncStatus()
    expect(sync.lastSuccessAt).not.toBeNull()
    expect(sync.lastSuccessTransport).toBe('push')
  })

  it('updates an existing record and never duplicates it', async () => {
    const { ingestRayernAudience, listAudience } = await import('../rayernAudienceIngestion')

    await ingestRayernAudience({
      syncId: 'aud-2',
      complete: true,
      audience: [
        record('alice@example.com', {
          status: 'suspended',
          emailVerified: false,
          marketingConsent: { optedIn: false, source: 'unsubscribe_link', updatedAt: '2026-11-10T00:00:00.000Z' },
        }),
        record('bob@example.com'),
      ],
    })

    const rows = await listAudience()
    const alice = rows.filter((r) => r.email === 'alice@example.com')
    expect(alice).toHaveLength(1)
    expect(alice[0].status).toBe('suspended')
    expect(alice[0].emailVerified).toBe(false)
    expect(alice[0].consentOptedIn).toBe(false)
    expect(alice[0].consentSource).toBe('unsubscribe_link')
  })

  it('prunes records absent from a COMPLETE snapshot only, and refuses to clear on an empty one', async () => {
    const { ingestRayernAudience, listAudience } = await import('../rayernAudienceIngestion')

    // A delta (no `complete`) upserts without deleting anything.
    const delta = await ingestRayernAudience({
      syncId: 'aud-delta',
      audience: [record('delta@example.com')],
    })
    expect(delta.ok).toBe(true)
    expect(delta.pruned).toBe(false)
    expect(delta.removed).toBe(0)
    expect((await listAudience()).map((r) => r.email).sort()).toEqual(['alice@example.com', 'bob@example.com', 'delta@example.com'])

    const cleanup = await ingestRayernAudience({
      syncId: 'aud-3',
      complete: true,
      audience: [record('bob@example.com')],
    })
    expect(cleanup.pruned).toBe(true)
    expect(cleanup.removed).toBe(2)
    expect((await listAudience()).map((r) => r.email)).toEqual(['bob@example.com'])

    // An empty payload cannot prove that nobody is mailable: it is rejected and
    // the stored audience survives untouched (previously it wiped the table).
    const cleared = await ingestRayernAudience({ syncId: 'aud-4', audience: [] })
    expect(cleared.ok).toBe(false)
    expect(cleared.status).toBe(400)
    expect((await listAudience()).map((r) => r.email)).toEqual(['bob@example.com'])
  })

  it('rejects an invalid payload without writing or advancing success metadata', async () => {
    const { ingestRayernAudience } = await import('../rayernAudienceIngestion')
    const { getSyncStatus } = await import('../rayernSync')

    const before = await getSyncStatus()
    const result = await ingestRayernAudience({ audience: [{ email: 'not-an-email' }] })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)

    const after = await getSyncStatus()
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt)
  })
})

describe('local audience API', () => {
  it('returns the locally persisted rows and accurate counts', async () => {
    const { ingestRayernAudience } = await import('../rayernAudienceIngestion')
    await ingestRayernAudience({
      syncId: 'aud-api',
      complete: true,
      audience: [
        record('alice@example.com', { workspacePlan: 'pro', subscription: { plan: 'pro', status: 'active' } }),
        record('bob@example.com', { status: 'suspended' }),
        record('carol@example.com', { emailVerified: false }),
        record('dave@example.com', { marketingConsent: { optedIn: false, source: 'settings' } }),
      ],
    })

    const router = (await import('../routes/marketing')).default
    const { status, body } = await invokeGet(router as unknown as { stack: unknown[] }, '/audience')

    expect(status).toBe(200)
    expect(body.items).toHaveLength(4)
    expect(body.items[0]).toHaveProperty('email')
    expect(body.items[0]).toHaveProperty('subscriptionPlan')
    expect(body.items[0]).toHaveProperty('syncedAt')
    expect(body.counts).toMatchObject({ total: 4, eligible: 1, optedIn: 3, optedOut: 1, suspended: 1, unverified: 1 })
    expect(body.lastSyncedAt).not.toBeNull()
  })

  it('returns an honest empty state when nothing has ever been synced', async () => {
    // Cleared explicitly: an empty push payload is rejected by design, so a
    // test may not use ingestion as a truncate.
    const { query } = await import('../db')
    await query('DELETE FROM rayern_audience')

    const router = (await import('../routes/marketing')).default
    const { body } = await invokeGet(router as unknown as { stack: unknown[] }, '/audience')
    expect(body.items).toEqual([])
    expect(body.counts.total).toBe(0)
    expect(body.lastSyncedAt).toBeNull()
  })
})

describe('bulk email recipients', () => {
  it('reads the synchronized audience (eligible only) and reports its freshness', async () => {
    const { ingestRayernAudience } = await import('../rayernAudienceIngestion')
    await ingestRayernAudience({
      syncId: 'aud-email',
      complete: true,
      audience: [
        record('bulk-eligible@example.com'),
        record('bulk-suspended@example.com', { status: 'suspended' }),
        record('bulk-unverified@example.com', { emailVerified: false }),
        record('bulk-optedout@example.com', { marketingConsent: { optedIn: false, source: 'settings' } }),
      ],
    })

    const router = (await import('../routes/emails')).default
    const { status, body } = await invokeGet(router as unknown as { stack: unknown[] }, '/audience')

    expect(status).toBe(200)
    expect(body.recipients).toEqual(['bulk-eligible@example.com'])
    expect(body.count).toBe(1)
    // The composer shows this so a stale mirror is never presented as current.
    expect(typeof body.lastSyncedAt).toBe('string')
  })
})

describe('audience eligibility', () => {
  it('computes eligible/excluded counts and per-record exclusion reasons', async () => {
    const { ingestRayernAudience } = await import('../rayernAudienceIngestion')
    await ingestRayernAudience({
      syncId: 'aud-eligibility',
      complete: true,
      audience: [
        record('eligible@example.com'),
        record('suspended@example.com', { status: 'suspended' }),
        record('unverified@example.com', { emailVerified: false }),
        record('optedout@example.com', { marketingConsent: { optedIn: false, source: 'settings' } }),
        record('missing-consent@example.com', { marketingConsent: {} }),
        record('missing-verification@example.com', { emailVerified: false }),
      ],
    })

    const router = (await import('../routes/marketing')).default
    const { status, body } = await invokeGet(router as unknown as { stack: unknown[] }, '/audience/eligibility')

    expect(status).toBe(200)
    expect(body.total).toBe(6)
    expect(body.eligible).toBe(1)
    expect(body.excluded).toBe(5)

    const reasons = Object.fromEntries(body.reasons.map((r: { reason: string; count: number }) => [r.reason, r.count]))
    expect(reasons.account_suspended).toBe(1)
    expect(reasons.email_unverified).toBe(2)
    expect(reasons.not_opted_in).toBe(2)

    const byEmail = Object.fromEntries(body.items.map((i: { email: string }) => [i.email, i]))
    expect(byEmail['eligible@example.com']).toMatchObject({ eligible: true, reasons: [] })
    expect(byEmail['suspended@example.com'].reasons).toContain('account_suspended')
    expect(byEmail['unverified@example.com'].reasons).toContain('email_unverified')
    expect(byEmail['missing-consent@example.com'].reasons).toContain('not_opted_in')
    expect(byEmail['missing-verification@example.com'].reasons).toContain('email_unverified')
  })
})

describe('campaign and consent routes', () => {
  it('retains consent management and campaign preview/send alongside audience routes', async () => {
    const router = (await import('../routes/marketing')).default
    const routes = (router as unknown as { stack: any[] }).stack
      .filter((l) => l.route)
      .map((l) => ({
        path: l.route.path as string,
        methods: Object.keys(l.route.methods).filter((m) => l.route.methods[m]),
      }))

    const find = (path: string) => routes.find((r) => r.path === path)
    expect(find('/consent/:accountId')?.methods).toContain('patch')
    expect(find('/campaigns/preview')?.methods).toContain('post')
    expect(find('/campaigns/send')?.methods).toContain('post')
    expect(find('/audience')?.methods).toContain('get')
    expect(find('/audience/eligibility')?.methods).toContain('get')

    // No duplicate handlers for the restored paths.
    expect(routes.filter((r) => r.path === '/campaigns/send')).toHaveLength(1)
    expect(routes.filter((r) => r.path === '/campaigns/preview')).toHaveLength(1)
    expect(routes.filter((r) => r.path === '/consent/:accountId')).toHaveLength(1)
  })
})

describe('sync status transport', () => {
  it('reports a pull transport when the pull worker succeeded', async () => {
    const db = await import('../db')
    await db.query(
      `UPDATE sync_status SET last_success_at = now() - interval '1 minute', last_success_transport = 'pull' WHERE id = 1`,
    )
    const { getSyncStatus } = await import('../rayernSync')
    const sync = await getSyncStatus()
    expect(sync.lastSuccessAt).not.toBeNull()
    expect(sync.lastSuccessTransport).toBe('pull')
  })

  it('advances to the newer push transport and keeps it canonical', async () => {
    const { markPushSyncSuccess, getSyncStatus } = await import('../rayernSync')
    await markPushSyncSuccess()
    const sync = await getSyncStatus()
    expect(sync.lastSuccessTransport).toBe('push')
    expect(sync.lastSuccessAt).not.toBeNull()
  })

  it('does not advance success metadata for a failed snapshot', async () => {
    const { ingestRayernSnapshot } = await import('../rayernIngestion')
    const { getSyncStatus } = await import('../rayernSync')

    const before = await getSyncStatus()
    const failed = await ingestRayernSnapshot({
      success: true,
      data: { snapshotId: 'snap-invalid', billing: { currency: 'NGN' } },
    })
    expect(failed.ok).toBe(false)

    const after = await getSyncStatus()
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt)
    expect(after.lastSuccessTransport).toBe('push')
  })

  it('accepts but ignores an older snapshot so newer sync metadata survives', async () => {
    const { ingestRayernSnapshot } = await import('../rayernIngestion')
    const { getSyncStatus } = await import('../rayernSync')

    const payload = (snapshotId: string, generatedAt: string) => ({
      success: true,
      data: {
        snapshotId,
        generatedAt,
        accounts: {
          totalAccounts: 1,
          newAccounts30d: 0,
          verifiedAccounts: 1,
          unverifiedAccounts: 0,
          deletedAccounts30d: 0,
          deletionRequestsPending: 0,
          registrationsTrend: [],
          planBreakdown: [],
        },
        workspaces: null,
        billing: null,
        services: [],
        telemetry: {},
      },
    })

    const newer = await ingestRayernSnapshot(payload('snap-newer', '2026-11-15T12:00:00.000Z'))
    expect(newer.ok).toBe(true)
    const afterNewer = await getSyncStatus()

    const older = await ingestRayernSnapshot(payload('snap-older', '2026-11-14T12:00:00.000Z'))
    expect(older.ok).toBe(true)
    expect(older.idempotent).toBe(true)

    const afterOlder = await getSyncStatus()
    expect(afterOlder.lastSuccessAt).toBe(afterNewer.lastSuccessAt)
    expect(afterOlder.lastSuccessTransport).toBe('push')
  })
})
