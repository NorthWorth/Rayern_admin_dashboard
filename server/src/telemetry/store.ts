/**
 * In-process telemetry store.
 *
 * Receives redacted, aggregate-only samples from the instrumentation layer
 * (HTTP requests, PostgreSQL queries, internal operations) and derives:
 *  - rolling-window counts / error rates / p50-p95-p99 latency percentiles
 *  - HTTP status-class distribution and requests-per-minute
 *  - slow-operation windows (per service + operation)
 *  - deterministic FOUR-STATE health (healthy / degraded / failing / unknown)
 *    from configurable thresholds (config.health) plus TELEMETRY FRESHNESS:
 *    stale or absent telemetry yields `unknown`, never a silent `healthy`.
 *  - health-state transition candidates (persisted + deduplicated by persist.ts)
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

/** Four-state health model: `unknown` = no/stale telemetry — not a claim of health. */
export type ComponentHealthStatus = 'healthy' | 'degraded' | 'failing' | 'unknown'

/** Freshness of a service's telemetry relative to HEALTH_TELEMETRY_STALE_MS. */
export type TelemetryFreshness = 'fresh' | 'stale' | 'none'

/** Bounded HTTP status-class distribution (1xx/other classes are ignored). */
export interface StatusClasses {
  c2: number
  c3: number
  c4: number
  c5: number
}

export interface WindowSnapshot {
  count: number
  successCount: number
  errorCount: number
  slowCount: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  errorRatePct: number | null
  availabilityPct: number | null
  /** Requests observed in the last 60 seconds (bounded — only when samples exist). */
  rpm: number
  classes: StatusClasses
  /** Newest sample timestamp in the window (null when empty). */
  lastSampleAt: number | null
}

interface Sample {
  t: number
  ms: number
  err: boolean
  /** HTTP status class digit (2..5) — only for HTTP samples; 0 = not HTTP. */
  cls: number
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

function classBucket(statusCode: number): number {
  return Math.floor(statusCode / 100)
}

function snapshotOf(samples: Sample[], now = Date.now()): WindowSnapshot {
  const empty: WindowSnapshot = {
    count: 0,
    successCount: 0,
    errorCount: 0,
    slowCount: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    errorRatePct: null,
    availabilityPct: null,
    rpm: 0,
    classes: { c2: 0, c3: 0, c4: 0, c5: 0 },
    lastSampleAt: null,
  }
  if (samples.length === 0) return empty
  const durations = samples.map((s) => s.ms).sort((a, b) => a - b)
  const classes: StatusClasses = { c2: 0, c3: 0, c4: 0, c5: 0 }
  let errorCount = 0
  let lastSampleAt = 0
  let recent = 0
  const minuteAgo = now - 60_000
  for (const s of samples) {
    if (s.err) errorCount++
    if (s.cls === 2) classes.c2++
    else if (s.cls === 3) classes.c3++
    else if (s.cls === 4) classes.c4++
    else if (s.cls === 5) classes.c5++
    if (s.t > lastSampleAt) lastSampleAt = s.t
    if (s.t >= minuteAgo) recent++
  }
  const errorRatePct = (errorCount / samples.length) * 100
  return {
    count: samples.length,
    successCount: samples.length - errorCount,
    errorCount,
    slowCount: 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    errorRatePct: Number(errorRatePct.toFixed(4)),
    availabilityPct: Number((100 - errorRatePct).toFixed(4)),
    rpm: recent,
    classes,
    lastSampleAt,
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
  // Error = server error (5xx). 4xx are client outcomes and are surfaced via
  // the status-class distribution instead of inflating the error rate.
  const err = input.statusCode >= 500
  const now = Date.now()
  const cls = classBucket(input.statusCode)
  const sample: Sample = { t: now, ms: input.durationMs, err, cls: cls >= 2 && cls <= 5 ? cls : 0 }

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
  const sample: Sample = { t: now, ms: input.durationMs, err: !input.ok, cls: 0 }

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
  const sample: Sample = { t: now, ms: input.durationMs, err: !input.ok, cls: 0 }

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
  avgMs: number
  p95Ms: number
  p99Ms: number
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
    const p99 = percentile(durations, 99)
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length
    stats.push({
      service: op.service,
      operation: op.operation,
      avgMs: Number(avg.toFixed(2)),
      p95Ms: p95,
      p99Ms: p99 ?? p95,
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

export interface HealthThresholds {
  errorRateDegradedPct: number
  errorRateFailingPct: number
  p95DegradedMs: number
  p95FailingMs: number
  availabilityDegradedPct: number
  availabilityFailingPct: number
}

export interface ComponentHealth {
  status: ComponentHealthStatus
  /** Human-readable trigger for the current state (transition reason source). */
  reason: string | null
  /** null when the rolling window has no samples — never a fake 0/100. */
  sampleCount: number
  successCount: number
  errorCount: number
  errorRatePct: number | null
  availabilityPct: number | null
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  slowCount: number
  rpm: number
  classes: StatusClasses
  /** Newest telemetry timestamp (ms epoch) — the freshness source of truth. */
  lastTelemetryAt: number | null
  telemetryAgeMs: number | null
  freshness: TelemetryFreshness
  /** Newest success/failure observation in the window (dependency health). */
  lastSuccessAt: number | null
  lastFailureAt: number | null
}

/**
 * Freshness threshold for a service: how old telemetry may get before health
 * degrades to `unknown`. The Rayern pull-sync is expected only once per
 * (default) 30-minute interval, so its allowance scales with the configured
 * interval instead of the general 15-minute default.
 */
export function staleMsFor(service: string): number {
  const base = config.health.telemetryStaleMs
  if (service === 'rayern-sync' && config.rayern.syncEndpoint) {
    return Math.max(base, Math.round(config.rayern.intervalMs * 1.5))
  }
  return base
}

export function freshnessOf(lastTelemetryAt: number | null, now: number, staleMs: number): TelemetryFreshness {
  if (lastTelemetryAt === null) return 'none'
  return now - lastTelemetryAt > staleMs ? 'stale' : 'fresh'
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/**
 * Pure, deterministic health evaluation over a window snapshot.
 *
 * States:
 *  - `unknown`  — no samples at all, OR telemetry older than `staleMs`
 *                 (absence of telemetry is never reported as healthy)
 *  - `failing`  — a failing threshold is crossed (>= error rate / p95,
 *                 < availability)
 *  - `degraded` — a degraded threshold is crossed
 *  - `healthy`  — fresh telemetry and every metric within thresholds
 *
 * Latency/availability are only reported when `count >= minSamples`.
 * Boundary semantics are strict and tested: a metric exactly AT a threshold
 * counts as crossing it (`>=` for error/latency, `<` for availability).
 */
export function evaluateHealth(input: {
  snapshot: WindowSnapshot
  thresholds: HealthThresholds
  minSamples: number
  staleMs: number
  now?: number
  slowCount?: number
}): ComponentHealth {
  const { snapshot: snap, thresholds, minSamples, staleMs } = input
  const now = input.now ?? Date.now()
  const slowCount = input.slowCount ?? snap.slowCount
  const freshness = freshnessOf(snap.lastSampleAt, now, staleMs)
  const ageMs = snap.lastSampleAt === null ? null : now - snap.lastSampleAt
  // Latency is only REPORTED once the window has minSamples observations —
  // below that it is null (never a fake 0ms), matching the threshold gate.
  const sufficient = snap.count >= minSamples

  const base = {
    sampleCount: snap.count,
    successCount: snap.successCount,
    errorCount: snap.errorCount,
    errorRatePct: snap.errorRatePct,
    availabilityPct: snap.availabilityPct,
    p50Ms: sufficient ? snap.p50Ms : null,
    p95Ms: sufficient ? snap.p95Ms : null,
    p99Ms: sufficient ? snap.p99Ms : null,
    slowCount,
    rpm: snap.rpm,
    classes: snap.classes,
    lastTelemetryAt: snap.lastSampleAt,
    telemetryAgeMs: ageMs,
    freshness,
    lastSuccessAt: null as number | null,
    lastFailureAt: null as number | null,
  }

  if (snap.count === 0) {
    return { ...base, status: 'unknown', reason: 'no telemetry observed yet' }
  }
  if (freshness !== 'fresh') {
    const mins = ageMs !== null ? Math.max(1, Math.round(ageMs / 60_000)) : null
    return {
      ...base,
      status: 'unknown',
      reason: mins !== null ? `telemetry stale — no observations for ${mins}m` : 'telemetry stale',
    }
  }

  const errorRate = snap.errorRatePct ?? 0
  const availability = snap.availabilityPct ?? 100
  const p95 = sufficient ? snap.p95Ms : null

  const failError = errorRate >= thresholds.errorRateFailingPct
  const failLatency = p95 !== null && p95 >= thresholds.p95FailingMs
  const failAvailability = sufficient && availability < thresholds.availabilityFailingPct
  const degradeError = errorRate >= thresholds.errorRateDegradedPct
  const degradeLatency = p95 !== null && p95 >= thresholds.p95DegradedMs
  const degradeAvailability = sufficient && availability < thresholds.availabilityDegradedPct

  if (failError) {
    return { ...base, status: 'failing', reason: `error rate ${fmt(errorRate)}% ≥ failing ${fmt(thresholds.errorRateFailingPct)}%` }
  }
  if (failLatency) {
    return { ...base, status: 'failing', reason: `p95 latency ${fmt(p95 ?? 0)}ms ≥ failing ${thresholds.p95FailingMs}ms` }
  }
  if (failAvailability) {
    return { ...base, status: 'failing', reason: `availability ${fmt(availability)}% < failing ${fmt(thresholds.availabilityFailingPct)}%` }
  }
  if (degradeError) {
    return { ...base, status: 'degraded', reason: `error rate ${fmt(errorRate)}% ≥ degraded ${fmt(thresholds.errorRateDegradedPct)}%` }
  }
  if (degradeLatency) {
    return { ...base, status: 'degraded', reason: `p95 latency ${fmt(p95 ?? 0)}ms ≥ degraded ${thresholds.p95DegradedMs}ms` }
  }
  if (degradeAvailability) {
    return { ...base, status: 'degraded', reason: `availability ${fmt(availability)}% < degraded ${fmt(thresholds.availabilityDegradedPct)}%` }
  }
  return { ...base, status: 'healthy', reason: 'all metrics within thresholds' }
}

function windowHealthWithSlow(service: string, thresholds: HealthThresholds): ComponentHealth {
  const snap = serviceSnapshot(service)
  const slow = countSlow(service)
  const samples = window(windows.get(service))
  let lastSuccessAt: number | null = null
  let lastFailureAt: number | null = null
  for (const s of samples) {
    if (s.err) {
      if (lastFailureAt === null || s.t > lastFailureAt) lastFailureAt = s.t
    } else if (lastSuccessAt === null || s.t > lastSuccessAt) {
      lastSuccessAt = s.t
    }
  }
  const health = evaluateHealth({
    snapshot: snap,
    thresholds,
    minSamples: config.health.minSamples,
    staleMs: staleMsFor(service),
    slowCount: slow,
  })
  health.lastSuccessAt = lastSuccessAt
  health.lastFailureAt = lastFailureAt
  return health
}

/** Thresholds for the dashboard API and generic services (config-driven). */
function defaultThresholds(): HealthThresholds {
  return {
    errorRateDegradedPct: config.health.errorRateDegradedPct,
    errorRateFailingPct: config.health.errorRateFailingPct,
    p95DegradedMs: config.health.latencyP95DegradedMs,
    p95FailingMs: config.health.latencyP95FailingMs,
    availabilityDegradedPct: config.health.availabilityDegradedPct,
    availabilityFailingPct: config.health.availabilityFailingPct,
  }
}

/** Thresholds for PostgreSQL (its own error-rate tolerances). */
function dbThresholds(): HealthThresholds {
  return {
    ...defaultThresholds(),
    errorRateDegradedPct: config.health.dbErrorRateDegradedPct,
    errorRateFailingPct: config.health.dbErrorRateFailingPct,
  }
}

/** Health of the dashboard API's own HTTP surface (real telemetry only). */
export function computeApiHealth(): ComponentHealth {
  return windowHealthWithSlow('dashboard-api', defaultThresholds())
}

/** Health of the dashboard's PostgreSQL dependency (query success/latency). */
export function computeDbHealth(): ComponentHealth {
  return windowHealthWithSlow('postgres', dbThresholds())
}

/** Generic per-service health from the rolling window. */
export function computeServiceStatus(service: string): ComponentHealth {
  if (service === 'dashboard-api') return computeApiHealth()
  if (service === 'postgres') return computeDbHealth()
  return windowHealthWithSlow(service, defaultThresholds())
}

function countSlow(service: string): number {
  const threshold = service === 'postgres' ? config.telemetry.slowQueryMs : config.telemetry.slowRequestMs
  let n = 0
  for (const s of window(windows.get(service))) {
    if (s.ms >= threshold) n++
  }
  return n
}

/**
 * Whether a health-state change should be persisted as a transition.
 * Deduplication rule: only an ACTUAL change of the previously recorded state
 * creates a row — an ongoing condition never produces duplicates, and the
 * first-ever observation (previous = null) is an initial state, not a
 * transition. Exported for tests.
 */
export function shouldRecordTransition(
  previous: ComponentHealthStatus | null,
  next: ComponentHealthStatus,
): boolean {
  return previous !== null && previous !== next
}

/** Aggregate worst-case rollup used for the platform `overall` status. */
export function worstHealth(statuses: readonly ComponentHealthStatus[]): ComponentHealthStatus {
  const rank: Record<ComponentHealthStatus, number> = { unknown: 0, healthy: 1, degraded: 2, failing: 3 }
  let worst: ComponentHealthStatus = 'unknown'
  for (const s of statuses) {
    if (rank[s] > rank[worst]) worst = s
  }
  // All-unknown (or empty) stays unknown; a single healthy observation wins
  // over unknown because there IS evidence of health.
  if (worst === 'unknown') {
    return statuses.includes('healthy') ? 'healthy' : 'unknown'
  }
  return worst
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
