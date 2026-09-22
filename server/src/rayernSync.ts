/**
 * Dashboard-side Rayern pull-sync worker.
 *
 * Architecture (section 1–4 of the spec):
 *
 *   Dashboard Sync Service  --GET-->  Rayern API  --JSON-->  Sync Service
 *          --> validate approved aggregates --> Dashboard PostgreSQL
 *
 *  - The dashboard OUTBOUND-polls Rayern. Rayern never calls the dashboard,
 *    never pushes, and never waits for us. Rayern stays fully independent.
 *  - Runs entirely in the dashboard backend's background — never in a request
 *    path. A Rayern outage only means stale data, never a dashboard failure.
 *  - Overlap guard: a sync that is still running prevents a new one.
 *  - Timeout: a hanging Rayern request is aborted; the worker recovers on the
 *    next scheduled run.
 *  - Privacy boundary: the Zod schema below accepts ONLY approved aggregate
 *    shapes. Every other field in Rayern's response is dropped before it can
 *    reach storage, so no customer content can enter the dashboard database
 *    through synchronization.
 *  - Failures are recorded (sync_status + errors table + audit log) and never
 *    delete previously synchronized data.
 */
import { z } from 'zod'
import { config, rayernSyncEnabled } from './config'
import { query } from './db'
import { recordAudit } from './audit'

/* ----------------------- Approved aggregate contracts ---------------------- */
/* These schemas are the privacy contract with Rayern. Zod strips every field
 * that is not listed here ("strip" is the default mode), so unexpected or
 * private fields are silently ignored — never validated into storage. */

const AccountsAggregate = z.object({
  totalAccounts: z.number().int().min(0),
  newAccounts30d: z.number().int().min(0).default(0),
  verifiedAccounts: z.number().int().min(0).default(0),
  unverifiedAccounts: z.number().int().min(0).default(0),
  deletedAccounts30d: z.number().int().min(0).default(0),
  deletionRequestsPending: z.number().int().min(0).default(0),
  registrationsTrend: z
    .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int().min(0) }))
    .max(400)
    .default([]),
  // Plan names are Rayern-owned aggregate labels (e.g. 'starter'). Accept any
  // short identifier so an unknown/new plan tier cannot break the whole sync.
  planBreakdown: z
    .array(z.object({ plan: z.string().min(1).max(50), count: z.number().int().min(0) }))
    .max(20)
    .default([]),
})

const WorkspacesAggregate = z.object({
  totalWorkspaces: z.number().int().min(0),
  newWorkspaces30d: z.number().int().min(0).default(0),
  avgMembersPerWorkspace: z.number().min(0).default(0),
  planBreakdown: z
    .array(z.object({ plan: z.string().min(1).max(50), count: z.number().int().min(0) }))
    .max(20)
    .default([]),
})

const ServiceHealth = z.object({
  service: z.string().min(1).max(100),
  kind: z.enum(['api', 'database', 'cache', 'queue', 'email', 'storage']),
  status: z.enum(['healthy', 'degraded', 'failing']),
  uptimePct30d: z.number().min(0).max(100).default(100),
  latencyMsP50: z.number().min(0).default(0),
  latencyMsP95: z.number().min(0).default(0),
  lastIncidentAt: z.string().datetime().nullable().default(null),
})

export const SyncPayload = z.object({
  accounts: AccountsAggregate.optional(),
  workspaces: WorkspacesAggregate.optional(),
  services: z.array(ServiceHealth).max(20).optional(),
})

export type SyncPayloadData = z.infer<typeof SyncPayload>

/**
 * Rayern's API wraps responses in an envelope:
 *   { success: true,  data: { accounts…, workspaces…, services… } }   (HTTP 200)
 *   { success: false, error: { code, message } }                      (HTTP 40x/5xx)
 *
 * The aggregates must be unwrapped from `data` before validation. This is
 * purely structural: no envelope field other than `data` is read, and the
 * unwrapped value still goes through the full SyncPayload contract below.
 *
 * Returns the aggregate container when an envelope is detected, otherwise the
 * input unchanged (so a future direct bare-payload response keeps working).
 * Returns null only when the envelope declares an explicit failure.
 */
export function unwrapRayernEnvelope(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: true, value: raw }
  const obj = raw as Record<string, unknown>
  // Envelope signature: a boolean `success` flag paired with a `data` container.
  if (typeof obj.success === 'boolean') {
    if (!obj.success) {
      const err =
        typeof obj.error === 'object' && obj.error !== null && 'message' in (obj.error as Record<string, unknown>)
          ? String((obj.error as { message?: unknown }).message)
          : 'Rayern reported failure without an error message'
      return { ok: false, error: `Rayern metrics request reported success=false: ${err.slice(0, 200)}` }
    }
    return { ok: true, value: obj.data ?? {} }
  }
  return { ok: true, value: raw }
}

/**
 * Structural diagnostic of the sync payload — key names and boolean/shape
 * flags only. Never logs values, tokens, or any customer/personal data.
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

/* ------------------------------ Sync state I/O ----------------------------- */

interface SyncStatusRow {
  last_attempt_at: Date | null
  last_success_at: Date | null
  last_failure_at: Date | null
  last_error: string | null
  consecutive_failures: number
  enabled: boolean
}

async function readSyncStatus(): Promise<SyncStatusRow | null> {
  const rows = await query<SyncStatusRow>(
    `SELECT last_attempt_at, last_success_at, last_failure_at, last_error, consecutive_failures, enabled
     FROM sync_status WHERE id = 1`,
  )
  return rows[0] ?? null
}

async function markAttempt(): Promise<void> {
  await query(
    `UPDATE sync_status
     SET last_attempt_at = now(), updated_at = now()
     WHERE id = 1`,
  )
}

async function markSuccess(sections: string[]): Promise<void> {
  await query(
    `UPDATE sync_status
     SET last_success_at = now(), last_failure_at = NULL, last_error = NULL,
         consecutive_failures = 0, updated_at = now()
     WHERE id = 1`,
  )
  await recordAudit('rayern-sync', 'system', 'sync.completed', 'rayern', { sections: sections.join(', ') })
}

async function markFailure(error: string): Promise<void> {
  await query(
    `UPDATE sync_status
     SET last_failure_at = now(), last_error = $1,
         consecutive_failures = consecutive_failures + 1, updated_at = now()
     WHERE id = 1`,
    [error.slice(0, 500)],
  )
}

/** Stores a validated aggregate payload. Never deletes existing sections. */
async function storePayload(data: SyncPayloadData): Promise<string[]> {
  const sections: string[] = []

  const upsertState = async (key: string, value: unknown): Promise<void> => {
    await query(
      `INSERT INTO rayern_sync_state (key, payload, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [key, JSON.stringify(value)],
    )
  }

  if (data.accounts) {
    await upsertState('accounts', data.accounts)
    sections.push('accounts')
  }
  if (data.workspaces) {
    await upsertState('workspaces', data.workspaces)
    sections.push('workspaces')
  }
  if (data.services && data.services.length > 0) {
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
        [s.service, s.kind, s.status, s.uptimePct30d, s.latencyMsP50, s.latencyMsP95, s.lastIncidentAt],
      )
    }
    await upsertState('services', data.services)
    sections.push('services')
  }
  return sections
}

export interface SyncedAggregates {
  accounts: SyncPayloadData['accounts']
  workspaces: SyncPayloadData['workspaces']
  syncedAt: string | null
}

/** Reads the latest synchronized aggregates, if the pull-sync has stored any. */
export async function readSyncedAggregates(): Promise<SyncedAggregates> {
  const rows = await query<{ key: string; payload: unknown; updated_at: Date }>(
    `SELECT key, payload, updated_at FROM rayern_sync_state WHERE key IN ('accounts', 'workspaces')`,
  )
  let accounts: SyncedAggregates['accounts']
  let workspaces: SyncedAggregates['workspaces']
  let latest: Date | null = null
  for (const row of rows) {
    if (latest === null || row.updated_at > latest) latest = row.updated_at
    if (row.key === 'accounts') accounts = row.payload as SyncedAggregates['accounts']
    if (row.key === 'workspaces') workspaces = row.payload as SyncedAggregates['workspaces']
  }
  return { accounts, workspaces, syncedAt: latest ? latest.toISOString() : null }
}

/**
 * Records a synchronization failure as an operational error row so it shows up
 * in the Errors/System views. Deduplicated per message (count increments).
 */
async function recordSyncError(message: string, statusCode: number): Promise<void> {
  const endpoint = config.rayern.syncEndpoint.replace(/^https?:\/\/[^/]+/, '') || '/'
  const updated = await query<{ id: string }>(
    `UPDATE errors SET count = count + 1, last_seen_at = now()
     WHERE service = 'Rayern Sync' AND message = $1
     RETURNING id`,
    [message],
  )
  if (updated.length === 0) {
    await query(
      `INSERT INTO errors (severity, service, endpoint, method, status_code, message, trace_id, count)
       VALUES ($1, 'Rayern Sync', $2, 'GET', $3, $4, NULL, 1)`,
      [statusCode >= 500 ? 'high' : 'medium', endpoint, statusCode, message],
    )
  }
}

/* ------------------------------- The worker -------------------------------- */

let running = false

export function isSyncRunning(): boolean {
  return running
}

export interface SyncResult {
  ok: boolean
  skipped?: 'disabled' | 'already-running'
  error?: string
  sections?: string[]
}

/** One pull cycle. Safe to call concurrently — overlap is prevented. */
export async function syncOnce(trigger: 'scheduled' | 'manual' | 'boot'): Promise<SyncResult> {
  if (!rayernSyncEnabled()) return { ok: false, skipped: 'disabled' }
  if (running) return { ok: false, skipped: 'already-running' }

  running = true
  try {
    await markAttempt()

    // Timeout guard: never let a hanging Rayern hang the worker.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.rayern.timeoutMs)
    let res: Response
    try {
      res = await fetch(config.rayern.syncEndpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          // The monitoring token lives only on this server and is never sent
          // anywhere else — most importantly never to the browser.
          ...(config.rayern.monitoringToken
            ? { Authorization: `Bearer ${config.rayern.monitoringToken}` }
            : {}),
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      throw new Error(`Rayern API responded with HTTP ${res.status}`)
    }

    const raw: unknown = await res.json()

    // Structural diagnostics before validation: shape flags only, never values.
    console.log(`[dashboard-sync] Rayern metrics shape: ${describeSyncShape(raw)}`)

    // Rayern wraps payloads in { success, data } — unwrap before validating.
    // A declared failure (success=false) aborts the cycle without storing.
    const unwrapped = unwrapRayernEnvelope(raw)
    if (!unwrapped.ok) {
      throw new Error(unwrapped.error)
    }

    const parsed = SyncPayload.safeParse(unwrapped.value)
    if (!parsed.success) {
      // Invalid/unrecognized payload: reject entirely rather than storing a
      // partial trust boundary violation. Only the schema path of the first
      // issue is logged — never payload values.
      const firstPath = parsed.error.issues[0]?.path?.join('.') ?? 'unknown'
      console.log(
        `[dashboard-sync] validation failed: issues=${parsed.error.issues.length} firstPath=${firstPath} shape=${describeSyncShape(raw)}`,
      )
      throw new Error(
        `Rayern sync payload failed validation (${parsed.error.issues.length} issue(s), first at ${firstPath}); nothing was stored`,
      )
    }

    // Safe diagnostics: aggregate counts only — never the monitoring token,
    // never any customer/personal data.
    console.log(`[dashboard-sync] Rayern metrics received: totalAccounts=${parsed.data.accounts ? parsed.data.accounts.totalAccounts : 'n/a'}`)

    const sections = await storePayload(parsed.data)
    console.log(
      `[dashboard-sync] Rayern metrics persisted: totalAccounts=${parsed.data.accounts ? parsed.data.accounts.totalAccounts : 'n/a'} sections=${sections.join(',') || 'none'}`,
    )
    await markSuccess(sections)
    return { ok: true, sections }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `Rayern sync timed out after ${config.rayern.timeoutMs}ms`
          : err.message
        : 'Unknown synchronization error'
    try {
      await markFailure(message)
      const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as { status?: number }).status) : 0
      await recordSyncError(message, Number.isFinite(status) ? status : 0)
      await recordAudit('rayern-sync', 'system', 'sync.failed', 'rayern', { error: message.slice(0, 200) })
    } catch (recordErr) {
      // Recording must never crash the worker.
      console.error('[dashboard-sync] failed to record sync failure:', recordErr)
    }
    console.error(`[dashboard-sync] ${trigger} sync failed: ${message}`)
    return { ok: false, error: message }
  } finally {
    running = false
  }
}

/** Starts the background pull loop. No-op when sync is not configured. */
export function startSyncWorker(): void {
  if (!rayernSyncEnabled()) {
    console.log('[dashboard-sync] RAYERN_SYNC_ENDPOINT not configured — synchronization disabled (aggregate data will be empty until configured)')
    return
  }
  console.log(
    `[dashboard-sync] pull-sync enabled → GET ${config.rayern.syncEndpoint} every ${Math.round(config.rayern.intervalMs / 1000)}s`,
  )
  // First run shortly after boot so the dashboard has data quickly, then on
  // the configured interval. syncOnce guards overlap, so a slow boot run and a
  // scheduled tick can never double-run.
  setTimeout(() => void syncOnce('boot'), 5_000).unref()
  setInterval(() => void syncOnce('scheduled'), config.rayern.intervalMs).unref()
}

/** Shape returned by the /system overview for the sync-status card. */
export async function getSyncStatus(): Promise<{
  enabled: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  consecutiveFailures: number
  stale: boolean
  running: boolean
}> {
  let row: SyncStatusRow | null = null
  try {
    row = await readSyncStatus()
  } catch {
    row = null
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
  }
}
