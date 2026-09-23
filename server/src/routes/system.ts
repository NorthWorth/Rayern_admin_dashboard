/**
 * System routes — technical/operational health only.
 *
 * Services marked "self" report this dashboard backend's own live status.
 * Rayern-side rows in service_health arrive via the dashboard pull-sync worker
 * (rayernSync.ts); if Rayern has never been polled successfully, its entries
 * are simply absent and the sync-status card shows the state instead.
 */
import { Router } from 'express'
import { pool } from '../db'
import { getSyncStatus } from '../rayernSync'
import { computeApiHealth, computeDbHealth, runtimeSnapshot } from '../telemetry'

const router = Router()

/** Service row as served to the UI — null = insufficient telemetry (never faked). */
interface ServiceRowView {
  id: string
  name: string
  kind: 'api' | 'database' | 'cache' | 'queue' | 'email' | 'storage'
  status: 'healthy' | 'degraded' | 'failing'
  uptimePct30d: number | null
  latencyMsP50: number | null
  latencyMsP95: number | null
  lastIncidentAt: string | null
}

router.get('/overview', async (_req, res, next) => {
  try {
    // Real database health check.
    const dbStart = Date.now()
    await pool.query('SELECT 1')
    const dbLatencyMs = Date.now() - dbStart

    const runtime = runtimeSnapshot()

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

    // Rows synced from Rayern keep Rayern's reported values. The dashboard's
    // OWN rows are synthesized from real in-process telemetry: availability /
    // latency are null until the rolling window has enough samples — never a
    // fake 100% uptime or 0ms latency.
    const apiHealth = computeApiHealth()
    const dbHealth = computeDbHealth()

    const services: ServiceRowView[] = serviceRows.rows.map((r) => ({
      id: `${r.kind}:${r.service}`,
      name: r.service,
      kind: r.kind as ServiceRowView['kind'],
      status: r.status as ServiceRowView['status'],
      uptimePct30d: Number(r.uptime_pct_30d),
      latencyMsP50: Number(r.latency_p50),
      latencyMsP95: Number(r.latency_p95),
      lastIncidentAt: r.last_incident_at ? r.last_incident_at.toISOString() : null,
    }))

    const selfDb: ServiceRowView = {
      id: 'database:PostgreSQL',
      name: 'PostgreSQL',
      kind: 'database',
      status: dbHealth.status,
      uptimePct30d: dbHealth.availabilityPct,
      latencyMsP50: dbHealth.p50Ms,
      latencyMsP95: dbHealth.p95Ms,
      lastIncidentAt: null,
    }
    const selfApi: ServiceRowView = {
      id: 'api:dashboard-backend',
      name: 'Dashboard API',
      kind: 'api',
      status: apiHealth.status,
      // Observed availability over the rolling 24h window (null when there is
      // not yet enough telemetry to measure it honestly).
      uptimePct30d: apiHealth.availabilityPct,
      latencyMsP50: apiHealth.p50Ms,
      latencyMsP95: apiHealth.p95Ms,
      lastIncidentAt: null,
    }
    if (!services.some((s) => s.name === 'Dashboard API')) services.unshift(selfApi)
    if (!services.some((s) => s.name === 'PostgreSQL')) services.unshift(selfDb)

    const overall =
      services.some((s) => s.status === 'failing')
        ? 'failing'
        : services.some((s) => s.status === 'degraded')
          ? 'degraded'
          : 'healthy'

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

    const failureRows = await pool.query<{ id: string; service: string; last_seen_at: Date; message: string; count: string }>(
      `SELECT id, service, last_seen_at, message, count FROM errors
       WHERE severity IN ('high','critical') OR status_code >= 500
       ORDER BY last_seen_at DESC LIMIT 8`,
    )

    const total24h = Number(totalRows.rows[0]?.total ?? 0)
    const errors24h = Number(totalRows.rows[0]?.errors ?? 0)
    // With no requests in the window there is nothing to measure — report
    // null ("unavailable") rather than a fake 0% error rate / 0ms latency.
    const has24hData = total24h > 0

    // Dashboard-side Rayern pull-sync health (spec section 12).
    const sync = await getSyncStatus()

    res.json({
      overall,
      services,
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
        time: r.last_seen_at.toISOString(),
        message: r.message,
        count: Number(r.count),
      })),
      sync: {
        enabled: sync.enabled,
        status: sync.enabled
          ? sync.consecutiveFailures >= 3 || (sync.stale && sync.lastSuccessAt !== null)
            ? 'failing'
            : sync.consecutiveFailures >= 1 || sync.lastSuccessAt === null
              ? 'degraded' // recent failure, or configured but never succeeded
              : 'healthy'
          : 'degraded', // not configured
        lastSuccessAt: sync.lastSuccessAt,
        lastAttemptAt: sync.lastAttemptAt,
        lastFailureAt: sync.lastFailureAt,
        lastError: sync.lastError,
        consecutiveFailures: sync.consecutiveFailures,
        stale: sync.stale,
        running: sync.running,
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
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
