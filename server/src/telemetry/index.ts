/**
 * Telemetry facade for the dashboard backend.
 *
 * Architecture:
 *
 *   HTTP middleware / pg patch / withSpan (instrument.ts)
 *        │                                  │
 *        ├─ OpenTelemetry spans ──► BatchSpanProcessor ──► OTLP/HTTP exporter
 *        │      (standard API/SDK, env-configured, optional — failures never
 *        │       reach the API; sampler/exporter affect export only)
 *        │
 *        └─ aggregate-only local records ──► in-memory store (percentiles,
 *               health, runtime)  +  batched persistence (persist.ts) ──►
 *               request_log / trace_spans / service_telemetry /
 *               slow_operations / span_metrics / errors
 *
 * Everything is optional: TELEMETRY_ENABLED=false (or OTEL_SDK_DISABLED=true)
 * turns the whole pipeline off and the API runs exactly as before.
 */
import type { RequestHandler } from 'express'
import { initOtel, shutdownOtel } from './otel'
import { httpTelemetry, patchPgPool } from './instrument'
import { startFlushLoop, flushTelemetryOnce } from './persist'
import { startRuntimeMonitor } from './store'
import { config } from '../config'

let started = false

/**
 * Initializes telemetry. Idempotent and fail-safe: never throws, never blocks
 * startup — a failure logs one sanitized line and the API continues without
 * that piece. Safe to call before any database query runs.
 */
export function initTelemetry(): void {
  if (started) return
  started = true
  try {
    initOtel()
    // The pg patch must be in place before the first query (schema init).
    patchPgPool()
    // Runtime sampling is cheap and export-free: always on so the System page
    // can report real uptime/memory/CPU even when OTLP is off. It reports
    // null (not 0) when telemetry collection is disabled or unsupported.
    if (config.telemetry.enabled) startRuntimeMonitor()
    startFlushLoop()
  } catch (err) {
    console.warn(`[telemetry] initialization failed, continuing without telemetry: ${String(err)}`)
  }
}

/** First app middleware — spans every request; pass-through when disabled. */
export const telemetryMiddleware: RequestHandler = (req, res, next) => {
  httpTelemetry()(req, res, next)
}

export { withSpan, routeLabel } from './instrument'
export { computeApiHealth, computeDbHealth, runtimeSnapshot } from './store'
export type { ComponentHealth, RuntimeSnapshot } from './store'
export { flushTelemetryOnce }
export { sanitizeSql, sanitizeErrorMessage } from './sanitize'

/** Best-effort telemetry shutdown (flushes OTLP buffers). Never throws. */
export async function shutdownTelemetry(): Promise<void> {
  await flushTelemetryOnce()
  await shutdownOtel()
}
