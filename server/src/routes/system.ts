/**
 * System routes — technical/operational health only.
 *
 * The backend owns ALL health calculation: every status in these responses is
 * derived from real telemetry (rolling windows, freshness, configured
 * thresholds) — the frontend never decides health itself. Four states are
 * possible: healthy / degraded / failing / unknown (no or stale telemetry).
 *
 * Services marked "self" report this dashboard backend's own live status.
 * Rayern-side rows in service_health arrive via the dashboard pull-sync worker
 * (rayernSync.ts); when that data is stale the row reports `unknown` with the
 * Rayern-reported state preserved as `reportedStatus` — old data is never
 * presented as a current confirmation of health.
 *
 * Dependencies are ONLY the real ones this backend talks to: PostgreSQL,
 * the Rayern metrics endpoint, and Resend (email sending). No invented deps.
 */
import { Router } from 'express'
import { z } from 'zod'
import { pool, isDbReady, query, USING_EMBEDDED_DB } from '../db'
import { config, rayernSyncEnabled } from '../config'
import { getSyncStatus } from '../rayernSync'
import {
  computeApiHealth,
  computeDbHealth,
  computeServiceStatus,
  runtimeSnapshot,
  worstHealth,
} from '../telemetry'
import type { ComponentHealthStatus, TelemetryFreshness } from '../telemetry'

const router = Router()

type HealthStatus = ComponentHealthStatus
type ServiceKind = 'api' | 'database' | 'cache' | 'queue' | 'email' | 'storage'

/** Freshness block: absence/staleness of telemetry, explicitly exposed. */
interface FreshnessView {
  lastTelemetryAt: string | null
  ageMs: number | null
  status: TelemetryFreshness
}

function freshnessView(
  lastTelemetryAt: number | null,
  ageMs: number | null,
  status: TelemetryFreshness,
): FreshnessView {
  return {
    lastTelemetryAt: lastTelemetryAt === null ? null : new Date(lastTelemetryAt).toISOString(),
    ageMs,
    status,
  }
}

/** Service row as served to the UI — null = insufficient telemetry (never faked). */
interface ServiceRowView {
  id: string
  name: string
  kind: ServiceKind
  status: HealthStatus
  /** Trigger/summary for the current state (why the backend decided it). */
  reason: string | null
  dataSource: 'self' | 'rayern-sync'
  /** What Rayern reported, when staleness overrode it with `unknown`. */
  reportedStatus: HealthStatus | null
  uptimePct30d: number | null
  latencyMsP50: number | null
  latencyMsP95: number | null
  lastIncidentAt: string | null
  requestCount: number | null
  successCount: number | null
  errorRatePct: number | null
  rpm: number | null
  slowCount: number | null
  statusClasses: { c2: number; c3: number; c4: number; c5: number } | null
  freshness: FreshnessView
  lastChange: { at: string; from: HealthStatus; to: HealthStatus; reason: string } | null
  /** Telemetry-service key for /system/history drill-down (null = no local history). */
  historyKey: string | null
}

interface DependencyRowView {
  id: string
  name: string
  kind: 'database' | 'api' | 'email'
  status: HealthStatus
  reason: string | null
  availabilityPct: number | null
  requestCount: number | null
  errorCount: number | null
  errorRatePct: number | null
  p95Ms: number | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastObservedAt: string | null
  freshness: FreshnessView
  /** False when the dependency is not actually configured (then status is unknown). */
  configured: boolean
  /** Small bounded operational detail lines (pool pressure, sync cadence, …). */
  detail: Array<{ label: string; value: string }>
  /** Telemetry-service key for /system/history drill-down. */
  historyKey: string | null
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

/** Latest persisted state transition per service (for "last change" columns). */
async function latestTransitions(
  services: string[],
): Promise<Map<string, { at: string; from: HealthStatus; to: HealthStatus; reason: string }>> {
  const out = new Map<string, { at: string; from: HealthStatus; to: HealthStatus; reason: string }>()
  if (services.length === 0) return out
  const rows = await query<{ service: string; from_status: string; to_status: string; reason: string; triggered_at: Date }>(
    `SELECT DISTINCT ON (service) service, from_status, to_status, reason, triggered_at
     FROM health_transitions
     WHERE service = ANY($1)
     ORDER BY service, triggered_at DESC`,
    [services],
  )
  for (const r of rows) {
    out.set(r.service, {
      at: r.triggered_at.toISOString(),
      from: r.from_status as HealthStatus,
      to: r.to_status as HealthStatus,
      reason: r.reason,
    })
  }
  return out
}

/* ------------------------------ Overview --------------------------------- */

router.get('/overview', async (_req, res, next) => {
  try {
    // Real database health check (also recorded as a live postgres observation).
    const dbStart = Date.now()
    await pool.query('SELECT 1')
    const dbLatencyMs = Date.now() - dbStart

    const runtime = runtimeSnapshot()
    const sync = await getSyncStatus()

    const serviceRows = await pool.query<{
      service: string
      kind: string
      status: string
      uptime_pct_30d: string
      latency_p50: string
      latency_p95: string
      last_incident_at: Date | null
    }>(
      `SELECT service, kind, status, uptime_pct_30d, latency_p50, latency_p95, last_incident_at
       FROM service_health ORDER BY service`,
    )

    const apiHealth = computeApiHealth()
    const dbHealth = computeDbHealth()

    // Sync health as its OWN signal (spec §17): distinct from the Rayern API
    // service rows above. A 429 means Rayern is reachable but the metrics
    // pull is rate-limited — the API is not failing.
    const syncStatus: HealthStatus = !sync.enabled
      ? 'unknown'
      : sync.consecutiveFailures >= 3 || (sync.stale && sync.lastSuccessAt !== null)
        ? 'failing'
        : sync.consecutiveFailures >= 1 || sync.lastSuccessAt === null
          ? 'degraded'
          : 'healthy'

    const services: ServiceRowView[] = []
    // Rayern-reported rows: their freshness is the freshness of the sync that
    // delivered them. Stale (or never-synced) data cannot confirm health.
    for (const r of serviceRows.rows) {
      const rayernReported = r.status as HealthStatus
      const syncedFresh = sync.enabled && !sync.stale && sync.lastSuccessAt !== null
      const status: HealthStatus = syncedFresh ? rayernReported : 'unknown'
      services.push({
        id: `${r.kind}:${r.service}`,
        name: r.service,
        kind: r.kind as ServiceKind,
        status,
        reason: syncedFresh
          ? 'reported by Rayern with the latest successful sync'
          : sync.enabled
            ? 'Rayern sync data is stale or has never succeeded — see the metrics-sync signal below'
            : 'Rayern synchronization is not configured',
        dataSource: 'rayern-sync',
        reportedStatus: status === 'unknown' ? rayernReported : null,
        uptimePct30d: Number(r.uptime_pct_30d),
        latencyMsP50: Number(r.latency_p50),
        latencyMsP95: Number(r.latency_p95),
        lastIncidentAt: r.last_incident_at ? r.last_incident_at.toISOString() : null,
        // Synced rows carry only Rayern's reported aggregates — no local
        // request-level series exists for them.
        requestCount: null,
        successCount: null,
        errorRatePct: null,
        rpm: null,
        slowCount: null,
        statusClasses: null,
        freshness: {
          lastTelemetryAt: iso(sync.lastSuccessAt ? new Date(sync.lastSuccessAt).getTime() : null),
          ageMs: sync.lastSuccessAt ? Date.now() - new Date(sync.lastSuccessAt).getTime() : null,
          status: sync.lastSuccessAt === null ? 'none' : sync.stale ? 'stale' : 'fresh',
        },
        lastChange: null,
        // Rayern-reported rows have no local request history to drill into.
        historyKey: null,
      })
    }

    // The dashboard's OWN rows are synthesized from real in-process telemetry.
    // Availability / latency stay null until the rolling window has samples —
    // never a fake 100% uptime or 0ms latency.
    const selfDefs: Array<{ health: typeof apiHealth; name: string; kind: ServiceKind }> = [
      { health: dbHealth, name: 'PostgreSQL', kind: 'database' },
      { health: apiHealth, name: 'Dashboard API', kind: 'api' },
    ]
    const transitions = await latestTransitions(['dashboard-api', 'postgres'])

    for (const def of selfDefs) {
      if (services.some((s) => s.name === def.name)) continue
      const key = def.name === 'PostgreSQL' ? 'postgres' : 'dashboard-api'
      const lastChange = transitions.get(key) ?? null
      // Spec §19: "Last incident" IS the last recorded health-state change
      // (the same source the transitions timeline shows) — never invented,
      // never claimed as null when a real transition exists.
      const lastIncidentAt = lastChange && lastChange.to !== 'healthy' ? lastChange.at : null
      services.unshift({
        id: `${def.kind}:${def.name === 'PostgreSQL' ? 'PostgreSQL' : 'dashboard-backend'}`,
        name: def.name,
        kind: def.kind,
        status: def.health.status,
        reason: def.health.reason,
        dataSource: 'self',
        reportedStatus: null,
        uptimePct30d: def.health.availabilityPct,
        latencyMsP50: def.health.p50Ms,
        latencyMsP95: def.health.p95Ms,
        lastIncidentAt,
        requestCount: def.health.sampleCount,
        successCount: def.health.successCount,
        errorRatePct: def.health.errorRatePct,
        rpm: def.health.rpm,
        slowCount: def.health.slowCount,
        statusClasses: def.health.classes,
        freshness: freshnessView(def.health.lastTelemetryAt, def.health.telemetryAgeMs, def.health.freshness),
        lastChange,
        historyKey: key,
      })
    }

    /* ------------------------------ Dependencies ---------------------------- */

    const rayernService = computeServiceStatus('rayern-sync')
    const resendHealth = computeServiceStatus('resend')
    const resendConfigured = Boolean(config.resendApiKey)
    const poolStats = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }

    const dependencies: DependencyRowView[] = [
      {
        id: 'dep:postgresql',
        name: 'PostgreSQL',
        kind: 'database',
        status: dbHealth.status,
        reason: dbHealth.reason,
        availabilityPct: dbHealth.availabilityPct,
        requestCount: dbHealth.sampleCount,
        errorCount: dbHealth.errorCount,
        errorRatePct: dbHealth.errorRatePct,
        p95Ms: dbHealth.p95Ms,
        lastSuccessAt: iso(dbHealth.lastSuccessAt),
        lastFailureAt: iso(dbHealth.lastFailureAt),
        lastObservedAt: iso(dbHealth.lastTelemetryAt),
        freshness: freshnessView(dbHealth.lastTelemetryAt, dbHealth.telemetryAgeMs, dbHealth.freshness),
        configured: true,
        detail: [
          { label: 'Probe', value: isDbReady() ? `reachable in ${dbLatencyMs}ms` : 'unavailable (degraded mode)' },
          { label: 'Pool', value: `${poolStats.total} open · ${poolStats.idle} idle · ${poolStats.waiting} waiting` },
          { label: 'Mode', value: USING_EMBEDDED_DB ? 'embedded (dev)' : 'managed' },
        ],
        historyKey: 'postgres',
      },
      {
        id: 'dep:rayern-metrics',
        name: 'Rayern metrics endpoint',
        kind: 'api',
        status: rayernSyncEnabled() ? rayernService.status : 'unknown',
        reason: rayernSyncEnabled() ? rayernService.reason : 'RAYERN_SYNC_ENDPOINT is not configured',
        availabilityPct: rayernSyncEnabled() ? rayernService.availabilityPct : null,
        requestCount: rayernSyncEnabled() ? rayernService.sampleCount : null,
        errorCount: rayernSyncEnabled() ? rayernService.errorCount : null,
        errorRatePct: rayernSyncEnabled() ? rayernService.errorRatePct : null,
        p95Ms: rayernSyncEnabled() ? rayernService.p95Ms : null,
        lastSuccessAt: iso(rayernService.lastSuccessAt),
        lastFailureAt: iso(rayernService.lastFailureAt),
        lastObservedAt: iso(rayernService.lastTelemetryAt),
        freshness: rayernSyncEnabled()
          ? freshnessView(rayernService.lastTelemetryAt, rayernService.telemetryAgeMs, rayernService.freshness)
          : freshnessView(null, null, 'none'),
        configured: rayernSyncEnabled(),
        detail: [
          { label: 'Pull interval', value: `${Math.round(config.rayern.intervalMs / 60_000)}m` },
          { label: 'Last pull', value: sync.lastDurationMs !== null ? `${sync.lastDurationMs}ms` : '—' },
          { label: 'Last HTTP', value: sync.lastHttpStatus !== null ? String(sync.lastHttpStatus) : '—' },
          { label: 'Consecutive failures', value: String(sync.consecutiveFailures) },
          ...(sync.rateLimitedUntil
            ? [{ label: 'Rate limited until', value: new Date(sync.rateLimitedUntil).toLocaleTimeString() }]
            : []),
          { label: 'Data updated', value: sync.dataUpdatedAt ? new Date(sync.dataUpdatedAt).toLocaleString() : 'never' },
        ],
        historyKey: 'rayern-sync',
      },
      {
        id: 'dep:resend',
        name: 'Resend (email sending)',
        kind: 'email',
        status: resendConfigured ? resendHealth.status : 'unknown',
        reason: resendConfigured
          ? resendHealth.reason
          : 'RESEND_API_KEY is not configured — sends are unavailable',
        availabilityPct: resendConfigured ? resendHealth.availabilityPct : null,
        requestCount: resendConfigured ? resendHealth.sampleCount : null,
        errorCount: resendConfigured ? resendHealth.errorCount : null,
        errorRatePct: resendConfigured ? resendHealth.errorRatePct : null,
        p95Ms: resendConfigured ? resendHealth.p95Ms : null,
        lastSuccessAt: iso(resendHealth.lastSuccessAt),
        lastFailureAt: iso(resendHealth.lastFailureAt),
        lastObservedAt: iso(resendHealth.lastTelemetryAt),
        freshness: resendConfigured
          ? freshnessView(resendHealth.lastTelemetryAt, resendHealth.telemetryAgeMs, resendHealth.freshness)
          : freshnessView(null, null, 'none'),
        configured: resendConfigured,
        detail: [
          { label: 'Observed via', value: 'admin-initiated sends (resend.send spans)' },
          ...(config.emailDryRun ? [{ label: 'Mode', value: 'EMAIL_DRY_RUN (no real sends)' }] : []),
        ],
        historyKey: 'resend',
      },
    ]

    /* ------------------------------- Overall -------------------------------- */

    // Worst state across services + dependencies. `unknown` never inflates the
    // overall status; all-unknown (fresh install, no traffic) reports unknown.
    const overall = worstHealth([
      ...services.map((s) => s.status),
      ...dependencies.filter((d) => d.configured).map((d) => d.status),
    ])

    const volumeRows = await pool.query<{ bucket: string; count: string; errors: string }>(
      `SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
              COUNT(r.id)::text AS count,
              COUNT(r.id) FILTER (WHERE r.status_code >= 500)::text AS errors
       FROM generate_series(
         date_trunc('hour', now() - interval '23 hours'),
         date_trunc('hour', now()),
         interval '1 hour'
       ) AS b(bucket)
       LEFT JOIN request_log r ON date_trunc('hour', r.time) = b.bucket
       GROUP BY b.bucket ORDER BY b.bucket`,
    )

    const latencyRows = await pool.query<{ p50: string; p90: string; p95: string; p99: string }>(
      `SELECT
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::text AS p50,
         COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms), 0)::text AS p90,
         COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::text AS p95,
         COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::text AS p99
       FROM request_log
       WHERE time >= now() - interval '24 hours'`,
    )

    const totalRows = await pool.query<{ total: string; errors: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status_code >= 500)::text AS errors
       FROM request_log WHERE time >= now() - interval '24 hours'`,
    )

    // Recent failures (spec §20): first/last observed + occurrences, from the
    // deduplicated errors table. Route labels are already normalized
    // templates (telemetry layer) — never raw URLs with ids.
    const failureRows = await pool.query<{
      id: string
      service: string
      endpoint: string
      method: string
      status_code: number
      message: string
      count: string
      first_seen_at: Date
      last_seen_at: Date
    }>(
      `SELECT id, service, endpoint, method, status_code, message, count, first_seen_at, last_seen_at
       FROM errors
       WHERE severity IN ('high','critical') OR status_code >= 500
       ORDER BY last_seen_at DESC LIMIT 8`,
    )

    const total24h = Number(totalRows.rows[0]?.total ?? 0)
    const errors24h = Number(totalRows.rows[0]?.errors ?? 0)
    // With no requests in the window there is nothing to measure — report
    // null ("unavailable") rather than a fake 0% error rate / 0ms latency.
    const has24hData = total24h > 0

    res.json({
      overall,
      services,
      dependencies,
      requestVolume: volumeRows.rows.map((r) => ({
        time: r.bucket,
        count: Number(r.count),
        errors: Number(r.errors),
      })),
      errorRatePct: has24hData ? Number(((errors24h / total24h) * 100).toFixed(2)) : null,
      requestCount24h: total24h,
      latency: {
        p50: has24hData ? Number(latencyRows.rows[0]?.p50 ?? 0) : null,
        p90: has24hData ? Number(latencyRows.rows[0]?.p90 ?? 0) : null,
        p95: has24hData ? Number(latencyRows.rows[0]?.p95 ?? 0) : null,
        p99: has24hData ? Number(latencyRows.rows[0]?.p99 ?? 0) : null,
      },
      recentFailures: failureRows.rows.map((r) => ({
        id: r.id,
        service: r.service,
        route: r.method && r.endpoint ? `${r.method} ${r.endpoint}` : r.endpoint,
        statusCategory: r.status_code >= 100 && r.status_code < 600 ? `${Math.floor(r.status_code / 100)}xx` : 'error',
        time: r.last_seen_at.toISOString(),
        firstSeenAt: r.first_seen_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        message: r.message,
        count: Number(r.count),
      })),
      overallSummary: {
        // Explainability (spec §21): the backend owns the rollup AND its
        // explanation — the frontend never recomputes health.
        failing: [...services, ...dependencies.filter((d) => d.configured)].filter((s) => s.status === 'failing').map((s) => s.name),
        degraded: [...services, ...dependencies.filter((d) => d.configured)].filter((s) => s.status === 'degraded').map((s) => s.name),
        healthy: [...services, ...dependencies.filter((d) => d.configured)].filter((s) => s.status === 'healthy').length,
        unknown: [...services, ...dependencies.filter((d) => d.configured)].filter((s) => s.status === 'unknown').length,
      },
      sync: {
        enabled: sync.enabled,
        status: syncStatus,
        lastSuccessAt: sync.lastSuccessAt,
        lastAttemptAt: sync.lastAttemptAt,
        lastFailureAt: sync.lastFailureAt,
        lastError: sync.lastError,
        consecutiveFailures: sync.consecutiveFailures,
        stale: sync.stale,
        running: sync.running,
        lastDurationMs: sync.lastDurationMs,
        lastHttpStatus: sync.lastHttpStatus,
        dataUpdatedAt: sync.dataUpdatedAt,
        intervalMs: sync.intervalMs,
        rateLimitedUntil: sync.rateLimitedUntil,
      },
      metricsSync: {
        // Spec §17: an explicit, separate signal for the metrics-PULL process
        // — never conflated with the Rayern API's own health. The reason
        // names the exact condition (rate-limited / failing / stale / healthy).
        status: syncStatus,
        reason: !sync.enabled
          ? 'Rayern synchronization is not configured'
          : sync.rateLimitedUntil
            ? `429 rate limited — next pull after ${sync.rateLimitedUntil}`
            : sync.consecutiveFailures > 0
              ? `${sync.consecutiveFailures} consecutive pull failure(s) — data age ${sync.dataUpdatedAt ? Math.round((Date.now() - new Date(sync.dataUpdatedAt).getTime()) / 60_000) + 'm' : 'n/a'}`
              : syncStatus === 'healthy'
                ? 'pulls succeeding on schedule'
                : 'no successful pull yet',
        dataAgeMs: sync.dataUpdatedAt !== null ? Date.now() - new Date(sync.dataUpdatedAt).getTime() : null,
      },
      meta: {
        processUptimeSec: runtime.uptimeSec,
        dbLatencyMs,
        rssBytes: runtime.rssBytes,
        heapUsedBytes: runtime.heapUsedBytes,
        heapTotalBytes: runtime.heapTotalBytes,
        // Real runtime/process telemetry — null when telemetry is disabled or
        // the runtime cannot measure it (never a fabricated 0).
        cpuPercent: runtime.cpuPercent,
        eventLoopDelayP95Ms: runtime.eventLoopDelayP95Ms,
        pool: poolStats,
        telemetryStaleMs: config.health.telemetryStaleMs,
        healthThresholds: {
          errorRateDegradedPct: config.health.errorRateDegradedPct,
          errorRateFailingPct: config.health.errorRateFailingPct,
          latencyP95DegradedMs: config.health.latencyP95DegradedMs,
          latencyP95FailingMs: config.health.latencyP95FailingMs,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

/* ------------------------------- History ---------------------------------- */

const HistoryQuery = z.object({
  service: z.string().regex(/^[a-zA-Z0-9_.:-]{1,64}$/),
  range: z.enum(['24h', '7d', '30d']).default('24h'),
})

/**
 * GET /system/history?service=<svc>&range=24h|7d|30d
 *
 * Aggregate time-series (error rate, latency p95, volume, availability) from
 * the hourly service_history rollups. Buckets with no data return COUNT 0 and
 * NULL metrics — "no traffic" is never rendered as "0ms / 100% healthy".
 */
router.get('/history', async (req, res, next) => {
  try {
    const parsed = HistoryQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid history query (service, range)' })
      return
    }
    const q = parsed.data

    const unit = q.range === '30d' ? 'day' : 'hour'
    const step = q.range === '24h' ? '1 hour' : q.range === '7d' ? '1 hour' : '1 day'
    const span = q.range === '24h' ? '24 hours' : q.range === '7d' ? '7 days' : '30 days'

    const rows = await query<{
      time: string
      request_count: string
      error_count: string
      error_rate_pct: string | null
      p95: string | null
      availability_pct: string | null
    }>(
      `WITH series AS (
         SELECT generate_series(
           date_trunc('${unit}', now() - interval '${span}'),
           date_trunc('${unit}', now()),
           interval '${step}'
         ) AS ts
       ),
       b AS (
         SELECT date_trunc('${unit}', bucket_start) AS bs,
                SUM(request_count)  AS request_count,
                SUM(error_count)    AS error_count,
                AVG(p95)            AS p95
         FROM service_history
         WHERE service = $1 AND bucket_start >= now() - interval '${span}'
         GROUP BY 1
       )
       SELECT to_char(s.ts, 'YYYY-MM-DD"T"HH24:MI') AS time,
              COALESCE(x.request_count, 0)::text AS request_count,
              COALESCE(x.error_count, 0)::text AS error_count,
              CASE WHEN COALESCE(x.request_count, 0) = 0 THEN NULL
                   ELSE ROUND(x.error_count * 100.0 / x.request_count, 2)::text END AS error_rate_pct,
              CASE WHEN COALESCE(x.request_count, 0) = 0 THEN NULL
                   ELSE ROUND(100 - x.error_count * 100.0 / x.request_count, 2)::text END AS availability_pct,
              CASE WHEN x.p95 IS NULL THEN NULL ELSE ROUND(x.p95, 1)::text END AS p95
       FROM series s
       LEFT JOIN b x ON x.bs = s.ts
       ORDER BY s.ts`,
      [q.service],
    )

    res.json({
      service: q.service,
      range: q.range,
      points: rows.map((r) => ({
        time: r.time,
        requestCount: Number(r.request_count),
        errorCount: Number(r.error_count),
        errorRatePct: r.error_rate_pct === null ? null : Number(r.error_rate_pct),
        availabilityPct: r.availability_pct === null ? null : Number(r.availability_pct),
        p95Ms: r.p95 === null ? null : Number(r.p95),
      })),
    })
  } catch (err) {
    next(err)
  }
})

/* ----------------------------- Transitions -------------------------------- */

const TransitionQuery = z.object({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
  service: z.string().regex(/^[a-zA-Z0-9_.:-]{1,64}$/).optional(),
})

/**
 * GET /system/transitions?range=24h|7d|30d&service=<svc>
 * Health-state transitions (deduplicated at write time — one row per genuine
 * state change, never one per flush of an ongoing condition).
 */
router.get('/transitions', async (req, res, next) => {
  try {
    const parsed = TransitionQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid transitions query (range, service)' })
      return
    }
    const q = parsed.data
    const span = q.range === '24h' ? '24 hours' : q.range === '7d' ? '7 days' : '30 days'

    const rows = await query<{
      id: string
      service: string
      from_status: string
      to_status: string
      reason: string
      metric: string
      metric_value: string | null
      triggered_at: Date
    }>(
      `SELECT id, service, from_status, to_status, reason, metric, metric_value, triggered_at
       FROM health_transitions
       WHERE triggered_at >= now() - interval '${span}'
         ${q.service ? 'AND service = $1' : ''}
       ORDER BY triggered_at DESC
       LIMIT 200`,
      q.service ? [q.service] : [],
    )

    res.json(
      rows.map((r) => ({
        id: r.id,
        service: r.service,
        from: r.from_status,
        to: r.to_status,
        reason: r.reason,
        metric: r.metric,
        metricValue: r.metric_value === null ? null : Number(r.metric_value),
        at: r.triggered_at.toISOString(),
      })),
    )
  } catch (err) {
    next(err)
  }
})

export default router
