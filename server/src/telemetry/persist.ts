/**
 * Telemetry persistence — feeds the dashboard's existing operational tables
 * from real instrumentation (the tables were schema-complete but unwritten):
 *
 *   request_log      ← finished SERVER spans (method, route template, status, duration)
 *   trace_spans      ← every local span record (trace/span/parent ids from OpenTelemetry)
 *   service_telemetry← rolling-window aggregates + health status per service
 *   slow_operations  ← per-operation window p95 + occurrences
 *   span_metrics     ← per-interval request/error deltas (error-rate trend)
 *   errors           ← API 5xx buckets (self-constructed, redacted messages)
 *
 * Rules:
 *  - All writes are batched on a timer (config.telemetry.flushMs) and run with
 *    tracing SUPPRESSED — persisting telemetry never generates telemetry
 *    (no recursion, no self-referential slow queries).
 *  - Persistence failures are logged (sanitized) and swallowed: the API must
 *    keep operating if the database is unavailable.
 *  - Retention pruning keeps the tables bounded.
 */
import { isDbReady, query } from '../db'
import { config } from '../config'
import { runSuppressed } from './otel'
import {
  computeServiceStatus,
  drainApiErrors5xx,
  operationStats,
  serviceNamesWithSamples,
  serviceSnapshot,
} from './store'
import { sanitizeErrorMessage } from './sanitize'

export type LocalSpanKind = 'server' | 'client' | 'internal'

/** Aggregate-only span record built by the instrumentation layer. */
export interface LocalSpanRecord {
  traceId: string
  spanId: string
  parentSpanId: string | null
  service: string
  operation: string
  kind: LocalSpanKind
  startMs: number
  durationMs: number
  statusCode: number
  hasError: boolean
}

const MAX_BUFFERED_SPANS = 10_000
const MAX_BUFFERED_REQUESTS = 10_000
const PRUNE_EVERY_N_FLUSHES = 30 // ~5 minutes at the default 10s flush

let spanBuffer: LocalSpanRecord[] = []
let requestBuffer: LocalSpanRecord[] = []

/** Delta counters since the last flush, per service. */
const deltas = new Map<string, { count: number; error: number }>()

let flushTimer: ReturnType<typeof setInterval> | null = null
let flushing = false
let flushCount = 0

/** True while a persistence flush is in flight (used as a recursion guard). */
export function isPersisting(): boolean {
  return flushing
}

/** Called by the instrumentation layer for every completed span. */
export function recordLocalSpan(span: LocalSpanRecord): void {
  if (!config.telemetry.enabled) return
  if (spanBuffer.length >= MAX_BUFFERED_SPANS) spanBuffer.shift()
  spanBuffer.push(span)
  if (span.kind === 'server') {
    if (requestBuffer.length >= MAX_BUFFERED_REQUESTS) requestBuffer.shift()
    requestBuffer.push(span)
  }
  let delta = deltas.get(span.service)
  if (!delta) deltas.set(span.service, (delta = { count: 0, error: 0 }))
  delta.count += 1
  if (span.hasError) delta.error += 1
}

/** Starts the batched persistence loop (unref'd; no-op when disabled). */
export function startFlushLoop(): void {
  if (flushTimer || !config.telemetry.enabled) return
  flushTimer = setInterval(() => {
    void flushTelemetryOnce()
  }, config.telemetry.flushMs)
  flushTimer.unref()
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** One batched persistence pass. Exported for shutdown/tests. Never throws. */
export async function flushTelemetryOnce(): Promise<void> {
  if (flushing || !config.telemetry.enabled) return
  // Never race schema initialization: buffered records simply wait for the
  // next tick once the database is ready (bounded by the buffer caps).
  if (!isDbReady()) return
  flushing = true
  try {
    // Drain first so new telemetry keeps flowing while we write.
    const spans = spanBuffer
    const requests = requestBuffer
    const deltaEntries = [...deltas.entries()]
    spanBuffer = []
    requestBuffer = []
    deltas.clear()
    const errors5xx = drainApiErrors5xx()

    await runSuppressed(async () => {
      if (requests.length > 0) {
        for (const batch of chunk(requests, 500)) {
          const values: string[] = []
          const params: unknown[] = []
          for (const r of batch) {
            const o = params.length
            values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`)
            const [method, ...rest] = r.operation.split(' ')
            params.push(method, rest.join(' ') || 'unmatched', r.statusCode, r.durationMs)
          }
          await query(
            `INSERT INTO request_log (method, endpoint, status_code, duration_ms) VALUES ${values.join(', ')}`,
            params,
          )
        }
      }

      if (spans.length > 0) {
        for (const batch of chunk(spans, 500)) {
          const values: string[] = []
          const params: unknown[] = []
          for (const s of batch) {
            const o = params.length
            values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, to_timestamp($${o + 6} / 1000.0), $${o + 7}, $${o + 8}, $${o + 9})`)
            params.push(
              s.traceId,
              s.spanId,
              s.parentSpanId,
              s.service,
              s.operation,
              s.startMs,
              s.durationMs,
              s.statusCode,
              s.hasError,
            )
          }
          await query(
            `INSERT INTO trace_spans (trace_id, span_id, parent_span_id, service, operation, start_time, duration_ms, status_code, has_error)
             VALUES ${values.join(', ')}`,
            params,
          )
        }
      }

      // Per-interval deltas power the 24h error-rate trend.
      if (deltaEntries.length > 0) {
        for (const [service, delta] of deltaEntries) {
          await query(
            `INSERT INTO span_metrics (time, service, request_count, error_count) VALUES (now(), $1, $2, $3)`,
            [service, delta.count, delta.error],
          )
        }
      }

      // Rolling-window aggregates + deterministic health status per service.
      for (const service of serviceNamesWithSamples()) {
        const snap = serviceSnapshot(service)
        if (snap.count === 0) continue
        const health = computeServiceStatus(service)
        await query(
          `INSERT INTO service_telemetry (service, request_count, error_rate_pct, p50, p95, p99, status, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (service) DO UPDATE SET
             request_count = EXCLUDED.request_count,
             error_rate_pct = EXCLUDED.error_rate_pct,
             p50 = EXCLUDED.p50, p95 = EXCLUDED.p95, p99 = EXCLUDED.p99,
             status = EXCLUDED.status, updated_at = now()`,
          [
            service,
            snap.count,
            snap.errorRatePct ?? 0,
            snap.p50Ms ?? 0,
            snap.p95Ms ?? 0,
            snap.p99Ms ?? 0,
            health.status,
          ],
        )
      }

      // Slowest operations (window p95) for the Observability page.
      for (const op of operationStats()) {
        await query(
          `INSERT INTO slow_operations (service, operation, p95, occurrences, last_seen_at)
           VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
           ON CONFLICT (service, operation) DO UPDATE SET
             p95 = EXCLUDED.p95,
             occurrences = EXCLUDED.occurrences,
             last_seen_at = EXCLUDED.last_seen_at`,
          [op.service, op.operation, op.p95Ms, op.occurrences, op.lastSeenAt],
        )
      }

      // API 5xx buckets → the Errors page. Messages are constructed here from
      // route templates + status codes only (never request data).
      for (const bucket of errors5xx) {
        const message = `${bucket.method} ${bucket.route} responded ${bucket.statusCode}`
        const updated = await query<{ id: string }>(
          `UPDATE errors SET count = count + $1, last_seen_at = now()
           WHERE service = 'Dashboard API' AND message = $2 AND status_code = $3
           RETURNING id`,
          [bucket.count, message, bucket.statusCode],
        )
        if (updated.length === 0) {
          await query(
            `INSERT INTO errors (severity, service, endpoint, method, status_code, message, trace_id, count)
             VALUES ($1, 'Dashboard API', $2, $3, $4, $5, $6, $7)`,
            [
              bucket.statusCode >= 500 ? 'high' : 'medium',
              bucket.route,
              bucket.method,
              bucket.statusCode,
              message,
              bucket.traceId,
              bucket.count,
            ],
          )
        }
      }

      // Retention pruning keeps telemetry tables bounded.
      flushCount++
      if (flushCount % PRUNE_EVERY_N_FLUSHES === 1) {
        await query(`DELETE FROM trace_spans WHERE start_time < now() - ($1 || ' hours')::interval`, [
          String(config.telemetry.traceRetentionHours),
        ])
        await query(`DELETE FROM request_log WHERE time < now() - ($1 || ' hours')::interval`, [
          String(config.telemetry.requestLogRetentionHours),
        ])
        await query(`DELETE FROM span_metrics WHERE time < now() - ($1 || ' hours')::interval`, [
          String(config.telemetry.spanMetricsRetentionHours),
        ])
      }
    })
  } catch (err) {
    console.warn(`[telemetry] persistence flush failed (API unaffected): ${sanitizeErrorMessage(String(err))}`)
  } finally {
    flushing = false
  }
}
