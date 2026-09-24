/**
 * Observability routes — the dashboard backend's own technical telemetry
 * (OpenTelemetry domain). Answers "what is the software doing?", not
 * "what are Rayern users doing?". Operates over traces/spans tables fed by
 * the backend's own instrumentation and the Rayern sync channel.
 */
import { Router } from 'express'
import { query } from '../db'
import { staleMsFor } from '../telemetry'
import type { ComponentHealthStatus, TelemetryFreshness } from '../telemetry'

const router = Router()

router.get('/overview', async (_req, res, next) => {
  try {
    const now = Date.now()
    const serviceRows = await query<{
      service: string
      request_count: string
      error_rate_pct: string
      p50: string
      p95: string
      p99: string
      status: string
      updated_at: Date
    }>(
      `SELECT service, request_count, error_rate_pct, p50, p95, p99, status, updated_at
       FROM service_telemetry ORDER BY service`,
    )

    const traceRows = await query<{
      id: string
      trace_id: string
      span_id: string
      parent_span_id: string | null
      service: string
      operation: string
      start_time: Date
      duration_ms: string
      status_code: number
      has_error: boolean
    }>(
      `SELECT id, trace_id, span_id, parent_span_id, service, operation, start_time, duration_ms, status_code, has_error
       FROM trace_spans ORDER BY start_time DESC LIMIT 100`,
    )

    const slowRows = await query<{
      id: string
      service: string
      operation: string
      p95: string
      avg_ms: string
      p99: string
      occurrences: string
      last_seen_at: Date
    }>(
      `SELECT id, service, operation, p95, avg_ms, p99, occurrences, last_seen_at
       FROM slow_operations ORDER BY p95 DESC LIMIT 10`,
    )

    // Empty buckets return NULL ("no traffic") — never a fabricated 0% error
    // rate that would read as "everything fine".
    const trendRows = await query<{ bucket: string; error_rate_pct: string | null }>(
      `SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
              ROUND(SUM(s.error_count)::numeric / NULLIF(SUM(s.request_count), 0) * 100, 2)::text AS error_rate_pct
       FROM generate_series(
         date_trunc('hour', now() - interval '23 hours'),
         date_trunc('hour', now()),
         interval '1 hour'
       ) AS b(bucket)
       LEFT JOIN span_metrics s ON date_trunc('hour', s.time) = b.bucket
       GROUP BY b.bucket ORDER BY b.bucket`,
    )

    res.json({
      services: serviceRows.map((r) => {
        // Freshness: updated_at is the LAST REAL TELEMETRY timestamp (the
        // flush loop preserves it). Read-time safety net — a row older than
        // the freshness threshold can never be served as healthy.
        const ageMs = now - r.updated_at.getTime()
        const freshness: TelemetryFreshness =
          ageMs <= 0 ? 'none' : ageMs > staleMsFor(r.service) ? 'stale' : 'fresh'
        const persisted = r.status as ComponentHealthStatus
        const status: ComponentHealthStatus = freshness === 'fresh' ? persisted : 'unknown'
        const requestCount = Number(r.request_count)
        const errorRatePct = Number(r.error_rate_pct)
        const errorCount = Math.round((requestCount * errorRatePct) / 100)
        return {
          service: r.service,
          requestCount,
          errorCount,
          successCount: Math.max(0, requestCount - errorCount),
          errorRatePct,
          p50: Number(r.p50),
          p95: Number(r.p95),
          p99: Number(r.p99),
          status,
          freshness: {
            lastTelemetryAt: r.updated_at.toISOString(),
            ageMs,
            status: freshness,
          },
        }
      }),
      recentTraces: traceRows.map((r) => ({
        id: r.id,
        traceId: r.trace_id,
        spanId: r.span_id,
        parentSpanId: r.parent_span_id,
        service: r.service,
        operation: r.operation,
        startTime: r.start_time.toISOString(),
        durationMs: Number(r.duration_ms),
        statusCode: r.status_code,
        hasError: r.has_error,
      })),
      slowOperations: slowRows.map((r) => ({
        id: r.id,
        service: r.service,
        operation: r.operation,
        p95: Number(r.p95),
        avgMs: Number(r.avg_ms ?? 0),
        p99: Number(r.p99 ?? r.p95),
        occurrences: Number(r.occurrences),
        lastSeenAt: r.last_seen_at.toISOString(),
      })),
      errorRateTrend: trendRows.map((r) => ({
        time: r.bucket,
        errorRatePct: r.error_rate_pct === null ? null : Number(r.error_rate_pct),
      })),
    })
  } catch (err) {
    next(err)
  }
})

export default router
