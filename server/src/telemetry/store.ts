/**
 * In-process telemetry store.
 *
 * Receives redacted, aggregate-only samples from the instrumentation layer
 * (HTTP requests, PostgreSQL queries, internal operations) and derives:
 *  - rolling-window counts / error rates / p50-p95-p99 latency percentiles
 *  - slow-operation windows (per service + operation)
 *  - deterministic health status from configurable thresholds (config.health)
 *  - runtime/process telemetry (uptime, memory, CPU, event-loop delay)
 *
 * Nothing personal ever enters this store: samples are durations, statuses and
 * route/operation templates produced by sanitize.ts. When telemetry is disabled
 * no samples are recorded and every derived value reports null (never a fake
 * zero) so the API can honestly say "unavailable".
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import os from 'node:os'
import { config } from '../config'

export const WINDOW_MS = 24 * 60 * 60 * 1000 // rolling metrics window: 24h
const MAX_SAMPLES_PER_WINDOW = 20_000
const MAX_OPERATIONS = 300
const MAX_PENDING_5XX = 1_000

export type ComponentHealthStatus = 'healthy' | 'degraded' | 'failing'

export interface WindowSnapshot {
  count: number
  errorCount: number
  slowCount: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  errorRatePct: number | null
  availabilityPct: number | null
}

interface Sample {
  t: number
  ms: number
  err: boolean
}

interface OperationSamples {
  service: string
  operation: string
  samples: Sample[]
  lastSeen: number
}

/** 5xx accumulations drained by the persistence layer into the errors table. */
export interface ApiErrorBucket {
  method: string
  route: string
  statusCode: number
  count: number
  traceId: string | null
}

const windows = new Map<string, Sample[]>()
const operations = new Map<string, OperationSamples>()
const apiErrors5xx = new Map<string, ApiErrorBucket>()

const opKey = (service: string, operation: string): string => `${service}\u0000${operation}`
const errKey = (method: string, route: string, status: number): string => `${method}\u0000${route}\u0000${status}`

function pushSample(list: Sample[], sample: Sample): void {
  list.push(sample)
  const cutoff = sample.t - WINDOW_MS
  // Amortized time-prune + hard cap: splice in chunks so the copy cost is
  // spread out even at high request rates.
  if (list.length > MAX_SAMPLES_PER_WINDOW + 512) {
    let drop = 512
    while (drop > 0 && list.length > 0 && list[0].t < cutoff) {
      list.shift()
      drop--
    }
    if (list.length > MAX_SAMPLES_PER_WINDOW + 512) list.splice(0, list.length - MAX_SAMPLES_PER_WINDOW)
  }
}

function window(list: Sample[] | undefined, now = Date.now()): Sample[] {
  if (!list || list.length === 0) return []
  const cutoff = now - WINDOW_MS
  return list.filter((s) => s.t >= cutoff)
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function snapshotOf(samples: Sample[]): WindowSnapshot {
  if (samples.length === 0) {
    return {
      count: 0,
      errorCount: 0,
      slowCount: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      errorRatePct: null,
      availabilityPct: null,
    }
  }
  const durations = samples.map((s) => s.ms).sort((a, b) => a - b)
  const errorCount = samples.reduce((n, s) => n + (s.err ? 1 : 0), 0)
  const errorRatePct = (errorCount / samples.length) * 100
  return {
    count: samples.length,
    errorCount,
    slowCount: 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    errorRatePct: Number(errorRatePct.toFixed(4)),
    availabilityPct: Number((100 - errorRatePct).toFixed(4)),
  }
}

/* ------------------------------ Recording -------------------------------- */

/** Records one HTTP request (method + route template only — never a raw URL). */
export function recordHttp(input: {
  method: string
  route: string
  statusCode: number
  durationMs: number
  traceId: string | null
}): void {
  if (!config.telemetry.enabled) return
  const err = input.statusCode >= 500
  const now = Date.now()
  const sample: Sample = { t: now, ms: input.durationMs, err }

  const key = 'dashboard-api'
  let list = windows.get(key)
  if (!list) windows.set(key, (list = []))
  pushSample(list, sample)

  const oKey = opKey(key, `${input.method} ${input.route}`)
  let op = operations.get(oKey)
  if (!op) {
    if (operations.size >= MAX_OPERATIONS) return
    operations.set(oKey, (op = { service: key, operation: `${input.method} ${input.route}`, samples: [], lastSeen: now }))
  }
  op.lastSeen = now
  pushSample(op.samples, sample)

  if (err) {
    const bucket = errKey(input.method, input.route, input.statusCode)
    let existing = apiErrors5xx.get(bucket)
    if (!existing) {
      if (apiErrors5xx.size >= MAX_PENDING_5XX) return
      existing = { method: input.method, route: input.route, statusCode: input.statusCode, count: 0, traceId: input.traceId }
      apiErrors5xx.set(bucket, existing)
    }
    existing.count += 1
  }
}

/** Records one PostgreSQL operation (template only — parameters never stored). */
export function recordDb(input: { operation: string; durationMs: number; ok: boolean }): void {
  if (!config.telemetry.enabled) return
  const now = Date.now()
  const sample: Sample = { t: now, ms: input.durationMs, err: !input.ok }

  let list = windows.get('postgres')
  if (!list) windows.set('postgres', (list = []))
  pushSample(list, sample)

  const oKey = opKey('postgres', input.operation)
  let op = operations.get(oKey)
  if (!op) {
    if (operations.size >= MAX_OPERATIONS) return
    operations.set(oKey, (op = { service: 'postgres', operation: input.operation, samples: [], lastSeen: now }))
  }
  op.lastSeen = now
  pushSample(op.samples, sample)
}

/** Records an internal/external operation (rayern.sync, rayern.fetch, resend.send). */
export function recordOperation(input: { service: string; operation: string; durationMs: number; ok: boolean }): void {
  if (!config.telemetry.enabled) return
  const now = Date.now()
  const sample: Sample = { t: now, ms: input.durationMs, err: !input.ok }

  let list = windows.get(input.service)
  if (!list) windows.set(input.service, (list = []))
  pushSample(list, sample)

  const oKey = opKey(input.service, input.operation)
  let op = operations.get(oKey)
  if (!op) {
    if (operations.size >= MAX_OPERATIONS) return
    operations.set(oKey, (op = { service: input.service, operation: input.operation, samples: [], lastSeen: now }))
  }
  op.lastSeen = now
  pushSample(op.samples, sample)
}

/* ------------------------------- Read APIs -------------------------------- */

export function serviceSnapshot(service: string): WindowSnapshot {
  return snapshotOf(window(windows.get(service)))
}

export function serviceNamesWithSamples(): string[] {
  const names: string[] = []
  for (const [service, list] of windows) {
    if (window(list).length > 0) names.push(service)
  }
  return names
}

export interface OperationStat {
  service: string
  operation: string
  p95Ms: number
  occurrences: number
  lastSeenAt: number
}

/** All tracked operations with window stats (for slow_operations upserts). */
export function operationStats(): OperationStat[] {
  const now = Date.now()
  const stats: OperationStat[] = []
  for (const op of operations.values()) {
    const samples = window(op.samples, now)
    if (samples.length === 0) continue
    const durations = samples.map((s) => s.ms).sort((a, b) => a - b)
    const p95 = percentile(durations, 95)
    if (p95 === null) continue
    stats.push({
      service: op.service,
      operation: op.operation,
      p95Ms: p95,
      occurrences: samples.length,
      lastSeenAt: op.lastSeen,
    })
  }
  return stats
}

/** Drains pending 5xx buckets (for the errors table) — one consumer per flush. */
export function drainApiErrors5xx(): ApiErrorBucket[] {
  const buckets = [...apiErrors5xx.values()]
  apiErrors5xx.clear()
  return buckets
}

/* --------------------------- Deterministic health ------------------------- */

export interface ComponentHealth {
  status: ComponentHealthStatus
  /** null when the rolling window has no samples — never a fake 0/100. */
  sampleCount: number
  errorRatePct: number | null
  availabilityPct: number | null
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  slowCount: number
}

function healthFromSnapshot(snap: WindowSnapshot, thresholds: {
  errorRateDegradedPct: number
  errorRateFailingPct: number
  p95DegradedMs: number
  p95FailingMs: number
  availabilityDegradedPct: number
  availabilityFailingPct: number
}): ComponentHealth {
  if (snap.count === 0) {
    // Insufficient telemetry: status is healthy-by-default (no evidence of a
    // problem) but every measured field is null — nothing is faked.
    return {
      status: 'healthy',
      sampleCount: 0,
      errorRatePct: null,
      availabilityPct: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      slowCount: 0,
    }
  }
  const sufficient = snap.count >= config.health.minSamples
  const errorRate = snap.errorRatePct ?? 0
  const availability = snap.availabilityPct ?? 100
  const p95 = sufficient ? snap.p95Ms : null

  let status: ComponentHealthStatus = 'healthy'
  const failsError = errorRate >= thresholds.errorRateFailingPct
  const failsLatency = p95 !== null && p95 >= thresholds.p95FailingMs
  const failsAvailability = sufficient && availability < thresholds.availabilityFailingPct
  const degradeError = errorRate >= thresholds.errorRateDegradedPct
  const degradeLatency = p95 !== null && p95 >= thresholds.p95DegradedMs
  const degradeAvailability = sufficient && availability < thresholds.availabilityDegradedPct

  if (failsError || failsLatency || failsAvailability) status = 'failing'
  else if (degradeError || degradeLatency || degradeAvailability) status = 'degraded'

  return {
    status,
    sampleCount: snap.count,
    errorRatePct: errorRate,
    availabilityPct: availability,
    p50Ms: sufficient ? snap.p50Ms : null,
    p95Ms: p95,
    p99Ms: sufficient ? snap.p99Ms : null,
    slowCount: snap.slowCount,
  }
}

/** Health of the dashboard API's own HTTP surface (real telemetry only). */
export function computeApiHealth(): ComponentHealth {
  const snap = serviceSnapshot('dashboard-api')
  const slow = countSlow('dashboard-api')
  snap.slowCount = slow
  return healthFromSnapshot(snap, {
    errorRateDegradedPct: config.health.errorRateDegradedPct,
    errorRateFailingPct: config.health.errorRateFailingPct,
    p95DegradedMs: config.health.latencyP95DegradedMs,
    p95FailingMs: config.health.latencyP95FailingMs,
    availabilityDegradedPct: config.health.availabilityDegradedPct,
    availabilityFailingPct: config.health.availabilityFailingPct,
  })
}

/** Health of the dashboard's PostgreSQL dependency (query success/latency). */
export function computeDbHealth(): ComponentHealth {
  const snap = serviceSnapshot('postgres')
  snap.slowCount = countSlow('postgres')
  return healthFromSnapshot(snap, {
    errorRateDegradedPct: config.health.dbErrorRateDegradedPct,
    errorRateFailingPct: config.health.dbErrorRateFailingPct,
    p95DegradedMs: config.health.latencyP95DegradedMs,
    p95FailingMs: config.health.latencyP95FailingMs,
    availabilityDegradedPct: config.health.availabilityDegradedPct,
    availabilityFailingPct: config.health.availabilityFailingPct,
  })
}

/** Generic per-service status used for service_telemetry rows. */
export function computeServiceStatus(service: string): ComponentHealth {
  if (service === 'dashboard-api') return computeApiHealth()
  if (service === 'postgres') return computeDbHealth()
  const snap = serviceSnapshot(service)
  snap.slowCount = countSlow(service)
  return healthFromSnapshot(snap, {
    errorRateDegradedPct: config.health.errorRateDegradedPct,
    errorRateFailingPct: config.health.errorRateFailingPct,
    p95DegradedMs: config.health.latencyP95DegradedMs,
    p95FailingMs: config.health.latencyP95FailingMs,
    availabilityDegradedPct: config.health.availabilityDegradedPct,
    availabilityFailingPct: config.health.availabilityFailingPct,
  })
}

function countSlow(service: string): number {
  const threshold = service === 'postgres' ? config.telemetry.slowQueryMs : config.telemetry.slowRequestMs
  let n = 0
  for (const s of window(windows.get(service))) {
    if (s.ms >= threshold) n++
  }
  return n
}

/* ------------------------------ Runtime health ---------------------------- */

export interface RuntimeSnapshot {
  uptimeSec: number
  cpuPercent: number | null
  eventLoopDelayP95Ms: number | null
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
}

let started = false
let loopHistogram: IntervalHistogram | null = null
let lastCpuUsage = process.cpuUsage()
let lastCpuAt = Date.now()
const cpuSamples: number[] = []

/**
 * Starts cheap always-on runtime sampling (5s interval, unref'd). Safe under
 * Node and Bun — anything unsupported degrades to null fields, never failure.
 */
export function startRuntimeMonitor(): void {
  if (started) return
  started = true

  try {
    loopHistogram = monitorEventLoopDelay({ resolution: 20 })
    loopHistogram.enable()
  } catch {
    loopHistogram = null
  }

  const tick = (): void => {
    try {
      const usage = process.cpuUsage()
      const now = Date.now()
      const elapsedUs = (now - lastCpuAt) * 1000
      if (elapsedUs > 0) {
        const usedUs = (usage.user - lastCpuUsage.user) + (usage.system - lastCpuUsage.system)
        const pct = (usedUs / elapsedUs) * 100 / Math.max(1, os.cpus().length)
        cpuSamples.push(Number(pct.toFixed(2)))
        if (cpuSamples.length > 12) cpuSamples.shift() // ~60s window
      }
      lastCpuUsage = usage
      lastCpuAt = now
    } catch {
      /* sampling must never break the server */
    }
  }
  tick()
  const timer = setInterval(tick, 5_000)
  timer.unref()
}

/** Real runtime/process telemetry. Unavailable values are null, not zero. */
export function runtimeSnapshot(): RuntimeSnapshot {
  let cpuPercent: number | null = null
  if (cpuSamples.length > 0) {
    cpuPercent = Number((cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length).toFixed(2))
  }
  let eventLoopDelayP95Ms: number | null = null
  try {
    if (loopHistogram) eventLoopDelayP95Ms = Number((loopHistogram.percentile(95) / 1e6).toFixed(3))
  } catch {
    eventLoopDelayP95Ms = null
  }
  const mem = process.memoryUsage()
  return {
    uptimeSec: Math.floor(process.uptime()),
    cpuPercent,
    eventLoopDelayP95Ms,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
  }
}
