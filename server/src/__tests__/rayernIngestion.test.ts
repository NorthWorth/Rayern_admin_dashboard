import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const EMBEDDED_PORT = 54390

beforeAll(async () => {
  process.env.RAYERN_SNAPSHOT_TOKEN = 'test-snapshot-token'
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
  // nothing
})

describe('rayern snapshot token guard', () => {
  it('rejects when no token is configured', async () => {
    const old = process.env.RAYERN_SNAPSHOT_TOKEN
    delete process.env.RAYERN_SNAPSHOT_TOKEN
    const { requireRayernSnapshotToken } = await import('../auth/rayernSnapshotToken')
    const req = { headers: {} } as Parameters<typeof requireRayernSnapshotToken>[0]
    const res = {
      status: (code: number) => ({
        json: (body: unknown) => {
          expect(code).toBe(401)
          expect((body as { success: boolean }).success).toBe(false)
        },
      }),
    } as Parameters<typeof requireRayernSnapshotToken>[1]
    const next = () => expect.unreachable('should not call next')
    requireRayernSnapshotToken(req, res, next)
    if (old) process.env.RAYERN_SNAPSHOT_TOKEN = old
  })

  it('rejects an invalid token', async () => {
    process.env.RAYERN_SNAPSHOT_TOKEN = 'test-snapshot-token'
    const { requireRayernSnapshotToken } = await import('../auth/rayernSnapshotToken')
    const req = { headers: { authorization: 'Bearer wrong' } } as Parameters<typeof requireRayernSnapshotToken>[0]
    const res = {
      status: (code: number) => ({
        json: (_body: unknown) => {
          expect(code).toBe(401)
        },
      }),
    } as Parameters<typeof requireRayernSnapshotToken>[1]
    const next = () => expect.unreachable('should not call next')
    requireRayernSnapshotToken(req, res, next)
  })

  it('accepts the correct token', async () => {
    process.env.RAYERN_SNAPSHOT_TOKEN = 'test-snapshot-token'
    const { requireRayernSnapshotToken } = await import('../auth/rayernSnapshotToken')
    const req = { headers: { authorization: 'Bearer test-snapshot-token' } } as Parameters<typeof requireRayernSnapshotToken>[0]
    const res = {} as Parameters<typeof requireRayernSnapshotToken>[1]
    let called = false
    requireRayernSnapshotToken(req, res, () => { called = true })
    expect(called).toBe(true)
  })
})

describe('rayern snapshot ingestion', () => {
  it('rejects a payload without snapshotId', async () => {
    const { ingestRayernSnapshot } = await import('../rayernIngestion')
    const result = await ingestRayernSnapshot({ success: true, data: { accounts: { totalAccounts: 1, newAccounts30d: 0, verifiedAccounts: 0, unverifiedAccounts: 1, deletedAccounts30d: 0, deletionRequestsPending: 0, registrationsTrend: [], planBreakdown: [] } } })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
  })

  it('accepts and persists a valid snapshot, then is idempotent on repeat', async () => {
    const { ingestRayernSnapshot, getIngestionStatus } = await import('../rayernIngestion')
    const payload = {
      success: true,
      data: {
        snapshotId: 'snap-1',
        accounts: { totalAccounts: 5, newAccounts30d: 1, verifiedAccounts: 4, unverifiedAccounts: 1, deletedAccounts30d: 0, deletionRequestsPending: 0, registrationsTrend: [], planBreakdown: [] },
        workspaces: null,
        billing: null,
        services: [],
        telemetry: {},
      },
    }
    const first = await ingestRayernSnapshot(payload)
    expect(first.ok).toBe(true)
    expect(first.idempotent).toBeFalsy()
    expect(first.snapshotId).toBe('snap-1')

    const second = await ingestRayernSnapshot(payload)
    expect(second.ok).toBe(true)
    expect(second.idempotent).toBe(true)

    const status = await getIngestionStatus()
    expect(status.lastSnapshotId).toBe('snap-1')
    expect(status.lastSuccessAt).not.toBeNull()
  })

  it('records a failure for an invalid snapshot', async () => {
    const { ingestRayernSnapshot, getIngestionStatus } = await import('../rayernIngestion')
    const before = await getIngestionStatus()
    const result = await ingestRayernSnapshot({ success: true, data: { snapshotId: 'snap-bad', billing: { currency: 'NGN' } } })
    expect(result.ok).toBe(false)
    const after = await getIngestionStatus()
    // consecutive failures incremented or at least lastError set
    expect(after.lastError).not.toBeNull()
    expect(after.consecutiveFailures).toBeGreaterThanOrEqual(before.consecutiveFailures)
  })
})