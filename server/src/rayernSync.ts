import { z } from 'zod'

/**
 * Approved aggregate contract for the Rayern pull-sync.
 *
 * IMPORTANT: this schema is the privacy contract with Rayern. Zod strips
 * every field that is not explicitly listed, so unexpected or private fields
 * never reach storage. Unknown top-level keys are still dropped.
 */
const untrackedInt = z.preprocess(
  (v) => (v === null || v === undefined ? 0 : v),
  z.number().int().min(0),
)

const untrackedNum = z.preprocess(
  (v) => (v === null || v === undefined ? 0 : v),
  z.number().min(0),
)

const untrackedPct = z.preprocess(
  (v) => (v === null || v === undefined ? 100 : v),
  z.number().min(0).max(100),
)

const untrackedList = <S extends z.ZodTypeAny>(inner: S, max: number) =>
  z.preprocess(
    (v) => (v === null || v === undefined ? [] : v),
    z.array(inner).max(max),
  )

const AccountPlanBreakdownEntry = z.object({
  plan: z.string().min(1).max(50),
  count: untrackedInt,
})

const MrrByPlanEntry = z.object({
  plan: z.string().min(1).max(50),
  subscriberCount: untrackedInt,
  mrrMinor: z.number().int().min(0),
})

const PlanBreakdownEntry = z.object({
  plan: z.string().min(1).max(50),
  userCount: z.number().int().min(0),
  subscriptionCount: z.number().int().min(0),
  isPaid: z.boolean(),
})

export const SyncPayload = z.object({
  accounts: z
    .object({
      totalAccounts: z.number().int().min(0),
      newAccounts30d: untrackedInt,
      verifiedAccounts: untrackedInt,
      unverifiedAccounts: untrackedInt,
      deletedAccounts30d: z.number().int().min(0).nullable(),
      deletionRequestsPending: z.number().int().min(0).nullable(),
      registrationsTrend: untrackedList(
        z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: untrackedInt }),
        400,
      ),
      planBreakdown: untrackedList(AccountPlanBreakdownEntry, 20),
    })
    .nullable()
    .optional(),
  workspaces: z
    .object({
      totalWorkspaces: z.number().int().min(0),
      newWorkspaces30d: untrackedInt,
      avgMembersPerWorkspace: untrackedNum,
      planBreakdown: untrackedList(AccountPlanBreakdownEntry, 20),
    })
    .nullable()
    .optional(),
  billing: z
    .object({
      currency: z.literal('USD'),
      amountUnit: z.literal('minor_units'),
      generatedAt: z.string().datetime(),
      activePaidSubscribers: z.number().int().min(0),
      freeUsers: z.number().int().min(0),
      totalAccounts: z.number().int().min(0),
      mrr: z.object({
        amountMinor: z.number().int().min(0),
        amountMajor: z.number(),
        byPlan: untrackedList(MrrByPlanEntry, 20),
      }),
      arr: z.object({
        amountMinor: z.number().int().min(0),
        amountMajor: z.number(),
        definition: z.string(),
      }),
      planBreakdown: untrackedList(PlanBreakdownEntry, 20),
      definitions: z.record(z.string(), z.unknown()),
    })
    .nullable()
    .optional(),
  services: z
    .array(
      z.object({
        service: z.string().min(1).max(100),
        kind: z.enum(['api', 'database', 'cache', 'queue', 'email', 'storage']),
        status: z.enum(['healthy', 'degraded', 'failing']),
        uptimePct30d: untrackedPct.nullable(),
        latencyMsP50: untrackedNum.nullable(),
        latencyMsP95: untrackedNum.nullable(),
        lastIncidentAt: z.string().datetime().nullable().default(null),
      }),
    )
    .max(20)
    .nullable()
    .optional(),
  telemetry: z.record(z.string(), z.unknown()).nullable().optional(),
})

export type SyncPayloadData = z.infer<typeof SyncPayload>

/**
 * Unwrap the Rayern envelope. Rayern wraps successful responses as:
 *
 *   { success: true, data: <payload> }
 *
 * and error responses as:
 *
 *   { success: false, error: { code, message } }
 *
 * Unknown shapes are returned unchanged so a future direct payload still works,
 * but an explicit failure stops the sync without storing anything.
 */
export function unwrapRayernEnvelope(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: true, value: raw }
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj.success === 'boolean') {
    if (!obj.success) {
      const message =
        typeof obj.error === 'object' &&
        obj.error !== null &&
        'message' in obj.error
          ? String((obj.error as { message?: unknown }).message)
          : 'Rayern reported failure without a message'
      return { ok: false, error: `Rayern metrics request reported success=false: ${message.slice(0, 200)}` }
    }

    return { ok: true, value: obj.data ?? {} }
  }

  return { ok: true, value: raw }
}

/**
 * Persist the validated payload so the dashboard API can serve it later.
 *
 * Storage uses the same `rayern_sync_state` table as the existing sync.
 * Billing is stored under its own key so it can be refreshed independently
 * without disturbing accounts/workspaces.
 */
export async function storePayload(data: SyncPayloadData): Promise<string[]> {
  const sections: string[] = []

  const upsertState = async (key: string, value: unknown): Promise<void> => {
    await query(
      `INSERT INTO rayern_sync_state (key, payload, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [key, JSON.stringify(value)],
    )
  }

  if (data.accounts !== undefined && data.accounts !== null) {
    await upsertState('accounts', data.accounts)
    sections.push('accounts')
  }

  if (data.workspaces !== undefined && data.workspaces !== null) {
    await upsertState('workspaces', data.workspaces)
    sections.push('workspaces')
  }

  if (data.billing !== undefined && data.billing !== null) {
    await upsertState('billing', data.billing)
    sections.push('billing')
  }

  if (data.services !== undefined && data.services !== null && data.services.length > 0) {
    for (const s of data.services) {
      await query(
        `INSERT INTO service_health (service, kind, status, uptime_pct_30d, latency_p50, latency_p95, last_incident_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (service, kind) DO UPDATE SET
           status = EXCLUDED.status,
           uptime_pct_30d = EXCLUDED.uptime_pct_30d,
           latency_p50 = EXCLUDED.latency_p50,
           latency_p95 = EXCLUDED.latency_p95,
           last_incident_at = EXCLUDED.last_incident_at`,
        [
          s.service,
          s.kind,
          s.status,
          s.uptimePct30d,
          s.latencyMsP50,
          s.latencyMsP95,
          s.lastIncidentAt,
        ],
      )
    }
    await upsertState('services', data.services)
    sections.push('services')
  }

  if (data.telemetry !== undefined && data.telemetry !== null) {
    await upsertState('telemetry', data.telemetry)
    sections.push('telemetry')
  }

  return sections
}

/**
 * Read the latest synchronized aggregates from `rayern_sync_state`.
 *
 * Returns whichever sections have been persisted, with a shared
 * `syncedAt` timestamp taken from the most recent write.
 */
export async function readSyncedAggregates(): Promise<{
  accounts: SyncPayloadData['accounts']
  workspaces: SyncPayloadData['workspaces']
  billing: SyncPayloadData['billing']
  services: SyncPayloadData['services']
  telemetry: SyncPayloadData['telemetry']
  syncedAt: string | null
}> {
  const rows = await query<{ key: string; payload: unknown; updated_at: Date }>(
    `SELECT key, payload, updated_at
     FROM rayern_sync_state
     WHERE key IN ('accounts', 'workspaces', 'billing', 'services', 'telemetry')`,
  )

  let accounts: SyncPayloadData['accounts'] = undefined as unknown as SyncPayloadData['accounts']
  let workspaces: SyncPayloadData['workspaces'] = undefined as unknown as SyncPayloadData['workspaces']
  let billing: SyncPayloadData['billing'] = undefined as unknown as SyncPayloadData['billing']
  let services: SyncPayloadData['services'] = undefined as unknown as SyncPayloadData['services']
  let telemetry: SyncPayloadData['telemetry'] = undefined as unknown as SyncPayloadData['telemetry']
  let latest: Date | null = null

  for (const row of rows) {
    if (latest === null || row.updated_at > latest) {
      latest = row.updated_at
    }
    switch (row.key) {
      case 'accounts':
        accounts = row.payload as SyncPayloadData['accounts']
        break
      case 'workspaces':
        workspaces = row.payload as SyncPayloadData['workspaces']
        break
      case 'billing':
        billing = row.payload as SyncPayloadData['billing']
        break
      case 'services':
        services = row.payload as SyncPayloadData['services']
        break
      case 'telemetry':
        telemetry = row.payload as SyncPayloadData['telemetry']
        break
    }
  }

  return {
    accounts,
    workspaces,
    billing,
    services,
    telemetry,
    syncedAt: latest ? latest.toISOString() : null,
  }
}

// Re-export query because this module already owns the persistence helpers.
import { query } from './db'
import { config, rayernSyncEnabled } from './config'

/* ------------------- Restored payload/sync observability ------------------ */

/**
 * Describes the SHAPE of a Rayern payload for operational logging: which
 * top-level keys/flags are present. Never logs values, tokens, or any
 * customer/personal data.
 */
export function describeSyncShape(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return `root:${typeof raw}`
  const obj = raw as Record<string, unknown>
  const flags: string[] = []
  if (typeof obj.success === 'boolean') flags.push(`success=${obj.success}`)
  const container = unwrapRayernEnvelope(raw)
  const inner = container.ok && typeof container.value === 'object' && container.value !== null ? (container.value as Record<string, unknown>) : {}
  if ('data' in obj) flags.push('hasData=true')
  if (inner.accounts !== undefined) flags.push('accounts=true')
  if (inner.workspaces !== undefined) flags.push('workspaces=true')
  if (Array.isArray(inner.services)) flags.push(`services=${inner.services.length}`)
  if (Object.keys(inner).length === 0) flags.push('container=empty')
  return flags.join(' ') || 'unrecognized'
}

/**
 * Human-readable interval for the startup log, derived from the ACTUAL
 * configured value so the log can never disagree with the schedule:
 *   1_800_000 → "30m" · 600_000 → "10m" · 4_000 → "4s"
 */
export function formatIntervalMs(ms: number): string {
  const minutes = ms / 60_000
  if (Number.isInteger(minutes) && minutes >= 1) return `${minutes}m`
  const seconds = Math.round(ms / 1000)
  return seconds >= 60 ? `${Math.round(minutes)}m` : `${seconds}s`
}

/* ------------------------------ Sync state I/O ----------------------------- */

interface SyncStatusRow {
  last_attempt_at: Date | null
  last_success_at: Date | null
  last_failure_at: Date | null
  last_error: string | null
  consecutive_failures: number
  enabled: boolean
  last_duration_ms: number | null
  last_http_status: number | null
}

async function readSyncStatus(): Promise<SyncStatusRow | null> {
  const rows = await query<SyncStatusRow>(
    `SELECT last_attempt_at, last_success_at, last_failure_at, last_error, consecutive_failures, enabled,
            last_duration_ms, last_http_status
     FROM sync_status WHERE id = 1`,
  )
  return rows[0] ?? null
}

/** Last observed Rayern HTTP status for the most recent attempt (fallback for
 * reads before the first persisted flush). Only set when an actual HTTP
 * response was received — null means transport failure/timeout. */
let lastHttpStatus: number | null = null
let running = false
let rateLimitedUntil = 0

/**
 * Shape returned by the /system overview for the sync-status card.
 * Includes full operational sync observability: duration, last HTTP status,
 * the timestamp of the last SUCCESSFULLY STORED data (distinct from the last
 * attempt — a failed attempt never moves it), and any active rate-limit window.
 */
export async function getSyncStatus(): Promise<{
  enabled: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  consecutiveFailures: number
  stale: boolean
  running: boolean
  lastDurationMs: number | null
  lastHttpStatus: number | null
  dataUpdatedAt: string | null
  intervalMs: number
  rateLimitedUntil: string | null
}> {
  let row: SyncStatusRow | null = null
  try {
    row = await readSyncStatus()
  } catch {
    row = null
  }
  // Last timestamp at which valid aggregate data was actually WRITTEN — a
  // failed sync (401/429/timeout/validation) never advances it, so "data age"
  // honestly reflects the last known good state.
  let dataUpdatedAt: string | null = null
  try {
    const rows = await query<{ updated_at: Date }>(
      `SELECT max(updated_at) AS updated_at FROM rayern_sync_state`,
    )
    const at = rows[0]?.updated_at
    if (at instanceof Date && !Number.isNaN(at.getTime())) dataUpdatedAt = at.toISOString()
  } catch {
    dataUpdatedAt = null
  }
  const lastSuccessAt = row?.last_success_at?.toISOString() ?? null
  const stale =
    rayernSyncEnabled() &&
    (lastSuccessAt === null || Date.now() - new Date(lastSuccessAt).getTime() > config.rayern.intervalMs * 2.5)
  return {
    enabled: rayernSyncEnabled(),
    lastAttemptAt: row?.last_attempt_at?.toISOString() ?? null,
    lastSuccessAt,
    lastFailureAt: row?.last_failure_at?.toISOString() ?? null,
    lastError: row?.last_error ?? null,
    consecutiveFailures: row?.consecutive_failures ?? 0,
    stale,
    running,
    lastDurationMs: row?.last_duration_ms ?? null,
    lastHttpStatus: row?.last_http_status ?? lastHttpStatus,
    dataUpdatedAt,
    intervalMs: config.rayern.intervalMs,
    rateLimitedUntil: rateLimitedUntil > Date.now() ? new Date(rateLimitedUntil).toISOString() : null,
  }
}
