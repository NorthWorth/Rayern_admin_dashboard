/**
 * OpenTelemetry / telemetry test suite for the dashboard backend.
 *
 * Boots the API as a child process (same pattern as smoke.ts) with a
 * deliberately DEAD OTLP endpoint, then verifies against the real HTTP API:
 *
 *   1. HTTP requests produce telemetry (spans, request counts, percentiles)
 *   2. API errors (5xx) and PostgreSQL failures are observable
 *   3. Sensitive data is never exported: no Authorization/JWT/Bearer tokens,
 *      no emails, no query strings, no raw paths with identifiers, no SQL
 *      parameters — only route/operation templates and aggregates
 *   4. A dead OTLP exporter never affects the API (requests keep returning
 *      normal responses throughout)
 *   5. System health is computed from real telemetry (numbers, not fake 0s)
 *   6. With telemetry disabled the API still works and reports null
 *      (unavailable) metrics instead of fabricated zeros
 *   7. In-process unit checks: sanitizer redaction, percentile math, and
 *      deterministic health thresholds (including insufficient-data nulls)
 *
 * Usage: bun run telemetry-test
 */
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 4561
const BASE = `http://127.0.0.1:${PORT}`
const DEAD_OTLP = 'http://127.0.0.1:9/v1/traces' // discard port: exporter can never succeed

const ADMIN_EMAIL = 'telemetry-admin@rayern.com.ng'
const ADMIN_PASSWORD = 'telemetry-test-password-123'
const JWT_SECRET = 'telemetry-jwt-secret'
/** Sentinel strings that must NEVER appear in any telemetry output. */
const SECRETS = [
  ADMIN_PASSWORD,
  JWT_SECRET,
  'Bearer ',
  'authorization',
  'secretemail-should-not-leak@example.com',
  'not-a-uuid-value',
  'search=',
  '@rayern.com.ng', // no email address may ever leave as telemetry
]

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function req(
  method: string,
  reqPath: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${BASE}${reqPath}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json: json as any, text }
}

async function waitPortFree(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => {
        s.destroy()
        resolve(false)
      })
      s.once('error', () => resolve(true))
    })
    if (free) return
    await new Promise((r) => setTimeout(r, 200))
  }
}

function startApi(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn('bun', ['node_modules/.bin/tsx', 'src/index.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`  [api] ${d}`))
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`  [api:err] ${d}`))
  return Promise.resolve(child)
}

async function waitReady(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ------------------------- In-process unit checks ------------------------- */

async function unitChecks(): Promise<void> {
  console.log('\n[unit] sanitizer + health calculator')

  const { sanitizeSql, sanitizeErrorMessage } = await import('./telemetry/sanitize')
  const store = await import('./telemetry/store')

  const sql = sanitizeSql(`SELECT * FROM accounts WHERE email = 'leak@example.com' AND id = '3f2b9c1e-1111-2222-3333-444455556666' -- comment`)
  check('SQL literals stripped from statement template', !sql.includes('leak@example.com') && !sql.includes('3f2b9c1e'), sql)
  check('SQL template keeps structure', sql.startsWith('SELECT * FROM accounts WHERE email = ?'), sql)
  check('SQL comments removed', !sql.includes('comment'), sql)

  const msg = sanitizeErrorMessage(`duplicate key value violates unique constraint on "leak@example.com" and 3f2b9c1e-1111-2222-3333-444455556666 and 'literal'`)
  check('Error messages scrub emails', !msg.includes('leak@example.com'), msg)
  check('Error messages scrub UUIDs', !msg.includes('3f2b9c1e-1111'), msg)
  check('Error messages scrub quoted literals', !msg.includes("'literal'"), msg)

  // Percentile math + deterministic thresholds via the real store.
  process.env.TELEMETRY_ENABLED = 'true'
  for (let i = 1; i <= 20; i++) store.recordHttp({ method: 'GET', route: '/unit', statusCode: 200, durationMs: i, traceId: null })
  const snap = store.serviceSnapshot('dashboard-api')
  check('Window snapshot counts samples', snap.count === 20, `count=${snap.count}`)
  check('p50 percentile computed', snap.p50Ms !== null && snap.p50Ms >= 9 && snap.p50Ms <= 11, `p50=${snap.p50Ms}`)
  check('p95 percentile computed', snap.p95Ms !== null && snap.p95Ms >= 19 && snap.p95Ms <= 20, `p95=${snap.p95Ms}`)
  check('No errors → 0% error rate', (snap.errorRatePct ?? -1) === 0, `err=${snap.errorRatePct}`)

  // Threshold crossing: flood with 5xx so the error rate crosses FAILING.
  for (let i = 0; i < 30; i++) store.recordHttp({ method: 'GET', route: '/unit-fail', statusCode: 500, durationMs: 5, traceId: null })
  const health = store.computeApiHealth()
  check('High error rate → failing status', health.status === 'failing', `status=${health.status} err=${health.errorRatePct}`)

  const buckets = store.drainApiErrors5xx()
  check('5xx buckets accumulated for the errors table', buckets.length > 0 && buckets.every((b) => b.statusCode === 500), JSON.stringify(buckets.map((b) => b.statusCode)))
}

/* ------------------ Four-state health / freshness / transitions ------------ */

function mkSnap(count: number, errorCount: number, p95: number, lastAt: number | null): import('./telemetry/store').WindowSnapshot {
  const rate = count === 0 ? null : (errorCount / count) * 100
  return {
    count,
    successCount: count - errorCount,
    errorCount,
    slowCount: 0,
    p50Ms: count > 0 ? Math.round(p95 * 0.5) : null,
    p95Ms: count > 0 ? p95 : null,
    p99Ms: count > 0 ? p95 : null,
    errorRatePct: rate === null ? null : Number(rate.toFixed(4)),
    availabilityPct: rate === null ? null : Number((100 - rate).toFixed(4)),
    rpm: count,
    classes: { c2: count - errorCount, c3: 0, c4: 0, c5: errorCount },
    lastSampleAt: lastAt,
  }
}

async function healthUnitChecks(): Promise<void> {
  console.log('\n[unit] four-state health: thresholds, boundaries, freshness, transitions')
  const store = await import('./telemetry/store')
  const now = Date.now()
  const staleMs = 900_000
  const TH = {
    errorRateDegradedPct: 1,
    errorRateFailingPct: 5,
    p95DegradedMs: 500,
    p95FailingMs: 2_000,
    availabilityDegradedPct: 99,
    availabilityFailingPct: 95,
  }
  const evalAt = (snap: ReturnType<typeof mkSnap>): ReturnType<typeof store.evaluateHealth> =>
    store.evaluateHealth({ snapshot: snap, thresholds: TH, minSamples: 10, staleMs, now })

  // --- Zero requests / no telemetry → unknown, never healthy ---
  const zero = evalAt(mkSnap(0, 0, 0, now))
  check('zero requests → unknown (no data, not healthy)', zero.status === 'unknown', `status=${zero.status}`)
  check('zero requests → all measured fields null', zero.errorRatePct === null && zero.p95Ms === null && zero.availabilityPct === null)
  const never = evalAt(mkSnap(0, 0, 0, null))
  check('never-observed → unknown with freshness none', never.status === 'unknown' && never.freshness === 'none')

  // --- Error-rate threshold boundaries (exactly AT a threshold crosses it) ---
  check('error rate exactly at degraded (1%) → degraded', evalAt(mkSnap(100, 1, 100, now)).status === 'degraded')
  check('error rate just below degraded (0.1%) → healthy', evalAt(mkSnap(1_000, 1, 100, now)).status === 'healthy')
  check('error rate just below failing (2%) → degraded', evalAt(mkSnap(100, 2, 100, now)).status === 'degraded')
  check('error rate exactly at failing (5%) → failing', evalAt(mkSnap(100, 5, 100, now)).status === 'failing')
  check('zero errors with traffic → healthy', evalAt(mkSnap(100, 0, 100, now)).status === 'healthy')

  // --- Latency threshold boundaries (only with minSamples) ---
  check('p95 exactly at degraded (500ms) → degraded', evalAt(mkSnap(20, 0, 500, now)).status === 'degraded')
  check('p95 just below degraded (499ms) → healthy', evalAt(mkSnap(20, 0, 499, now)).status === 'healthy')
  check('p95 exactly at failing (2000ms) → failing', evalAt(mkSnap(20, 0, 2_000, now)).status === 'failing')
  const insufficient = evalAt(mkSnap(5, 0, 5_000, now))
  check('below minSamples → latency not reported (p95 null)', insufficient.p95Ms === null, `p95=${String(insufficient.p95Ms)}`)
  check('below minSamples → latency ignored for status', insufficient.status === 'healthy', `status=${insufficient.status}`)

  // --- Freshness: stale telemetry can never appear healthy ---
  check('age exactly at threshold → still fresh', store.freshnessOf(now - staleMs, now, staleMs) === 'fresh')
  check('age just past threshold → stale', store.freshnessOf(now - staleMs - 1, now, staleMs) === 'stale')
  check('no telemetry → none', store.freshnessOf(null, now, staleMs) === 'none')
  const staleHealth = evalAt(mkSnap(1_000, 0, 50, now - staleMs - 1))
  check('stale telemetry → unknown (not healthy)', staleHealth.status === 'unknown', `status=${staleHealth.status}`)
  check('stale unknown carries a staleness reason', (staleHealth.reason ?? '').includes('stale'), `reason=${staleHealth.reason}`)
  check('stale unknown keeps real metrics + reports age', staleHealth.freshness === 'stale' && staleHealth.telemetryAgeMs !== null)

  // --- Threshold reasons feed transition records ---
  const failingHealth = evalAt(mkSnap(100, 5, 100, now))
  check('failing reason names the metric', (failingHealth.reason ?? '').includes('error rate'), `reason=${failingHealth.reason}`)

  // --- Transition deduplication rules ---
  check('initial state is not a transition', store.shouldRecordTransition(null, 'healthy') === false)
  check('unchanged state → no duplicate transition', store.shouldRecordTransition('healthy', 'healthy') === false)
  check('ongoing failing → no duplicate transition', store.shouldRecordTransition('failing', 'failing') === false)
  check('healthy → failing records a transition', store.shouldRecordTransition('healthy', 'failing') === true)
  check('degraded → healthy (recovery) records a transition', store.shouldRecordTransition('degraded', 'healthy') === true)
  check('healthy → unknown (stale) records a transition', store.shouldRecordTransition('healthy', 'unknown') === true)
  check('failing → unknown records a transition', store.shouldRecordTransition('failing', 'unknown') === true)
  check('unknown → healthy (recovery) records a transition', store.shouldRecordTransition('unknown', 'healthy') === true)

  // --- Status-class distribution + rpm + operation stats (bounded) ---
  process.env.TELEMETRY_ENABLED = 'true'
  const before = store.serviceSnapshot('dashboard-api')
  store.recordHttp({ method: 'GET', route: '/classes', statusCode: 200, durationMs: 5, traceId: null })
  store.recordHttp({ method: 'GET', route: '/classes', statusCode: 304, durationMs: 3, traceId: null })
  store.recordHttp({ method: 'GET', route: '/classes', statusCode: 404, durationMs: 4, traceId: null })
  store.recordHttp({ method: 'GET', route: '/classes', statusCode: 503, durationMs: 7, traceId: null })
  const after = store.serviceSnapshot('dashboard-api')
  check('2xx class counted', after.classes.c2 - before.classes.c2 === 1, `Δc2=${after.classes.c2 - before.classes.c2}`)
  check('3xx class counted', after.classes.c3 - before.classes.c3 === 1, `Δc3=${after.classes.c3 - before.classes.c3}`)
  check('4xx class counted', after.classes.c4 - before.classes.c4 === 1, `Δc4=${after.classes.c4 - before.classes.c4}`)
  check('5xx class counted', after.classes.c5 - before.classes.c5 === 1, `Δc5=${after.classes.c5 - before.classes.c5}`)
  check('4xx does NOT inflate the server error rate', (after.errorCount ?? 0) - (before.errorCount ?? 0) === 1, `Δerr=${(after.errorCount ?? 0) - (before.errorCount ?? 0)}`)
  check('requests-per-minute derived from live samples', after.rpm >= 4, `rpm=${after.rpm}`)
  check('snapshot exposes success count', after.successCount === after.count - after.errorCount)

  store.recordOperation({ service: 'unit-op', operation: 'unit.op', durationMs: 42, ok: true })
  store.recordOperation({ service: 'unit-op', operation: 'unit.op', durationMs: 142, ok: true })
  const opStat = store.operationStats().find((o) => o.service === 'unit-op')
  check('operation stats expose avg alongside p95/p99', typeof opStat?.avgMs === 'number' && typeof opStat?.p99Ms === 'number', JSON.stringify(opStat ?? null))
  check('operation p99 ≥ p95', (opStat?.p99Ms ?? 0) >= (opStat?.p95Ms ?? 0))

  // --- Dependency health: an unobserved dependency is unknown ---
  const resendHealth = store.computeServiceStatus('resend')
  check('unobserved dependency (resend) → unknown, not healthy', resendHealth.status === 'unknown', `status=${resendHealth.status}`)
  check('unobserved dependency reports freshness none', resendHealth.freshness === 'none')
  const worst = store.worstHealth(['unknown', 'unknown'])
  check('all-unknown rolls up to unknown', worst === 'unknown')
  check('healthy wins over unknown in rollup', store.worstHealth(['unknown', 'healthy']) === 'healthy')
  check('failing dominates the overall rollup', store.worstHealth(['healthy', 'degraded', 'failing']) === 'failing')
}

/* ---------------------------- Integration checks -------------------------- */

async function integrationChecks(): Promise<void> {
  console.log('\n[integration] telemetry via the live API (dead OTLP exporter configured)')

  await waitPortFree(PORT)
  const child = await startApi({
    PORT: String(PORT),
    API_PORT: String(PORT),
    EMBEDDED_PG_PORT: '54331',
    ADMIN_JWT_SECRET: JWT_SECRET,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    ADMIN_NAME: 'Telemetry Admin',
    EMAIL_DRY_RUN: '1',
    // Dead exporter on purpose: proves export failures never affect the API.
    OTEL_EXPORTER_OTLP_ENDPOINT: DEAD_OTLP,
    TELEMETRY_FLUSH_MS: '1500',
    // Fast history rollups so the test observes service_history being written.
    TELEMETRY_HISTORY_ROLLUP_MS: '1500',
    HEALTH_MIN_SAMPLES: '10',
    // No DATABASE_URL → embedded PGlite. No RAYERN_* → sync disabled.
  })

  const ready = await waitReady()
  check('API starts with a dead OTLP endpoint (startup not blocked)', ready)
  if (!ready) {
    child.kill('SIGTERM')
    return
  }

  // Traffic: health checks, auth failures (401), a query string that must not
  // leak, a route with an identifier, and a deterministic 500 via bad UUID.
  for (let i = 0; i < 6; i++) await req('GET', '/healthz')
  await req('POST', '/auth/login', { body: { email: 'wrong@wrong.invalid', password: 'nope' } })

  const login = await req('POST', '/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  check('Admin login works during telemetry export failures', login.status === 200 && typeof login.json?.token === 'string')
  const token = login.json?.token as string | undefined

  // Sensitive query string + sensitive raw path (identifier).
  await req('GET', '/users?search=secretemail-should-not-leak@example.com&page=1')
  if (token) {
    for (let i = 0; i < 5; i++) await req('GET', '/users/stats', { token })
    await req('GET', '/workspaces/stats', { token })
    await req('GET', '/system/overview', { token })
    await req('GET', '/observability/overview', { token })
    // Deterministic PostgreSQL failure: invalid UUID → PG error → 500.
    const boom = await req('GET', '/emails/not-a-uuid-value/body', { token })
    check('Intentional PostgreSQL failure returns 500', boom.status === 500, `got ${boom.status}`)
  }
  await req('GET', '/definitely-not-a-route')

  // Wait for at least two persistence flushes (1500ms each) + margin.
  await sleep(5_000)

  if (token) {
    const obs = await req('GET', '/observability/overview', { token })
    check('Observability overview → 200', obs.status === 200)

    const services: Array<{ service: string; requestCount: number; p95: number | null | number }> = obs.json?.services ?? []
    const apiSvc = services.find((s) => s.service === 'dashboard-api')
    check('service_telemetry backed by real data (dashboard-api row)', Boolean(apiSvc), JSON.stringify(services.map((s) => s.service)))
    check('Real request count recorded', (apiSvc?.requestCount ?? 0) >= 10, `count=${apiSvc?.requestCount}`)
    check('Real latency percentiles recorded', (apiSvc?.p95 ?? 0) > 0, `p95=${apiSvc?.p95}`)
    check('PostgreSQL service telemetry recorded', services.some((s) => s.service === 'postgres'))

    const traces: Array<{ operation: string; traceId: string; hasError: boolean; service: string }> = obs.json?.recentTraces ?? []
    check('trace_spans populated with real spans', traces.length > 0, `n=${traces.length}`)
    check('HTTP route template spans present', traces.some((t) => t.operation === 'GET /healthz'), JSON.stringify(traces.slice(0, 8).map((t) => t.operation)))
    check('Authenticated route template spans present', traces.some((t) => t.operation === 'GET /users/stats'))
    check('DB failure span recorded as error', traces.some((t) => t.service === 'postgres' && t.hasError))
    check('Raw identifier never used as operation (template instead)', traces.some((t) => t.operation.includes('/emails/:id/body')), `operations=${JSON.stringify(traces.map((t) => t.operation))}`)

    const slow: Array<{ service: string; operation: string; p95: number }> = obs.json?.slowOperations ?? []
    check('slow_operations populated', slow.length > 0, JSON.stringify(slow.map((s) => s.operation)))

    // ---- Redaction: no sensitive string may appear anywhere in telemetry ----
    const obsText = JSON.stringify(obs.json ?? {})
    for (const secret of SECRETS) {
      check(`Observability output contains no "${secret}"`, !obsText.includes(secret))
    }
    check('No operation leaks a query string', !obsText.includes('?search='))

    const sys = await req('GET', '/system/overview', { token })
    check('System overview → 200', sys.status === 200)
    check('request_count24h reflects real traffic', (sys.json?.requestCount24h ?? 0) >= 10, `n=${sys.json?.requestCount24h}`)
    check('error rate is a real number (5xx observed)', typeof sys.json?.errorRatePct === 'number' && sys.json.errorRatePct > 0, `err=${sys.json?.errorRatePct}`)
    check('latency p95 measured (not fake null/0)', typeof sys.json?.latency?.p95 === 'number' && sys.json.latency.p95 > 0, `p95=${sys.json?.latency?.p95}`)
    check(
      'Dashboard API service row has real status + measured availability',
      (sys.json?.services ?? []).some(
        (s: { name: string; status: string; uptimePct30d: number | null }) =>
          s.name === 'Dashboard API' && ['healthy', 'degraded', 'failing'].includes(s.status) && typeof s.uptimePct30d === 'number',
      ),
      JSON.stringify((sys.json?.services ?? []).map((s: { name: string }) => s.name)),
    )
    check('PostgreSQL dependency service row present', (sys.json?.services ?? []).some((s: { name: string }) => s.name === 'PostgreSQL'))
    check('Runtime telemetry reported (cpu)', sys.json?.meta?.cpuPercent !== undefined, JSON.stringify(sys.json?.meta))
    check('Runtime telemetry reported (event loop)', sys.json?.meta?.eventLoopDelayP95Ms !== undefined)
    const sysText = JSON.stringify(sys.json ?? {})
    for (const secret of SECRETS) {
      check(`System output contains no "${secret}"`, !sysText.includes(secret))
    }

    const errs = await req('GET', '/errors', { token })
    const errList: Array<{ statusCode: number; service: string; traceId: string | null }> = Array.isArray(errs.json) ? errs.json : []
    check('API 500 recorded on the Errors page', errList.some((e) => e.statusCode === 500 && e.service === 'Dashboard API'), JSON.stringify(errList.slice(0, 5)))
    check('PostgreSQL failure recorded as operational error', errList.some((e) => e.statusCode === 500), '')
    check('500 error row correlated with its trace id', errList.some((e) => typeof e.traceId === 'string' && e.traceId.length === 32), JSON.stringify(errList.slice(0, 3).map((e) => e.traceId)))
    const errsText = JSON.stringify(errs.json ?? {})
    for (const secret of SECRETS) {
      check(`Errors output contains no "${secret}"`, !errsText.includes(secret))
    }
    const errStatusClasses = Array.isArray(errs.json) ? (errs.json as Array<{ statusClass?: string }>) : []
    check(
      'errors expose bounded status classes',
      errStatusClasses.length > 0 &&
        errStatusClasses.every((e) => ['1xx', '2xx', '3xx', '4xx', '5xx', 'n/a'].includes(e.statusClass ?? '')),
      JSON.stringify(errStatusClasses.slice(0, 3).map((e) => e.statusClass)),
    )

    /* -------- Platform health model: freshness / dependencies / history -------- */
    const overall = sys.json?.overall
    check('system overall uses the four-state health model', ['healthy', 'degraded', 'failing', 'unknown'].includes(String(overall)), `overall=${String(overall)}`)
    const svcRows: Array<{
      name?: string
      status?: string
      historyKey?: string | null
      reason?: string | null
      freshness?: { status?: string }
    }> = Array.isArray(sys.json?.services) ? sys.json.services : []
    check(
      'every service row carries freshness',
      svcRows.length > 0 && svcRows.every((s) => ['fresh', 'stale', 'none'].includes(s.freshness?.status ?? '')),
      JSON.stringify(svcRows.map((s) => `${s.name}:${s.freshness?.status}`)),
    )
    const dashRow = svcRows.find((s) => s.name === 'Dashboard API')
    check('Dashboard API row is fresh after live traffic', dashRow?.freshness?.status === 'fresh', JSON.stringify(dashRow ?? {}))
    check('actively observed service is not unknown', dashRow?.status !== 'unknown' && ['healthy', 'degraded', 'failing'].includes(dashRow?.status ?? ''), `status=${dashRow?.status}`)
    check('Dashboard API row exposes history drill-down key', dashRow?.historyKey === 'dashboard-api', `key=${String(dashRow?.historyKey)}`)
    check('service rows expose a decision reason', svcRows.every((s) => typeof s.reason === 'string'), '')

    const depRows: Array<{ id?: string; status?: string; configured?: boolean; historyKey?: string | null }> =
      Array.isArray(sys.json?.dependencies) ? sys.json.dependencies : []
    check(
      'only real dependencies exposed (postgresql, rayern, resend)',
      ['dep:postgresql', 'dep:rayern-metrics', 'dep:resend'].every((id) => depRows.some((d) => d.id === id)),
      JSON.stringify(depRows.map((d) => d.id)),
    )
    const rayernDep = depRows.find((d) => d.id === 'dep:rayern-metrics')
    check(
      'unconfigured Rayern dependency reports unknown (not healthy)',
      rayernDep?.configured === false && rayernDep?.status === 'unknown',
      JSON.stringify(rayernDep ?? {}),
    )
    check('runtime meta exposes pool pressure', typeof (sys.json?.meta as { pool?: { total?: number } } | undefined)?.pool?.total === 'number')

    const hist = await req('GET', '/system/history?service=dashboard-api&range=24h', { token })
    const histPoints: Array<{ requestCount?: number; errorRatePct?: number | null }> =
      hist.status === 200 && Array.isArray((hist.json as { points?: unknown[] })?.points) ? (hist.json as { points: [] }).points : []
    check('history endpoint returns full 24h series', histPoints.length >= 24 && histPoints.length <= 26, `points=${histPoints.length}`)
    check('history rollup aggregates REAL requests', histPoints.some((p) => (p.requestCount ?? 0) > 0), `max=${Math.max(0, ...histPoints.map((p) => p.requestCount ?? 0))}`)
    check(
      'history buckets with no traffic report null metrics (not 0)',
      histPoints.some((p) => p.requestCount === 0 && p.errorRatePct === null),
      JSON.stringify(histPoints.slice(0, 3)),
    )
    const hist7 = await req('GET', '/system/history?service=postgres&range=7d', { token })
    check('7d postgres history → 200 series', hist7.status === 200 && Array.isArray((hist7.json as { points?: unknown[] }).points))
    const histBad = await req('GET', '/system/history?service=bad;DROP&range=24h', { token })
    check('history rejects invalid service key → 4xx', histBad.status >= 400 && histBad.status < 500, `got=${histBad.status}`)
    const histText = JSON.stringify(hist.json ?? {})
    for (const secret of SECRETS) {
      check(`History output contains no "${secret}"`, !histText.includes(secret))
    }

    const trans = await req('GET', '/system/transitions?range=24h', { token })
    check('transitions endpoint → 200 array', trans.status === 200 && Array.isArray(trans.json))
    const transText = JSON.stringify(trans.json ?? {})
    for (const secret of SECRETS) {
      check(`Transitions output contains no "${secret}"`, !transText.includes(secret))
    }

    /* ------------------- Observability: freshness + aggregates ------------------ */
    const obsHealthServices: Array<{
      service?: string
      status?: string
      errorCount?: number
      successCount?: number
      freshness?: { status?: string }
    }> = Array.isArray(obs.json?.services) ? obs.json.services : []
    check(
      'observability rows carry four-state status + freshness + error/success counts',
      obsHealthServices.length > 0 &&
        obsHealthServices.every(
          (s) =>
            ['healthy', 'degraded', 'failing', 'unknown'].includes(s.status ?? '') &&
            typeof s.errorCount === 'number' &&
            typeof s.successCount === 'number' &&
            ['fresh', 'stale', 'none'].includes(s.freshness?.status ?? ''),
        ),
      JSON.stringify(obsHealthServices.map((s) => `${s.service}:${s.status}`)),
    )
    const obsSlow: Array<{ avgMs?: number; p99?: number }> = Array.isArray(obs.json?.slowOperations) ? obs.json.slowOperations : []
    check('slow operations expose avg + p99', obsSlow.length > 0 && obsSlow.every((op) => typeof op.avgMs === 'number' && typeof op.p99 === 'number'))
    const obsTrend: Array<{ errorRatePct: number | null }> = Array.isArray(obs.json?.errorRateTrend) ? obs.json.errorRateTrend : []
    check(
      'error-rate trend allows null (no traffic ≠ 0%)',
      obsTrend.length > 0 && obsTrend.every((p) => p.errorRatePct === null || typeof p.errorRatePct === 'number'),
    )
    check('empty trend buckets are null at least once', obsTrend.some((p) => p.errorRatePct === null), JSON.stringify(obsTrend.slice(0, 3)))
  }

  // Requests still succeed AFTER all of this — exporter failures never
  // degraded or broke a single request.
  const after = await req('GET', '/healthz')
  check('API healthy after sustained telemetry export failures', after.status === 200 && after.json?.ok === true)

  child.kill('SIGTERM')
  await waitPortFree(PORT, 10_000)

  /* -------------------- Telemetry disabled: API unaffected ---------------- */
  console.log('\n[integration] TELEMETRY_ENABLED=false — API must run normally with null metrics')
  const child2 = await startApi({
    PORT: String(PORT),
    API_PORT: String(PORT),
    EMBEDDED_PG_PORT: '54332',
    ADMIN_JWT_SECRET: JWT_SECRET,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    TELEMETRY_ENABLED: 'false',
    OTEL_EXPORTER_OTLP_ENDPOINT: DEAD_OTLP,
  })
  const ready2 = await waitReady()
  check('API starts with telemetry disabled', ready2)
  if (ready2) {
    const h = await req('GET', '/healthz')
    check('healthz works with telemetry disabled', h.status === 200)
    const login2 = await req('POST', '/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const token2 = login2.json?.token as string | undefined
    if (token2) {
      for (let i = 0; i < 3; i++) await req('GET', '/users/stats', { token: token2 })
      const sys2 = await req('GET', '/system/overview', { token: token2 })
      check('System overview works with telemetry disabled', sys2.status === 200)
      check('No fabricated error rate when telemetry is off (null)', sys2.json?.errorRatePct === null, `got=${sys2.json?.errorRatePct}`)
      check('No fabricated latency when telemetry is off (null)', sys2.json?.latency?.p95 === null, `got=${sys2.json?.latency?.p95}`)
      const obs2 = await req('GET', '/observability/overview', { token: token2 })
      check('Observability works with telemetry disabled', obs2.status === 200)
      check('No telemetry rows fabricated when disabled', (obs2.json?.services ?? []).length === 0, JSON.stringify(obs2.json?.services))
    }
  }
  child2.kill('SIGTERM')
  await waitPortFree(PORT, 10_000)

  /* ------- Stale telemetry: a quiet service must become Unknown, not stay healthy ------ */
  console.log('\n[integration] stale telemetry → Unknown / No Data (never silently healthy)')
  const child3 = await startApi({
    PORT: String(PORT),
    API_PORT: String(PORT),
    EMBEDDED_PG_PORT: '54333',
    ADMIN_JWT_SECRET: JWT_SECRET,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    EMAIL_DRY_RUN: '1',
    // Freshness threshold tiny on purpose: 5s without telemetry → unknown.
    HEALTH_TELEMETRY_STALE_MS: '5000',
    TELEMETRY_FLUSH_MS: '1000',
  })
  const ready3 = await waitReady()
  check('API starts with a 5s freshness threshold', ready3)
  if (ready3) {
    const login3 = await req('POST', '/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const token3 = login3.json?.token as string | undefined
    if (token3) {
      // Generate healthy traffic, then let a flush persist status=healthy.
      for (let i = 0; i < 4; i++) await req('GET', '/users/stats', { token: token3 })
      await sleep(1_500)
      const beforeStale = await req('GET', '/system/overview', { token: token3 })
      const beforeRow = ((beforeStale.json?.services ?? []) as Array<{ name?: string; status?: string; freshness?: { status?: string } }>)
        .find((s) => s.name === 'Dashboard API')
      check(
        'observed service starts fresh (not unknown)',
        beforeRow?.freshness?.status === 'fresh' && beforeRow?.status !== 'unknown',
        JSON.stringify(beforeRow ?? {}),
      )

      // Absolute silence beyond the freshness threshold.
      await sleep(8_000)
      const afterStale = await req('GET', '/system/overview', { token: token3 })
      const staleRow = ((afterStale.json?.services ?? []) as Array<{ name?: string; status?: string; reason?: string; freshness?: { status?: string } }>)
        .find((s) => s.name === 'Dashboard API')
      check(
        'stale service reports Unknown / No Data',
        staleRow?.status === 'unknown',
        `status=${String(staleRow?.status)} reason=${String(staleRow?.reason)}`,
      )
      check('stale service reports freshness=stale', staleRow?.freshness?.status === 'stale', JSON.stringify(staleRow?.freshness ?? {}))
      check('stale state carries a staleness reason', (staleRow?.reason ?? '').includes('stale'), `reason=${String(staleRow?.reason)}`)

      // The persisted transition proves healthy → unknown was recorded once.
      const trans3 = await req('GET', '/system/transitions?range=24h', { token: token3 })
      const rows3 = (Array.isArray(trans3.json) ? trans3.json : []) as Array<{
        service?: string
        to?: string
        reason?: string
        at?: string
      }>
      check(
        'healthy → unknown transition recorded with staleness reason',
        rows3.some((t) => t.service === 'dashboard-api' && t.to === 'unknown' && (t.reason ?? '').includes('stale')),
        JSON.stringify(rows3.slice(0, 5)),
      )
      const uniqueTransitions = new Set(rows3.filter((t) => t.to === 'unknown').map((t) => `${t.service}:${t.to}:${(t.reason ?? '').slice(0, 10)}`))
      check(
        'ongoing stale condition does not duplicate transitions',
        uniqueTransitions.size === rows3.filter((t) => t.to === 'unknown').length,
        `unique=${uniqueTransitions.size} total=${rows3.filter((t) => t.to === 'unknown').length}`,
      )
    }
  }
  child3.kill('SIGTERM')
  await waitPortFree(PORT, 10_000)
}

/* --------------------------------- Main ----------------------------------- */

async function main(): Promise<void> {
  await unitChecks()
  await healthUnitChecks()
  await integrationChecks()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
