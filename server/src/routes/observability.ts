/**
 * Observability routes — the dashboard backend's own technical telemetry
 * (OpenTelemetry domain). Answers "what is the software doing?", not
 * "what are Rayern users doing?". Operates over traces/spans tables fed by
 * the backend's own instrumentation and the Rayern sync channel.
 */
import { Router } from 'express'
import { query } from '../db'

const router = Router()

router.get('/overview', async (_req, res, next) => {
  try {
    const serviceRows = await query<{
      service: string
      request_count: string
      error_rate_pct: string
      p50: string
      p95: string
      p99: string
      status: string
    }>(
      `SELECT service, request_count, error_rate_pct, p50, p95, p99, status
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
      occurrences: string
      last_seen_at: Date
    }>(
      `SELECT id, service, operation, p95, occurrences, last_seen_at
       FROM slow_operations ORDER BY p95 DESC LIMIT 10`,
    )

    const trendRows = await query<{ bucket: string; error_rate_pct: string }>(
      `SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
              COALESCE(ROUND(SUM(s.error_count)::numeric / NULLIF(SUM(s.request_count), 0) * 100, 2), 0)::text AS error_rate_pct
       FROM generate_series(
         date_trunc('hour', now() - interval '23 hours'),
         date_trunc('hour', now()),
         interval '1 hour'
       ) AS b(bucket)
       LEFT JOIN span_metrics s ON date_trunc('hour', s.time) = b.bucket
       GROUP BY b.bucket ORDER BY b.bucket`,
    )

    res.json({
      services: serviceRows.map((r) => ({
        service: r.service,
        requestCount: Number(r.request_count),
        errorRatePct: Number(r.error_rate_pct),
        p50: Number(r.p50),
        p95: Number(r.p95),
        p99: Number(r.p99),
        status: r.status as 'healthy' | 'degraded' | 'failing',
      })),
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
        occurrences: Number(r.occurrences),
        lastSeenAt: r.last_seen_at.toISOString(),
      })),
      errorRateTrend: trendRows.map((r) => ({ time: r.bucket, errorRatePct: Number(r.error_rate_pct) })),
    })
  } catch (err) {
    next(err)
  }
})

export default router
