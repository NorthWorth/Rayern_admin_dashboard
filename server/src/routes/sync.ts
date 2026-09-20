/**
 * POST /sync/rayern — server-to-server ingestion from the Rayern API.
 *
 * STEP 7 architecture: Rayern pushes ONLY pre-aggregated, privacy-safe
 * operational/aggregate data into the dashboard. The dashboard never queries
 * Rayern's database and never accepts individual customer records.
 *
 * Auth: static SYNC_API_KEY via `x-sync-key` header (rotatable server-side).
 * Zod schemas are the privacy boundary: any field not in the allow-list is
 * rejected/ignored, so Rayern cannot accidentally (or maliciously) push
 * customer content into the dashboard.
 */
import { Router } from 'express'
import { z } from 'zod'
import type { Request, Response, NextFunction } from 'express'
import { config } from '../config'
import { query } from '../db'
import { recordAudit } from '../audit'

const router = Router()

function requireSyncKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-sync-key']
  if (!config.syncApiKey || typeof key !== 'string' || key !== config.syncApiKey) {
    res.status(401).json({ error: 'Unauthorized sync call' })
    return
  }
  next()
}

/** Aggregate account counts — no individual accounts accepted. */
const AccountsAggregate = z.object({
  totalAccounts: z.number().int().min(0),
  newAccounts30d: z.number().int().min(0).default(0),
  verifiedAccounts: z.number().int().min(0).default(0),
  unverifiedAccounts: z.number().int().min(0).default(0),
  deletedAccounts30d: z.number().int().min(0).default(0),
  deletionRequestsPending: z.number().int().min(0).default(0),
  registrationsTrend: z.array(z.object({ date: z.string(), count: z.number().int().min(0) })).max(400).default([]),
  planBreakdown: z
    .array(z.object({ plan: z.enum(['free', 'pro', 'team']), count: z.number().int().min(0) }))
    .max(3)
    .default([]),
})

/** Aggregate workspace counts — no individual workspaces accepted. */
const WorkspacesAggregate = z.object({
  totalWorkspaces: z.number().int().min(0),
  newWorkspaces30d: z.number().int().min(0).default(0),
  avgMembersPerWorkspace: z.number().min(0).default(0),
  planBreakdown: z
    .array(z.object({ plan: z.enum(['free', 'pro', 'team']), count: z.number().int().min(0) }))
    .max(3)
    .default([]),
})

/** Operational service health — technical fields only. */
const ServiceHealth = z.object({
  service: z.string().min(1).max(100),
  kind: z.enum(['api', 'database', 'cache', 'queue', 'email', 'storage']),
  status: z.enum(['healthy', 'degraded', 'failing']),
  uptimePct30d: z.number().min(0).max(100).default(100),
  latencyMsP50: z.number().min(0).default(0),
  latencyMsP95: z.number().min(0).default(0),
  lastIncidentAt: z.string().datetime().nullable().default(null),
})

const SyncBody = z.object({
  accounts: AccountsAggregate.optional(),
  workspaces: WorkspacesAggregate.optional(),
  services: z.array(ServiceHealth).max(20).optional(),
})

async function ensureSyncTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS rayern_sync_state (
      key         TEXT PRIMARY KEY,
      payload     JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

router.post('/rayern', requireSyncKey, async (req, res, next) => {
  try {
    const parsed = SyncBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid sync payload', details: parsed.error.issues.slice(0, 5) })
      return
    }
    const body = parsed.data
    await ensureSyncTable()

    for (const [key, value] of Object.entries(body)) {
      await query(
        `INSERT INTO rayern_sync_state (key, payload, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
        [key, JSON.stringify(value)],
      )
    }

    for (const s of body.services ?? []) {
      await query(
        `INSERT INTO service_health (service, kind, status, uptime_pct_30d, latency_p50, latency_p95, last_incident_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (service, kind) DO UPDATE SET
           status = EXCLUDED.status,
           uptime_pct_30d = EXCLUDED.uptime_pct_30d,
           latency_p50 = EXCLUDED.latency_p50,
           latency_p95 = EXCLUDED.latency_p95,
           last_incident_at = EXCLUDED.last_incident_at`,
        [s.service, s.kind, s.status, s.uptimePct30d, s.latencyMsP50, s.latencyMsP95, s.lastIncidentAt],
      )
    }

    await recordAudit('rayern-sync', 'system', 'sync.received', 'rayern', {
      sections: Object.keys(body).join(', '),
    })

    res.json({ ok: true, sections: Object.keys(body) })
  } catch (err) {
    next(err)
  }
})

export default router
