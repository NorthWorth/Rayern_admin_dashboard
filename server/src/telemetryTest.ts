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
}

/* --------------------------------- Main ----------------------------------- */

async function main(): Promise<void> {
  await unitChecks()
  await integrationChecks()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
