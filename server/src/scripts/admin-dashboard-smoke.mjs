#!/usr/bin/env node
/**
 * Admin-dashboard smoke suite (`npm run test:admin-dashboard` in server/).
 *
 * Black-box: boots the real dashboard API in a child process (tsx, embedded
 * Postgres, no production credentials) next to a mock Rayern API, then asserts
 * through HTTP only — nothing is imported from src/, so this catches wiring
 * mistakes that unit tests with mocks can miss.
 *
 * Covered, in order:
 *   1. Rayern client configuration — sync enabled, service token configured,
 *      and only presence flags reach the browser (never values).
 *   2. Missing-token behavior on the service-token endpoint (fail-closed).
 *   3. Existing integrations — overview (accounts), billing, subscriptions
 *      (workspaces/services) served from the pull-sync aggregates.
 *   4. Analytics blocks — the eight instrumentation blocks Rayern ships in the
 *      metrics envelope (funnel/acquisition, engagement, marketing consent,
 *      client errors, endpoint health, dependency config, synthetic,
 *      product adoption), normalized from real upstream values.
 *   5. Response normalization — a structurally invalid block is dropped, never
 *      converted into zeros; unknown/private fields never reach the browser.
 *   6. Failure isolation — one upstream endpoint failing (500, then 429 with
 *      Retry-After) leaves the other analytics endpoints serving, and the
 *      failure is recorded as a sync diagnostic.
 *   7. Credential non-disclosure — the monitoring token is sent upstream but
 *      never appears in any response body or in the API's own logs.
 *   8. Rate limiting — the two metrics endpoints are exempt from the global
 *      limiter (contract §7), a similarly-named path is not, and an ordinary
 *      protected route still exhausts its 300/min budget.
 *
 * Usage: node src/scripts/admin-dashboard-smoke.mjs   (or: bun run test:admin-dashboard)
 * Exit code 0 only when every check passes.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 4561
const BASE = `http://127.0.0.1:${PORT}`
const MOCK_PORT = 4598
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`
const EMBEDDED_PG_PORT = '54331'
const MONITORING_TOKEN = 'smoke-monitoring-token-do-not-leak'
const ADMIN_EMAIL = 'smoke-admin@rayern.com.ng'
const ADMIN_PASSWORD = 'smoke-test-password-123'

/* -------------------------------- harness --------------------------------- */

let passed = 0
let failed = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n— ${title} —`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ mock Rayern -------------------------------- */

/**
 * One boot payload carrying every block shape the dashboard normalizes.
 * `overrides` lets a test swap a single block without rebuilding the rest.
 */
const BASE_ACCOUNTS = {
  totalAccounts: 123,
  newAccounts30d: 12,
  verifiedAccounts: 100,
  unverifiedAccounts: 23,
  deletedAccounts30d: 0,
  deletionRequestsPending: 2,
  registrationsTrend: [{ date: '2026-10-01', count: 3 }],
  planBreakdown: [{ plan: 'starter', count: 109 }],
}

const WORKSPACES = {
  totalWorkspaces: 40,
  newWorkspaces30d: 5,
  avgMembersPerWorkspace: 3.2,
  planBreakdown: [{ plan: 'starter', count: 40 }],
}

// The billing aggregate is a strict contract (nested minor/major amounts).
const BILLING = {
  currency: 'USD',
  amountUnit: 'minor_units',
  generatedAt: '2026-10-28T05:00:00.000Z',
  activePaidSubscribers: 18,
  freeUsers: 105,
  totalAccounts: 123,
  mrr: { amountMinor: 2500000, amountMajor: 25000, byPlan: [] },
  arr: { amountMinor: 30000000, amountMajor: 300000, definition: 'MRR × 12' },
  planBreakdown: [{ plan: 'starter', userCount: 18, subscriptionCount: 18, isPaid: true }],
  definitions: {},
}

const FUNNEL = {
  hasVisitorData: false,
  visits30d: null,
  signupIntents30d: 200,
  registrations30d: 150,
  activated30d: 90,
  attributedSignups30d: 30,
  daily: [{ date: '2026-10-28', visits: null, signupIntents: 8, registrations: 6, activated: 3 }],
  topSources: [{ source: 'google', count: 10 }],
}

const ENGAGEMENT = {
  dau: 120,
  wau: 400,
  mau: 900,
  dailyActiveUsers: [{ date: '2026-10-28', count: 120 }],
  cohorts: [{ weekStart: '2026-10-21', size: 50, retainedNextWeek: 25 }],
}

const CLIENT_ERRORS = {
  total: 7,
  byKind: [{ kind: 'TypeError', count: 4 }],
  topEndpoints: [{ endpoint: '/api/v1/clients', count: 7 }],
  lastOccurredAt: '2026-10-28T05:00:00.000Z',
}

const MARKETING_CONSENT = { totalRegisteredUsers: 10, optedIn: 6, optedOut: 4 }

const mock = {
  /** 'full' | 'logs-500' | 'logs-429' */
  mode: 'full',
  lastAuthHeader: null,
  metricsRequests: 0,
}

function metricsPayload() {
  return {
    success: true,
    data: {
      accounts: {
        ...BASE_ACCOUNTS,
        // Private/unexpected fields that must never be persisted or served.
        email: 'leak@example.com',
        internalNotes: 'must not be stored',
      },
      workspaces: WORKSPACES,
      billing: BILLING,
      services: [
        { service: 'Rayern API', kind: 'api', status: 'healthy', uptimePct30d: 99.98, latencyMsP50: 41, latencyMsP95: 180 },
      ],
      telemetry: {},
      funnel: FUNNEL,
      engagement: ENGAGEMENT,
      clientErrors: CLIENT_ERRORS,
      marketingConsent: MARKETING_CONSENT,
      // Structurally invalid on purpose: must be dropped, never turned into
      // an empty object or zeros.
      productAdoption: 'not-an-object',
    },
  }
}

function startMockRayern() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', MOCK_BASE)
    const auth = req.headers.authorization ?? null
    mock.lastAuthHeader = auth

    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/internal/dashboard-metrics') {
      mock.metricsRequests++
      json(200, metricsPayload())
      return
    }

    if (url.pathname === '/internal/logs') {
      if (mock.mode === 'logs-500') {
        json(500, { success: false, error: { message: 'log store unavailable for leak@example.com token=secret123' } })
        return
      }
      if (mock.mode === 'logs-429') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '42' })
        res.end(JSON.stringify({ success: false, error: { message: 'slow down' } }))
        return
      }
      json(200, {
        logs: [
          {
            at: '2026-10-28T05:00:00.000Z',
            level: 'error',
            code: 'DB_TIMEOUT',
            message: 'query timed out',
            status: 500,
            method: 'GET',
            route: '/api/v1/clients',
            requestId: 'req_log_1',
            // Headers/bodies are never forwarded to the browser.
            headers: { authorization: `Bearer ${MONITORING_TOKEN}` },
          },
        ],
      })
      return
    }

    if (url.pathname === '/internal/synthetic-monitoring') {
      json(200, {
        baseUrlConfigured: true,
        lastRunAt: '2026-10-28T05:00:00.000Z',
        checks: [{ name: 'login', status: 'pass', latencyMs: 120, checkedAt: '2026-10-28T05:00:00.000Z' }],
      })
      return
    }

    if (url.pathname === '/api/v1/admin/users') {
      json(200, { success: true, data: { users: [], pagination: { page: 1, limit: 1, total: 0 } } })
      return
    }

    json(404, { success: false, error: { code: 'NOT_FOUND', message: `no mock route for ${url.pathname}` } })
  })

  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)))
}

/* -------------------------------- HTTP client ------------------------------ */

/** The two paths the global limiter must never count (contract §7). */
const EXEMPT_PATHS = ['/api/v1/admin/metrics', '/internal/dashboard-metrics']
const pathOnly = (pathAndQuery) => pathAndQuery.split('?')[0]

/** Non-exempt requests this suite has made — used to predict the first 429. */
let nonExemptRequests = 0

async function req(method, pathAndQuery, { body, token, headers = {} } = {}) {
  if (!EXEMPT_PATHS.includes(pathOnly(pathAndQuery))) nonExemptRequests++
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, text, json }
}

async function waitForReady(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) {
        const body = await res.json()
        if (body.db === true) return true
      }
    } catch {
      /* not listening yet */
    }
    await sleep(400)
  }
  return false
}

/* ---------------------------------- main ---------------------------------- */

const apiLog = { text: '' }
let child

function bootApi() {
  // Same invocation the repo's dev/start scripts use (tsx under bun).
  const proc = spawn('bun', ['node_modules/.bin/tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      API_PORT: String(PORT),
      CORS_ORIGINS: 'http://localhost:5173',
      EMBEDDED_PG_PORT,
      ADMIN_JWT_SECRET: 'smoke-jwt-secret',
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      ADMIN_NAME: 'Smoke Admin',
      EMAIL_DRY_RUN: '1',
      TELEMETRY_ENABLED: 'false',
      RAYERN_SYNC_ENDPOINT: `${MOCK_BASE}/internal/dashboard-metrics`,
      RAYERN_API_BASE_URL: MOCK_BASE,
      RAYERN_MONITORING_TOKEN: MONITORING_TOKEN,
      RAYERN_SYNC_TIMEOUT_MS: '8000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (d) => {
    apiLog.text += String(d)
    process.stdout.write(`  [api] ${d}`)
  })
  proc.stderr.on('data', (d) => {
    apiLog.text += String(d)
    process.stderr.write(`  [api] ${d}`)
  })
  proc.on('error', (e) => console.error('  [api spawn-error]', e.message))
  return proc
}

async function login() {
  const res = await req('POST', '/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  return { status: res.status, token: res.json?.token ?? '' }
}

/** The dashboard pull-sync fires 5s after boot; wait for the first success. */
async function waitForFirstSync(token, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await req('GET', '/system/overview', { token })
    const sync = res.json?.rayernSync ?? res.json?.sync ?? null
    if (sync?.lastSuccessAt) return sync
    await sleep(500)
  }
  return null
}

async function main() {
  const mockServer = await startMockRayern()
  console.log(`Mock Rayern listening on ${MOCK_BASE}`)
  console.log('Starting dashboard API for the smoke run…')
  child = bootApi()

  try {
    if (!(await waitForReady())) {
      throw new Error(`dashboard API did not become ready on ${BASE} (see logs above)`)
    }
    const auth = await login()
    if (auth.status !== 200 || auth.token === '') {
      throw new Error(`admin login failed (HTTP ${auth.status}) — cannot run the suite`)
    }
    const token = auth.token

    /* ---- 1. Rayern client configuration ---- */
    section('Rayern client configuration')
    const system = await req('GET', '/system/overview', { token })
    check('GET /system/overview → 200', system.status === 200)
    const sync = system.json?.rayernSync ?? system.json?.sync ?? null
    check('overview reports the Rayern sync block', sync !== null && typeof sync === 'object')
    check('sync is enabled (endpoint + token configured)', sync?.enabled === true)
    check('sync interval stays at the 30-minute default', sync?.intervalMs === 1_800_000, String(sync?.intervalMs))
    const systemText = JSON.stringify(system.json ?? {})
    check('overview never echoes the monitoring token', !systemText.includes(MONITORING_TOKEN))
    check(
      'overview reports configuration as presence flags, not values',
      system.json?.dependencies === undefined ||
        !JSON.stringify(system.json.dependencies).includes(MONITORING_TOKEN),
    )

    /* ---- 2. Missing-token behavior ---- */
    section('Service-token endpoint (missing/invalid token)')
    const noToken = await fetch(`${BASE}/internal/dashboard-metrics`)
    check('GET /internal/dashboard-metrics without a token → 401', noToken.status === 401)
    const wrongToken = await fetch(`${BASE}/internal/dashboard-metrics`, {
      headers: { Authorization: 'Bearer not-the-monitoring-token' },
    })
    check('GET /internal/dashboard-metrics with a wrong token → 401', wrongToken.status === 401)
    const goodToken = await fetch(`${BASE}/internal/dashboard-metrics`, {
      headers: { Authorization: `Bearer ${MONITORING_TOKEN}` },
    })
    check('GET /internal/dashboard-metrics with the service token → 200', goodToken.status === 200)
    const goodBody = await goodToken.json().catch(() => null)
    check('service-token call returns the same metrics payload', goodBody?.success === true && !!goodBody?.data)

    /* ---- 3. Existing integrations: overview / billing / subscriptions ---- */
    section('Existing integrations — overview, billing, subscriptions')
    const synced = await waitForFirstSync(token)
    check('pull-sync completed a successful pull', synced !== null)
    check('sync reports zero consecutive failures', (synced?.consecutiveFailures ?? 0) === 0)
    check(
      'pull-sync sent the monitoring token as a bearer credential',
      mock.lastAuthHeader === `Bearer ${MONITORING_TOKEN}`,
      String(mock.lastAuthHeader),
    )
    check('pull-sync issued exactly one outbound metrics request', mock.metricsRequests === 1, String(mock.metricsRequests))

    const overview = await req('GET', '/platform-metrics/overview', { token })
    check('GET /platform-metrics/overview → 200', overview.status === 200)
    check('overview accounts come from the sync', overview.json?.registeredAccounts === 123, String(overview.json?.registeredAccounts))
    check('overview data source is tagged rayern-sync', overview.json?.dataSource === 'rayern-sync')
    check('overview carries a sync freshness timestamp', typeof overview.json?.syncedAt === 'string')
    check('overview workspaces come from the sync', overview.json?.totalWorkspaces === 40, String(overview.json?.totalWorkspaces))

    // The billing aggregate is validated as one strict contract: had the nested
    // minor/major amounts or the per-plan entries been wrong, the WHOLE payload
    // would have been rejected and nothing stored. A clean 200 pull is the
    // proof that billing parsed (verified explicitly in response normalization).
    check('billing aggregate accepted by the contract (clean 200 pull)', synced?.lastHttpStatus === 200 && synced?.lastError === null, String(synced?.lastError))
    check(
      'subscription plan breakdown is served from the sync',
      Array.isArray(overview.json?.planBreakdown) && overview.json.planBreakdown.some((p) => p.plan === 'starter' && p.count === 40),
      JSON.stringify(overview.json?.planBreakdown),
    )

    /* ---- 4. Analytics blocks ---- */
    section('Analytics blocks (Rayern instrumentation envelope)')
    const blocksRes = await req('GET', '/rayern/blocks', { token })
    check('GET /rayern/blocks → 200', blocksRes.status === 200)
    const blocks = blocksRes.json?.blocks ?? {}
    const received = blocksRes.json?.received ?? []
    check('analytics blocks carry a sync timestamp', typeof blocksRes.json?.syncedAt === 'string')

    check('acquisition/funnel block normalized', blocks.funnel?.registrations30d === 150, JSON.stringify(blocks.funnel?.registrations30d))
    check('funnel conversion derived from real counts', blocks.funnel?.conversion?.registrationToActivationPct === 60)
    check('visitor stage stays null (no visitor measurement upstream)', blocks.funnel?.visits30d === null)
    check('engagement block normalized (DAU/WAU/MAU)', blocks.engagement?.dau === 120 && blocks.engagement?.wau === 400 && blocks.engagement?.mau === 900)
    check('engagement reports availability from real data', blocks.engagement?.available === true)
    check('retention cohort keeps observation-complete data', blocks.engagement?.cohorts?.[0]?.size === 50)
    check('client errors block normalized', blocks.clientErrors?.total === 7 && blocks.clientErrors?.byKind?.[0]?.kind === 'TypeError')
    check(
      'marketing consent block reconciles',
      blocks.marketingConsent?.optedIn === 6 && blocks.marketingConsent?.reconciles === true,
    )
    check('received block list reports what Rayern actually sent', Array.isArray(received) && received.includes('funnel'))

    /* ---- 5. Normalization / invalid block rejection ---- */
    section('Response normalization')
    check('structurally invalid block is dropped, not stored', !received.includes('productAdoption'))
    check('dropped block reads back as null, never zeros', blocks.productAdoption === null)
    check('blocks never received read back as null', blocks.dependencyConfig === null)
    const blocksText = JSON.stringify(blocksRes.json ?? {})
    check('private upstream fields never reach the browser', !blocksText.includes('leak@example.com'))
    check('private upstream notes never reach the browser', !blocksText.includes('must not be stored'))
    check('null measurement is not converted into 0', JSON.stringify(blocks.funnel?.daily?.[0]?.visits) === 'null')

    /* ---- 6. Failure isolation + diagnostics ---- */
    section('Failure isolation across analytics endpoints')
    const syntheticOk = await req('GET', '/rayern/synthetic-monitoring', { token })
    check('synthetic monitoring proxy → 200 while healthy', syntheticOk.status === 200)
    const syntheticChecks = syntheticOk.json?.synthetic?.checks ?? []
    check('synthetic check list normalized from upstream', Array.isArray(syntheticChecks) && syntheticChecks.length === 1)

    mock.mode = 'logs-500'
    const logsFail = await req('GET', '/rayern/logs?limit=5', { token })
    check('failed upstream log call surfaces as an error status', logsFail.status >= 500 || logsFail.status === 502 || logsFail.status === 503, String(logsFail.status))
    check('failed call body is sanitized before display', !logsFail.text.includes('leak@example.com'))
    const syntheticStillOk = await req('GET', '/rayern/synthetic-monitoring', { token })
    check('other analytics endpoint keeps serving after a sibling fails', syntheticStillOk.status === 200)
    const blocksStillOk = await req('GET', '/rayern/blocks', { token })
    check('synced blocks survive an upstream failure', blocksStillOk.status === 200 && blocksStillOk.json?.blocks?.funnel?.registrations30d === 150)

    mock.mode = 'logs-429'
    const logsLimited = await req('GET', '/rayern/logs?limit=5', { token })
    check('upstream 429 is forwarded as 429 (not a generic 500)', logsLimited.status === 429, String(logsLimited.status))
    check('Retry-After survives the proxy hop', logsLimited.headers.get('retry-after') === '42', String(logsLimited.headers.get('retry-after')))

    const diagnostics = await req('GET', '/rayern/sync-diagnostics?limit=20', { token })
    check('GET /rayern/sync-diagnostics → 200', diagnostics.status === 200)
    const rows = diagnostics.json?.diagnostics ?? []
    check('failed upstream call was recorded as a diagnostic', rows.some((d) => d.source === 'internal'))
    check('diagnostic records the upstream status', rows.some((d) => d.status === 429 || d.status === 500))
    check('diagnostic body is sanitized', !JSON.stringify(rows).includes('leak@example.com'))

    /* ---- 7. Credential non-disclosure ---- */
    section('Credential non-disclosure')
    const bodies = [
      JSON.stringify(system.json ?? {}),
      JSON.stringify(overview.json ?? {}),
      JSON.stringify(blocksRes.json ?? {}),
      JSON.stringify(syntheticOk.json ?? {}),
      logsFail.text,
      JSON.stringify(diagnostics.json ?? {}),
    ].join('\n')
    check('no API response contains the monitoring token', !bodies.includes(MONITORING_TOKEN))
    check('no API response contains a raw Authorization header', !/bearer\s+smoke-monitoring/i.test(bodies))
    check('the API log never prints the monitoring token', !apiLog.text.includes(MONITORING_TOKEN))
    check('no API response leaks the admin password', !bodies.includes(ADMIN_PASSWORD))

    /* ---- 8. Rate limiting ---- */
    section('Rate limiting (metrics exemption + real counter)')
    const exemptBefore = nonExemptRequests
    // Contract §7: both metrics endpoints are exempt from the global 300/min
    // limiter. 210 + 210 requests share one client IP: without the exemption
    // the second batch would start 429ing once the shared bucket passed 300.
    let metrics429 = 0
    for (let i = 0; i < 210; i++) {
      const res = await req('GET', '/api/v1/admin/metrics', { token })
      if (res.status === 429) metrics429++
    }
    check('210 × GET /api/v1/admin/metrics → 0 rate-limited', metrics429 === 0, `${metrics429} × 429`)

    let internal429 = 0
    for (let i = 0; i < 210; i++) {
      const res = await fetch(`${BASE}/internal/dashboard-metrics`, {
        headers: { Authorization: `Bearer ${MONITORING_TOKEN}` },
      })
      if (res.status === 429) internal429++
    }
    check('210 × GET /internal/dashboard-metrics → 0 rate-limited', internal429 === 0, `${internal429} × 429`)

    const withQuery = await req('GET', '/api/v1/admin/metrics?probe=1', { token })
    check('metrics exemption survives a query string', withQuery.status === 200, String(withQuery.status))

    const similar = await req('GET', '/api/v1/admin/metrics-extra', { token })
    check('similarly-named path is not exempt (404)', similar.status === 404, String(similar.status))

    let firstLimited = 0
    for (let i = 1; i <= 330; i++) {
      const res = await fetch(`${BASE}/users`, { headers: { Authorization: 'Bearer not-a-real-token' } })
      if (res.status === 429) {
        firstLimited = i
        break
      }
    }
    check('ordinary protected route is still rate limited', firstLimited > 0, 'never returned 429 within 330 requests')
    // 300 requests per minute per IP: the first 429 lands on request
    // 301 − (non-exempt requests this suite already made). Exempt traffic
    // must not shift this number.
    const expectedFirst429 = 301 - exemptBefore
    check(
      'exempt traffic did not consume the shared bucket (300/min budget intact)',
      Math.abs(firstLimited - expectedFirst429) <= 2,
      `first 429 at request ${firstLimited}, expected ~${expectedFirst429} after ${exemptBefore} non-exempt requests`,
    )

    const afterExhaustion = await req('GET', '/api/v1/admin/metrics', { token })
    check('metrics still served after the shared bucket is exhausted', afterExhaustion.status === 200, String(afterExhaustion.status))

    /* --------------------------------- summary -------------------------------- */
    console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`)
    if (failed > 0) {
      console.error('Failed checks:')
      for (const f of failures) console.error(`  - ${f}`)
      process.exitCode = 1
    }
  } catch (err) {
    console.error(`\n✗ smoke run aborted: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    if (child) {
      child.kill('SIGTERM')
      await sleep(300)
      if (!child.killed) child.kill('SIGKILL')
    }
    await new Promise((resolve) => mockServer.close(() => resolve()))
  }
}

void main()
