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
import { SpanKind } from '@opentelemetry/api'
import { config, rayernSyncEnabled } from './config'
import { query } from './db'
import { recordAudit } from './audit'
import { withSpan } from './telemetry'

/* ----------------------- Approved aggregate contracts ---------------------- */
/* These schemas are the privacy contract with Rayern. Zod strips every field
 * that is not listed here ("strip" is the default mode), so unexpected or
 * private fields are silently ignored — never validated into storage. */

/* Rayern reports `null` for metrics it does not currently track (documented:
 * `deletedAccounts30d`, `deletionRequestsPending`). A missing key and `null`
 * are accepted ONLY as that "not tracked" sentinel and normalized to the
 * field's zero value. Everything else must still satisfy the strict inner
 * schema — non-negative numbers, integers where applicable, bounded
 * percentages, strict date strings, enums — and unknown fields are still
 * stripped. Wrong types ("5", true, -1, {}) remain validation failures. */
const untrackedInt = z.preprocess((v) => (v === null || v === undefined ? 0 : v), z.number().int().min(0))
const untrackedNum = z.preprocess((v) => (v === null || v === undefined ? 0 : v), z.number().min(0))
const untrackedPct = z.preprocess((v) => (v === null || v === undefined ? 100 : v), z.number().min(0).max(100))
const untrackedList = <S extends z.ZodTypeAny>(inner: S, max: number) =>
  z.preprocess((v) => (v === null || v === undefined ? [] : v), z.array(inner).max(max))

const AccountsAggregate = z.object({
  // Core counts Rayern must report — null here is a real contract violation
  // and must fail the sync (keeping the last known good aggregates).
  totalAccounts: z.number().int().min(0),
  newAccounts30d: untrackedInt,
  verifiedAccounts: untrackedInt,
  unverifiedAccounts: untrackedInt,
  deletedAccounts30d: untrackedInt,
  deletionRequestsPending: untrackedInt,
  registrationsTrend: untrackedList(
    z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: untrackedInt }),
    400,
  ),
  // Plan names are Rayern-owned aggregate labels (e.g. 'starter'). Accept any
  // short identifier so an unknown/new plan tier cannot break the whole sync.
  planBreakdown: untrackedList(z.object({ plan: z.string().min(1).max(50), count: untrackedInt }), 20),
})

const WorkspacesAggregate = z.object({
  totalWorkspaces: z.number().int().min(0),
  newWorkspaces30d: untrackedInt,
  avgMembersPerWorkspace: untrackedNum,
  planBreakdown: untrackedList(z.object({ plan: z.string().min(1).max(50), count: untrackedInt }), 20),
})

const ServiceHealth = z.object({
  service: z.string().min(1).max(100),
  kind: z.enum(['api', 'database', 'cache', 'queue', 'email', 'storage']),
  status: z.enum(['healthy', 'degraded', 'failing']),
  uptimePct30d: untrackedPct,
  latencyMsP50: untrackedNum,
  latencyMsP95: untrackedNum,
  lastIncidentAt: z.string().datetime().nullable().default(null),
})

/** A section reported as `null` means "not provided yet" — treat it exactly
 * like a missing section so the previously synchronized copy is kept. */
const optionalSection = <S extends z.ZodTypeAny>(inner: S) =>
  z.preprocess((v) => (v === null || v === undefined ? undefined : v), inner.optional())

export const SyncPayload = z.object({
  accounts: optionalSection(AccountsAggregate),
  workspaces: optionalSection(WorkspacesAggregate),
  services: optionalSection(z.array(ServiceHealth).max(20)),
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
 * response was received — null means transport failure/timeout. A validation
 * failure follows HTTP 200 and correctly keeps 200. */
let lastHttpStatus: number | null = null

async function markAttempt(): Promise<void> {
  await query(
    `UPDATE sync_status
     SET last_attempt_at = now(), updated_at = now()
     WHERE id = 1`,
  )
}

async function markSuccess(sections: string[], durationMs: number, httpStatus: number | null): Promise<void> {
  await query(
    `UPDATE sync_status
     SET last_success_at = now(), last_failure_at = NULL, last_error = NULL,
         consecutive_failures = 0, updated_at = now(),
         last_duration_ms = $1, last_http_status = COALESCE($2, last_http_status)
     WHERE id = 1`,
    [Math.round(durationMs), httpStatus],
  )
  await recordAudit('rayern-sync', 'system', 'sync.completed', 'rayern', { sections: sections.join(', ') })
}

async function markFailure(error: string, durationMs: number | null, httpStatus: number | null): Promise<void> {
  await query(
    `UPDATE sync_status
     SET last_failure_at = now(), last_error = $1,
         consecutive_failures = consecutive_failures + 1, updated_at = now(),
         last_duration_ms = COALESCE($2, last_duration_ms),
         last_http_status = COALESCE($3, last_http_status)
     WHERE id = 1`,
    [error.slice(0, 500), durationMs === null ? null : Math.round(durationMs), httpStatus],
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
  skipped?: 'disabled' | 'already-running' | 'rate-limited'
  error?: string
  sections?: string[]
}

/** Earliest wall-clock time the next pull may run after Rayern sent HTTP 429
 * with a Retry-After header. In-memory only (reset on restart), capped at 1h.
 * The scheduled interval stays the sole retry mechanism — there is never an
 * immediate retry loop. */
let rateLimitedUntil = 0

/** Parses Retry-After: delta-seconds or an HTTP date. Null when absent/invalid. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const secs = Number(header)
  if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs)
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000))
  return null
}

/** Error carrying the HTTP status so failure recording can classify it. */
function httpError(status: number, detail = ''): Error & { status: number } {
  return Object.assign(new Error(`Rayern API responded with HTTP ${status}${detail}`), { status })
}

/** One pull cycle. Safe to call concurrently — overlap is prevented. */
export async function syncOnce(trigger: 'scheduled' | 'manual' | 'boot'): Promise<SyncResult> {
  if (!rayernSyncEnabled()) return { ok: false, skipped: 'disabled' }
  if (running) return { ok: false, skipped: 'already-running' }
  // Rayern told us to back off (HTTP 429 + Retry-After): skip scheduled pulls
  // until the window passes. Nothing is attempted, recorded, or stored here —
  // the previously synced aggregates stay untouched.
  if (Date.now() < rateLimitedUntil) {
    const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000)
    console.log(`[dashboard-sync] skipping pull: Rayern rate-limit window still active (${waitSec}s left) — synced aggregates kept`)
    return { ok: false, skipped: 'rate-limited' }
  }

  running = true
  // Observability: duration + HTTP status of THIS attempt (null until a
  // response is received). Used for sync metrics in the System view.
  let attemptDurationMs: number | null = null
  let attemptHttpStatus: number | null = null
  try {
    await markAttempt()
    const pullStartedAt = Date.now()

    // Timeout guard: never let a hanging Rayern hang the worker.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.rayern.timeoutMs)
    let res: Response
    try {
      // External HTTP CLIENT span, parented to the rayern.sync span. Only the
      // endpoint host + pathname are recorded — never the monitoring token,
      // headers, query strings, or the response body.
      res = await withSpan(
        {
          name: 'rayern.fetch',
          kind: SpanKind.CLIENT,
          service: 'rayern-sync',
          operation: 'rayern.fetch',
          attributes: {
            'server.address': syncEndpointHost(),
            'url.path': syncEndpointPath(),
            'http.request.method': 'GET',
          },
          statusFrom: (value) => (value as Response).status,
          okFrom: (value) => (value as Response).ok,
        },
        async () =>
          fetch(config.rayern.syncEndpoint, {
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
          }),
      )
    } finally {
      clearTimeout(timer)
    }
    attemptDurationMs = Date.now() - pullStartedAt
    attemptHttpStatus = res.status
    lastHttpStatus = res.status

    if (!res.ok) {
      if (res.status === 429) {
        // Rate limited: record the failure, keep the last known good data
        // (storePayload is never reached), and respect Retry-After for when
        // the next scheduled pull may run.
        const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'))
        if (retryAfterSec !== null) {
          rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + Math.min(retryAfterSec, 3_600_000) * 1000)
        }
        console.log(
          `[dashboard-sync] Rayern rate limited (HTTP 429)${retryAfterSec !== null ? `; Retry-After=${retryAfterSec}s` : ''} — failure recorded, previously synced aggregates kept`,
        )
        throw httpError(429, ` (rate limited)${retryAfterSec !== null ? `; retry after ${retryAfterSec}s` : ''}`)
      }
      throw httpError(res.status)
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
      // partial trust boundary violation. Only schema paths of the failing
      // fields are logged (our own field names — never payload values).
      const paths = parsed.error.issues
        .slice(0, 12)
        .map((i) => i.path.join('.') || 'root')
      console.log(
        `[dashboard-sync] validation failed: issues=${parsed.error.issues.length} paths=${paths.join(',')} shape=${describeSyncShape(raw)}`,
      )
      throw new Error(
        `Rayern sync payload failed validation (${parsed.error.issues.length} issue(s), paths: ${paths.join(',')}); nothing was stored`,
      )
    }

    // An empty/sectionless container parses fine (all sections optional) but
    // must NOT be persisted or marked as a healthy sync — that was the original
    // "sections=none" bug. Record it as a failure and keep existing data.
    const hasSections =
      parsed.data.accounts !== undefined ||
      parsed.data.workspaces !== undefined ||
      (parsed.data.services?.length ?? 0) > 0
    if (!hasSections) {
      throw new Error('Rayern sync payload contained no aggregate sections; nothing was stored')
    }

    // Safe diagnostics: aggregate counts only — never the monitoring token,
    // never any customer/personal data.
    console.log(`[dashboard-sync] Rayern metrics received: totalAccounts=${parsed.data.accounts ? parsed.data.accounts.totalAccounts : 'n/a'}`)

    const sections = await storePayload(parsed.data)
    console.log(
      `[dashboard-sync] Rayern metrics persisted: totalAccounts=${parsed.data.accounts ? parsed.data.accounts.totalAccounts : 'n/a'} sections=${sections.join(',') || 'none'}`,
    )
    await markSuccess(sections, attemptDurationMs ?? Date.now() - pullStartedAt, attemptHttpStatus)
    return { ok: true, sections }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `Rayern sync timed out after ${config.rayern.timeoutMs}ms`
          : err.message
        : 'Unknown synchronization error'
    try {
      await markFailure(message, attemptDurationMs, attemptHttpStatus)
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

/** Host of the configured sync endpoint — safe to export in telemetry. */
function syncEndpointHost(): string {
  try {
    return new URL(config.rayern.syncEndpoint).host
  } catch {
    return 'rayern'
  }
}

/** Pathname only (never a query string) of the configured sync endpoint. */
function syncEndpointPath(): string {
  try {
    return new URL(config.rayern.syncEndpoint).pathname
  } catch {
    return '/internal/dashboard-metrics'
  }
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

/** Starts the background pull loop. No-op when sync is not configured. */
export function startSyncWorker(): void {
  if (!rayernSyncEnabled()) {
    console.log('[dashboard-sync] RAYERN_SYNC_ENDPOINT not configured — synchronization disabled (aggregate data will be empty until configured)')
    return
  }
  console.log(
    `[dashboard-sync] pull-sync enabled → GET ${config.rayern.syncEndpoint} every ${formatIntervalMs(config.rayern.intervalMs)}`,
  )
  // First run shortly after boot so the dashboard has data quickly, then on
  // the configured interval. syncOnce guards overlap, so a slow boot run and a
  // scheduled tick can never double-run.
  // Each pull attempt runs inside an INTERNAL OpenTelemetry span so the
  // outbound fetch below is a proper child span. Skipped pulls (rate-limit,
  // overlap) are recorded as non-error outcomes; a failed pull marks the span
  // as an error — the failure-recording behavior of syncOnce is unchanged.
  const tracedSync = (trigger: 'boot' | 'scheduled'): Promise<SyncResult> =>
    withSpan(
      {
        name: 'rayern.sync',
        kind: SpanKind.INTERNAL,
        service: 'rayern-sync',
        operation: 'rayern.sync',
        attributes: { 'rayern.trigger': trigger },
        statusFrom: () => 0,
        okFrom: (value) => {
          const result = value as SyncResult
          return result.ok || result.skipped !== undefined
        },
      },
      () => syncOnce(trigger),
    )
  setTimeout(() => void tracedSync('boot'), 5_000).unref()
  setInterval(() => void tracedSync('scheduled'), config.rayern.intervalMs).unref()
}

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
