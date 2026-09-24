/**
 * Telemetry persistence — feeds the dashboard's existing operational tables
 * from real instrumentation (the tables were schema-complete but unwritten):
 *
 *   request_log      ← finished SERVER spans (method, route template, status, duration)
 *   trace_spans      ← every local span record (trace/span/parent ids from OpenTelemetry)
 *   service_telemetry← rolling-window aggregates + FOUR-STATE health status per service
 *   health_transitions← genuine state changes only (deduplicated against the
 *                       persisted status — an ongoing condition never repeats)
 *   service_history  ← hourly rollups recomputed idempotently from trace_spans
 *                       (the 24h/7d/30d history layer; longer retention than raw spans)
 *   slow_operations  ← per-operation window avg/p95/p99 + occurrences
 *   span_metrics     ← per-interval request/error deltas (error-rate trend)
 *   errors           ← API 5xx buckets (self-constructed, redacted messages)
 *
 * Rules:
 *  - All writes are batched on a timer (config.telemetry.flushMs) and run with
 *    tracing SUPPRESSED — persisting telemetry never generates telemetry
 *    (no recursion, no self-referential slow queries).
 *  - Persistence failures are logged (sanitized) and swallowed: the API must
 *    keep operating if the database is unavailable.
 *  - Retention pruning keeps every telemetry table bounded and configurable.
 *    Audit records (audit_events) are NEVER touched by retention.
 */
import { isDbReady, query } from '../db'
import { config } from '../config'
import { runSuppressed } from './otel'
import {
  computeServiceStatus,
  drainApiErrors5xx,
  evaluateHealth,
  operationStats,
  serviceNamesWithSamples,
  shouldRecordTransition,
  staleMsFor,
  type ComponentHealth,
  type ComponentHealthStatus,
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
let lastRollupAt = 0

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

/**
 * Maps a health evaluation to the single metric that triggered it — stored on
 * the transition row as the "relevant aggregate metric". Aggregate-only: a
 * name + one number, never a payload or identifier.
 */
function transitionMetric(health: ComponentHealth): { metric: string; value: number | null } {
  const reason = health.reason ?? ''
  if (health.status === 'unknown') {
    return { metric: 'telemetryAgeMs', value: health.telemetryAgeMs }
  }
  if (reason.includes('error rate') && health.errorRatePct !== null) {
    return { metric: 'errorRatePct', value: health.errorRatePct }
  }
  if (reason.includes('latency') && health.p95Ms !== null) {
    return { metric: 'p95Ms', value: health.p95Ms }
  }
  if (reason.includes('availability') && health.availabilityPct !== null) {
    return { metric: 'availabilityPct', value: health.availabilityPct }
  }
  if (health.status === 'healthy') return { metric: '', value: null }
  return { metric: 'errorRatePct', value: health.errorRatePct }
}

async function insertTransition(
  service: string,
  from: ComponentHealthStatus,
  to: ComponentHealthStatus,
  reason: string,
  metric: string,
  metricValue: number | null,
): Promise<void> {
  await query(
    `INSERT INTO health_transitions (service, from_status, to_status, reason, metric, metric_value)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [service, from, to, reason.slice(0, 300), metric, metricValue],
  )
}

/**
 * Persists health status per service and records genuine state transitions.
 *
 * Two sources are reconciled every flush:
 *  1. Services with in-memory telemetry → full metrics upsert where
 *     `updated_at` is set to the LAST REAL TELEMETRY timestamp (freshness
 *     source of truth), with status `unknown` when that telemetry is stale.
 *  2. Services that only exist in the database (e.g. `resend`, which is
 *     observed only when an admin sends email) → when their row ages past the
 *     freshness threshold, status flips to `unknown`. Until then the previous
 *     state is preserved (a restart must not immediately fake a transition).
 *
 * Deduplication: a transition row is only inserted when the PERSISTED status
 * actually changes (shouldRecordTransition), so an ongoing condition never
 * produces duplicate events.
 */
async function persistServiceHealth(): Promise<void> {
  const now = Date.now()
  const memServices = serviceNamesWithSamples()
  const dbRows = await query<{ service: string; status: string; updated_at: Date }>(
    `SELECT service, status, updated_at FROM service_telemetry`,
  )
  const dbStatus = new Map(dbRows.map((r) => [r.service, { status: r.status, updatedAt: r.updated_at.getTime() }]))
  const handled = new Set<string>()

  for (const service of memServices) {
    handled.add(service)
    const health = computeServiceStatus(service)
    const lastAt = health.lastTelemetryAt ?? now
    const prev = dbStatus.get(service)?.status as ComponentHealthStatus | undefined

    await query(
      `INSERT INTO service_telemetry (service, request_count, error_rate_pct, p50, p95, p99, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
       ON CONFLICT (service) DO UPDATE SET
         request_count = EXCLUDED.request_count,
         error_rate_pct = EXCLUDED.error_rate_pct,
         p50 = EXCLUDED.p50, p95 = EXCLUDED.p95, p99 = EXCLUDED.p99,
         status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [
        service,
        health.sampleCount,
        health.errorRatePct ?? 0,
        health.p50Ms ?? 0,
        health.p95Ms ?? 0,
        health.p99Ms ?? 0,
        health.status,
        lastAt,
      ],
    )

    if (prev !== undefined && shouldRecordTransition(prev, health.status)) {
      const m = transitionMetric(health)
      await insertTransition(service, prev, health.status, health.reason ?? '', m.metric, m.value)
    }
  }

  // DB-only services: freshness is judged by the row's updated_at (the last
  // real telemetry timestamp written above). Only an EXPIRED row flips to
  // unknown — recent rows keep their state across process restarts.
  for (const row of dbRows) {
    if (handled.has(row.service)) continue
    const ageMs = now - row.updated_at.getTime()
    if (ageMs <= staleMsFor(row.service) || row.status === 'unknown') continue
    const mins = Math.max(1, Math.round(ageMs / 60_000))
    const updated = await query<{ status: string }>(
      `UPDATE service_telemetry SET status = 'unknown'
       WHERE service = $1 AND status <> 'unknown'
       RETURNING status`,
      [row.service],
    )
    if (updated.length > 0) {
      await insertTransition(
        row.service,
        row.status as ComponentHealthStatus,
        'unknown',
        `no telemetry observed for ${mins}m`,
        'telemetryAgeMs',
        ageMs,
      )
    }
  }
}

/**
 * Idempotent hourly rollup of trace_spans into service_history — recomputes
 * the trailing window every config.telemetry.historyRollupMs so restarts or
 * missed intervals self-heal, while older buckets stay intact.
 */
async function rollupServiceHistory(now: number): Promise<void> {
  if (now - lastRollupAt < config.telemetry.historyRollupMs) return
  lastRollupAt = now
  const windowHours = Math.min(config.telemetry.historyRollupWindowHours, config.telemetry.traceRetentionHours)
  await query(
    `INSERT INTO service_history (bucket_start, service, request_count, error_count, slow_count, p50, p95, p99)
     SELECT date_trunc('hour', s.start_time) AS bucket_start,
            s.service,
            COUNT(*)::bigint,
            COUNT(*) FILTER (WHERE s.has_error)::bigint,
            COUNT(*) FILTER (WHERE s.duration_ms >= CASE WHEN s.service = 'postgres' THEN $2::numeric ELSE $3::numeric END)::bigint,
            ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.duration_ms)::numeric, 1),
            ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms)::numeric, 1),
            ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY s.duration_ms)::numeric, 1)
     FROM trace_spans s
     WHERE s.start_time >= now() - ($1 || ' hours')::interval
     GROUP BY s.service, bucket_start
     ON CONFLICT (service, bucket_start) DO UPDATE SET
       request_count = EXCLUDED.request_count,
       error_count   = EXCLUDED.error_count,
       slow_count    = EXCLUDED.slow_count,
       p50           = EXCLUDED.p50,
       p95           = EXCLUDED.p95,
       p99           = EXCLUDED.p99`,
    [String(windowHours), config.telemetry.slowQueryMs, config.telemetry.slowRequestMs],
  )
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

      // Four-state health status + deduplicated transitions per service.
      await persistServiceHealth()

      // Slowest operations (window avg/p95/p99) for the Observability page.
      for (const op of operationStats()) {
        await query(
          `INSERT INTO slow_operations (service, operation, p95, occurrences, last_seen_at, avg_ms, p99)
           VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)
           ON CONFLICT (service, operation) DO UPDATE SET
             p95 = EXCLUDED.p95,
             occurrences = EXCLUDED.occurrences,
             last_seen_at = EXCLUDED.last_seen_at,
             avg_ms = EXCLUDED.avg_ms,
             p99 = EXCLUDED.p99`,
          [op.service, op.operation, op.p95Ms, op.occurrences, op.lastSeenAt, op.avgMs, op.p99Ms],
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

      // Hourly history rollups (throttled + idempotent inside).
      await rollupServiceHistory(Date.now())

      // Retention pruning keeps telemetry tables bounded (configurable; the
      // aggregate layers — service_history, health_transitions — outlive the
      // raw spans. audit_events is deliberately never pruned here).
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
        await query(`DELETE FROM service_history WHERE bucket_start < now() - ($1 || ' hours')::interval`, [
          String(config.telemetry.serviceHistoryRetentionHours),
        ])
        await query(`DELETE FROM health_transitions WHERE triggered_at < now() - ($1 || ' hours')::interval`, [
          String(config.telemetry.transitionRetentionHours),
        ])
      }
    })
  } catch (err) {
    console.warn(`[telemetry] persistence flush failed (API unaffected): ${sanitizeErrorMessage(String(err))}`)
  } finally {
    flushing = false
  }
}

// Re-exported so route/test code can evaluate health without importing store
// internals twice (evaluateHealth is the single source of threshold truth).
export { evaluateHealth }
