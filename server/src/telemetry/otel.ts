/**
 * OpenTelemetry bootstrap — standard API/SDK with an optional OTLP exporter.
 *
 * Design rules:
 *  - Telemetry is OPTIONAL. Every step is individually guarded: a failure
 *    (bad endpoint, unsupported runtime, missing dep) logs one safe line and
 *    the API keeps operating normally. Startup never fails because of telemetry.
 *  - Configuration comes only from env vars (see config.telemetry): enable
 *    switch, OTLP endpoint, OTLP auth headers, sampler (standard
 *    OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG, read by the SDK), service
 *    name and environment.
 *  - The sampler and exporter affect OTLP export ONLY. The dashboard's own
 *    in-process telemetry (System/Observability pages) is independent of
 *    sampling so its data is always real while telemetry is enabled.
 *  - A context key lets telemetry persistence run with tracing suppressed so
 *    writing telemetry can never feed telemetry (no recursion/feedback loop).
 */
import { context, createContextKey, trace, type Context, type Tracer } from '@opentelemetry/api'
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { config } from '../config'
import { SERVER_VERSION } from '../version'
import { sanitizeErrorMessage } from './sanitize'

const SUPPRESS_KEY = createContextKey('rayern.telemetry.suppression')

let provider: BasicTracerProvider | null = null
let initialized = false
let exporting = false

/** True when a context is flagged "this work is telemetry persistence". */
export function isSuppressed(): boolean {
  try {
    return context.active().getValue(SUPPRESS_KEY) === true
  } catch {
    return false
  }
}

/** Runs `fn` with tracing/metrics recording suppressed (telemetry writes). */
export async function runSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: Context = context.active().setValue(SUPPRESS_KEY, true)
  return context.with(ctx, fn)
}

export interface OtelInitResult {
  /** True when an OTLP trace exporter was configured and registered. */
  otlpExporting: boolean
  /** True when the tracer provider is registered (spans get real ids). */
  providerRegistered: boolean
}

/**
 * Registers the tracer provider + async context manager. Idempotent, never
 * throws. With telemetry disabled nothing is registered and `trace.getTracer`
 * falls back to the API's no-op tracer.
 */
export function initOtel(): OtelInitResult {
  if (initialized) return { otlpExporting: exporting, providerRegistered: provider !== null }
  initialized = true

  if (!config.telemetry.enabled) {
    console.log('[telemetry] disabled (TELEMETRY_ENABLED/OTEL_SDK_DISABLED) — API runs without telemetry')
    return { otlpExporting: false, providerRegistered: false }
  }

  // Context propagation across async boundaries (proper parent/child spans).
  // Supported in Node and Bun; a runtime without it degrades to root spans.
  try {
    const manager = new AsyncHooksContextManager()
    manager.enable()
    context.setGlobalContextManager(manager)
  } catch (err) {
    console.warn(`[telemetry] context manager unavailable, continuing without async propagation: ${sanitizeErrorMessage(String(err))}`)
  }

  try {
    const resource = resourceFromAttributes({
      'service.name': config.telemetry.serviceName,
      'service.version': SERVER_VERSION,
      'deployment.environment': config.telemetry.environment,
    })

    const spanProcessors = []
    if (config.telemetry.otlpEndpoint) {
      try {
        const exporter = new OTLPTraceExporter({
          url: config.telemetry.otlpEndpoint,
          headers: Object.keys(config.telemetry.otlpHeaders).length > 0 ? config.telemetry.otlpHeaders : undefined,
        })
        // BatchSpanProcessor exports asynchronously: a dead/unreachable
        // endpoint can never throw into request handling or startup.
        spanProcessors.push(new BatchSpanProcessor(exporter))
        exporting = true
      } catch (err) {
        console.warn(`[telemetry] OTLP exporter setup failed, continuing without export: ${sanitizeErrorMessage(String(err))}`)
      }
    }

    provider = new BasicTracerProvider({ resource, spanProcessors })
    trace.setGlobalTracerProvider(provider)
  } catch (err) {
    provider = null
    exporting = false
    console.warn(`[telemetry] tracer provider setup failed, continuing without tracing: ${sanitizeErrorMessage(String(err))}`)
  }

  console.log(
    `[telemetry] enabled: service=${config.telemetry.serviceName} env=${config.telemetry.environment} otlp=${exporting ? config.telemetry.otlpEndpoint : 'off'}`,
  )
  return { otlpExporting: exporting, providerRegistered: provider !== null }
}

/** The app tracer (no-op when telemetry is disabled/unregistered). */
export function otelTracer(): Tracer {
  return trace.getTracer(config.telemetry.serviceName, SERVER_VERSION)
}

/** Best-effort flush of buffered spans. Never throws. */
export async function shutdownOtel(): Promise<void> {
  if (!provider) return
  try {
    await provider.shutdown()
  } catch (err) {
    console.warn(`[telemetry] shutdown failed (ignored): ${sanitizeErrorMessage(String(err))}`)
  }
}
