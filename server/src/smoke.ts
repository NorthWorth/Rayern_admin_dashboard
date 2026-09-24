/**
 * Integration smoke test for the dashboard API (pull-based Rayern sync).
 *
 * Boots the standalone backend IN-PROCESS exactly as production would (set env
 * first, then import index.ts) alongside a mock Rayern API, then verifies:
 *   - health, auth (bad + good credentials, JWT issuance)
 *   - authorization (401 without/garbage token)
 *   - all dashboard endpoints and their response shapes
 *   - dashboard-side pull-sync worker:
 *       * dashboard GETs Rayern with the monitoring token (Rayern never pushes)
 *       * successful pull stores approved aggregates (served by platform-metrics)
 *       * privacy boundary: unexpected/private fields are stripped, wrong types rejected
 *       * Rayern auth failure / HTTP 429 rate limit (Retry-After respected) /
 *         slow responses / malformed or empty payloads → failure recorded,
 *         dashboard survives, previously synchronized data retained, automatic
 *         recovery; nullable untracked metrics (deletedAccounts30d: null) and
 *         the 'starter' plan tier accepted by the contract
 *   - emails: validation, server-enforced From, cross-field dedup, dry-run,
 *     history without bodies, copy-body endpoint, audience endpoint,
 *     the full To/CC/BCC recipient-combination matrix (send allowed when ANY
 *     field is non-empty; all-empty rejected), BCC-only payload integrity
 *     (empty `to`, no fabricated recipient), Plain Text/HTML bodyMode flow
 *     (right Resend field, sanitized stored HTML, mode preserved by
 *     copy-as-new), compact audit metadata (counts, never address lists),
 *     and the sync startup log / 30-minute default interval
 *   - the old push endpoint /sync/rayern is gone
 *
 * Usage: bun run src/smoke.ts
 */
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* --------------- Environment inherited by the API child process ------------ */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 4557
const BASE = `http://127.0.0.1:${PORT}`
const RAYERN_MOCK_PORT = 4599
const RAYERN_MOCK_URL = `http://127.0.0.1:${RAYERN_MOCK_PORT}/internal/dashboard-metrics`

const SYNC_INTERVAL_MS = 4000
const SYNC_TIMEOUT_MS = 3000

const CHILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(PORT),
  API_PORT: String(PORT),
  CORS_ORIGINS: 'http://localhost:5173',
  EMBEDDED_PG_PORT: '54330',
  ADMIN_JWT_SECRET: 'smoke-jwt-secret',
  EMAIL_DRY_RUN: '1',
  ADMIN_EMAIL: 'smoke-admin@rayern.com.ng',
  ADMIN_PASSWORD: 'smoke-test-password-123',
  ADMIN_NAME: 'Smoke Admin',
  // Pull-sync worker pointed at the mock Rayern:
  RAYERN_SYNC_ENDPOINT: RAYERN_MOCK_URL,
  RAYERN_MONITORING_TOKEN: 'smoke-monitoring-token',
  RAYERN_SYNC_INTERVAL_MS: String(SYNC_INTERVAL_MS),
  RAYERN_SYNC_TIMEOUT_MS: String(SYNC_TIMEOUT_MS),
  // History rollups run inside the (default 10s) flush — speed up their
  // throttle so the smoke run observes service_history buckets being written.
  TELEMETRY_HISTORY_ROLLUP_MS: '2000',
  // Quota limits sized for the smoke run: the 120-recipient batch-split send
  // must fit (tests splitting), while the 500-recipient attempt must not
  // (tests quota rejection). Default production values stay 3000/100.
  RESEND_MONTHLY_EMAIL_LIMIT: '3000',
  RESEND_DAILY_EMAIL_LIMIT: '200',
  // No RESEND_API_KEY → email send uses the no-op dry-run transport.
  // No DATABASE_URL → embedded Postgres (PGlite) is used.
}

/* ------------------------------- Test harness ------------------------------ */

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
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${reqPath}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Server at ${url} did not become ready in time`)
}

/** Best-effort wait: ensures no stale process holds a port before boot. */
async function waitPortFree(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const busy = await new Promise<boolean>((resolve) => {
      const s = new net.Socket()
      s.setTimeout(800)
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      const fail = (): void => {
        s.destroy()
        resolve(false)
      }
      s.once('error', fail)
      s.once('timeout', fail)
      s.connect(port, '127.0.0.1')
    })
    if (!busy) return
    console.log(`  [smoke] waiting for port ${port} to free up…`)
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn(`  [smoke] port ${port} still busy — continuing anyway`)
}

/* ----------------------------- Mock Rayern API ----------------------------- */

interface MockRayern {
  server: Server
  setPayload: (payload: unknown) => void
  setUnauthorized: (v: boolean) => void
  setRateLimited: (v: boolean, retryAfterSec?: number) => void
  setDelayMs: (ms: number) => void
  requestCount: () => number
  lastAuthHeader: () => string | null
}

function startMockRayern(): Promise<MockRayern> {
  let payload: unknown = { ok: true }
  let unauthorized = false
  let rateLimited = false
  let retryAfterSec: number | null = null
  let delayMs = 0
  let count = 0
  let lastAuth: string | null = null

  const server = createServer((req, res) => {
    count++
    lastAuth = req.headers.authorization ?? null
    if (rateLimited) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        ...(retryAfterSec !== null ? { 'Retry-After': String(retryAfterSec) } : {}),
      })
      res.end(JSON.stringify({ error: 'too many requests' }))
      return
    }
    if (unauthorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid monitoring token' }))
      return
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }, delayMs)
  })

  return new Promise((resolve) => {
    server.listen(RAYERN_MOCK_PORT, '127.0.0.1', () => {
      resolve({
        server,
        setPayload: (p) => (payload = p),
        setUnauthorized: (v) => (unauthorized = v),
        setRateLimited: (v, secs) => {
          rateLimited = v
          retryAfterSec = secs ?? null
        },
        setDelayMs: (ms) => (delayMs = ms),
        requestCount: () => count,
        lastAuthHeader: () => lastAuth,
      })
    })
  })
}

const GOOD_AGGREGATES = {
  accounts: {
    totalAccounts: 1234,
    newAccounts30d: 42,
    verifiedAccounts: 1100,
    unverifiedAccounts: 134,
    // Rayern does not track these yet and reports null (documented contract).
    deletedAccounts30d: null,
    deletionRequestsPending: null,
    registrationsTrend: [
      { date: '2026-09-19', count: 10 },
      { date: '2026-09-20', count: 12 },
      { date: '2026-09-21', count: 8 },
    ],
    planBreakdown: [
      { plan: 'free', count: 900 },
      { plan: 'pro', count: 250 },
      { plan: 'team', count: 84 },
    ],
  },
  workspaces: {
    totalWorkspaces: 87,
    newWorkspaces30d: 5,
    avgMembersPerWorkspace: 3.2,
    // Rayern's actual plan tier — must be accepted by the contract.
    planBreakdown: [{ plan: 'starter', count: 87 }],
  },
  services: [
    { service: 'Rayern API', kind: 'api', status: 'healthy', uptimePct30d: 99.98, latencyMsP50: 41, latencyMsP95: 180, lastIncidentAt: null },
  ],
}

/* ---------------------------------- Main ----------------------------------- */

async function main(): Promise<void> {
  const rayern = await startMockRayern()
  console.log('Starting dashboard API for smoke test…')

  /** Buffered API output — used to verify the sync startup log format. */
  const apiLog = { text: '' }

  const bootApi = (): ChildProcess => {
    // Use the same tsx-under-bun invocation the preview/dev scripts use —
    // spawning `bun run` recursively is unreliable in constrained sandboxes.
    const child = spawn('bun', ['node_modules/.bin/tsx', 'src/index.ts'], {
      cwd: path.resolve(__dirname, '..'),
      env: CHILD_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => {
      apiLog.text += String(d)
      process.stdout.write(`  [api] ${d}`)
    })
    child.stderr.on('data', (d) => {
      apiLog.text += String(d)
      process.stderr.write(`  [api] ${d}`)
    })
    child.on('error', (e) => console.error('  [api spawn-error]', e.message))
    return child
  }

  let child = bootApi()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const syncStatus = async (token: string): Promise<{
    lastAttemptAt: string | null
    lastSuccessAt: string | null
    lastFailureAt: string | null
    consecutiveFailures: number
    status: string
    lastError: string | null
    lastDurationMs: number | null
    lastHttpStatus: number | null
    dataUpdatedAt: string | null
    rateLimitedUntil: string | null
    intervalMs: number
  }> => {
    const res = await req('GET', '/system/overview', undefined, token)
    return ((res.json as { sync?: object }).sync ?? {}) as never
  }

  /**
   * Waits until the mock has received at least n requests AND the worker's
   * attempt timestamp has advanced (i.e. the nth request has been processed).
   */
  const awaitTick = async (n: number, token: string): Promise<void> => {
    const deadline = Date.now() + SYNC_INTERVAL_MS * 4
    while (Date.now() < deadline && rayern.requestCount() < n) await sleep(150)
    const baseline = (await syncStatus(token)).lastAttemptAt
    const waitUntil = Date.now() + SYNC_INTERVAL_MS * 2
    while (Date.now() < waitUntil) {
      const st = await syncStatus(token)
      if (st.lastAttemptAt && st.lastAttemptAt !== baseline) {
        // Give the worker a moment to finish the storage writes that follow.
        await sleep(800)
        return
      }
      await sleep(200)
    }
    await sleep(800)
  }

  try {
    await waitPortFree(PORT)
    await waitPortFree(Number(CHILD_ENV.EMBEDDED_PG_PORT))
    try {
      // Cold bun + PGlite WASM compile can be slow on constrained runners.
      await waitForServer(BASE + '/healthz', 45_000)
    } catch {
      // One retry: occasionally the sandbox fails to spawn the child.
      console.log('  [smoke] first boot attempt failed — retrying')
      child.kill('SIGKILL')
      await sleep(1500)
      await waitPortFree(PORT)
      await waitPortFree(Number(CHILD_ENV.EMBEDDED_PG_PORT))
      child = bootApi()
      await waitForServer(BASE + '/healthz', 60_000)
    }

    console.log('\n— health & auth —')
    const health = await req('GET', '/healthz')
    check('GET /healthz → 200', health.status === 200)
    check('health reports db ready', (health.json as { db?: boolean })?.db === true)

    const badLogin = await req('POST', '/auth/login', { email: 'smoke-admin@rayern.com.ng', password: 'wrong' })
    check('login with wrong password → 401', badLogin.status === 401)

    const login = await req('POST', '/auth/login', {
      email: 'smoke-admin@rayern.com.ng',
      password: 'smoke-test-password-123',
    })
    check('login with correct credentials → 200', login.status === 200)
    const token = (login.json as { token?: string })?.token ?? ''
    check('login returns JWT', token.split('.').length === 3)
    const operator = (login.json as { operator?: { email?: string } })?.operator
    check('login returns operator', operator?.email === 'smoke-admin@rayern.com.ng')

    console.log('\n— authorization —')
    const unauthorizedUsers = await req('GET', '/users')
    check('GET /users without token → 401', unauthorizedUsers.status === 401)
    const badToken = await req('GET', '/users', undefined, 'not-a-jwt')
    check('GET /users with garbage token → 401', badToken.status === 401)

    console.log('\n— data endpoints —')
    const users = await req('GET', '/users?page=1&pageSize=10', undefined, token)
    check('GET /users → 200 paged shape', users.status === 200 && Array.isArray((users.json as { items?: unknown[] })?.items))
    const userStats = await req('GET', '/users/stats', undefined, token)
    check('GET /users/stats → 200 stats shape', userStats.status === 200 && 'totalUsers' in (userStats.json as object))

    const workspaces = await req('GET', '/workspaces', undefined, token)
    check('GET /workspaces → 200 paged shape', workspaces.status === 200 && Array.isArray((workspaces.json as { items?: unknown[] })?.items))
    const wsStats = await req('GET', '/workspaces/stats', undefined, token)
    check('GET /workspaces/stats → 200', wsStats.status === 200 && 'total' in (wsStats.json as object))

    const system = await req('GET', '/system/overview', undefined, token)
    check('GET /system/overview → 200', system.status === 200 && 'overall' in (system.json as object))
    const sysShape = system.json as {
      overall?: string
      services?: Array<{ status?: string; freshness?: { status?: string }; historyKey?: string | null }>
      dependencies?: Array<{ id?: string; status?: string; historyKey?: string | null }>
      meta?: { pool?: { total?: number }; healthThresholds?: { errorRateFailingPct?: number } }
    }
    check(
      'overall uses the four-state health model',
      ['healthy', 'degraded', 'failing', 'unknown'].includes(sysShape.overall ?? ''),
      `overall=${sysShape.overall ?? 'missing'}`,
    )
    check(
      'service rows carry four-state status + freshness',
      (sysShape.services ?? []).length > 0 &&
        (sysShape.services ?? []).every(
          (s) => ['healthy', 'degraded', 'failing', 'unknown'].includes(s.status ?? '') &&
            ['fresh', 'stale', 'none'].includes(s.freshness?.status ?? ''),
        ),
      JSON.stringify((sysShape.services ?? []).map((s) => `${s.status}/${s.freshness?.status}`)),
    )
    check(
      'real dependencies exposed (postgresql, rayern metrics, resend)',
      ['dep:postgresql', 'dep:rayern-metrics', 'dep:resend'].every((id) =>
        (sysShape.dependencies ?? []).some((d) => d.id === id),
      ),
      JSON.stringify((sysShape.dependencies ?? []).map((d) => d.id)),
    )
    check(
      'runtime meta exposes pool pressure + thresholds',
      typeof sysShape.meta?.pool?.total === 'number' &&
        typeof sysShape.meta?.healthThresholds?.errorRateFailingPct === 'number',
      JSON.stringify(sysShape.meta ?? {}),
    )
    const historyApi = await req('GET', '/system/history?service=dashboard-api&range=24h', undefined, token)
    check(
      'GET /system/history → 200 bucket series',
      historyApi.status === 200 &&
        Array.isArray((historyApi.json as { points?: unknown[] })?.points) &&
        ((historyApi.json as { points?: unknown[] }).points?.length ?? 0) >= 24,
      `points=${(historyApi.json as { points?: unknown[] })?.points?.length}`,
    )
    const historyBad = await req('GET', '/system/history?service=bad;DROP&range=24h', undefined, token)
    check('history rejects invalid service key → 400/404', historyBad.status >= 400 && historyBad.status < 500, `got ${historyBad.status}`)
    const trans = await req('GET', '/system/transitions?range=24h', undefined, token)
    check('GET /system/transitions → 200 array', trans.status === 200 && Array.isArray(trans.json))
    const errorsList = await req('GET', '/errors', undefined, token)
    check('GET /errors → 200 array', errorsList.status === 200 && Array.isArray(errorsList.json))
    const obs = await req('GET', '/observability/overview', undefined, token)
    check('GET /observability/overview → 200', obs.status === 200 && 'services' in (obs.json as object))
    const auditList = await req('GET', '/audit', undefined, token)
    check('GET /audit → 200 array', auditList.status === 200 && Array.isArray(auditList.json))

    console.log('\n— pull-sync: first cycle (default empty payload) —')
    await awaitTick(1, token)
    check('dashboard GETs Rayern (pull, not push)', rayern.requestCount() >= 1)
    check('dashboard sends the monitoring token to Rayern', rayern.lastAuthHeader() === 'Bearer smoke-monitoring-token')
    const sync0 = await syncStatus(token)
    check('sync enabled and attempt recorded', sync0.lastAttemptAt !== null)

    console.log('\n— pull-sync: successful aggregate cycle —')
    rayern.setPayload(GOOD_AGGREGATES)
    await awaitTick(2, token)

    const metrics2 = await req('GET', '/platform-metrics/overview', undefined, token)
    const m2 = metrics2.json as Record<string, unknown>
    check('synced aggregates served by platform-metrics', m2.dataSource === 'rayern-sync' && m2.registeredAccounts === 1234)
    check('registrationsTrend preserved from sync', Array.isArray(m2.registrationsTrend) && (m2.registrationsTrend as unknown[]).length === 3)
    check('workspace aggregate served', m2.totalWorkspaces === 87)
    check(
      'nullable untracked metrics normalized to 0 (not null, not missing)',
      m2.deletedAccounts30d === 0 && m2.deletionRequestsPending === 0,
      `deleted=${String(m2.deletedAccounts30d)} pending=${String(m2.deletionRequestsPending)}`,
    )
    check(
      'starter plan tier accepted from Rayern',
      Array.isArray(m2.planBreakdown) && (m2.planBreakdown as Array<{ plan?: string }>).some((p) => p.plan === 'starter'),
    )
    const usSynced = (await req('GET', '/users/stats', undefined, token)).json as {
      totalUsers?: number
      deleted30d?: number
    }
    check('users/stats serves synced aggregates', usSynced.totalUsers === 1234 && usSynced.deleted30d === 0, `totalUsers=${String(usSynced.totalUsers)}`)
    const wsSynced = (await req('GET', '/workspaces/stats', undefined, token)).json as { total?: number }
    check('workspaces/stats serves synced aggregates', wsSynced.total === 87, `total=${String(wsSynced.total)}`)

    const sys2j = (await req('GET', '/system/overview', undefined, token)).json as {
      sync?: {
        status?: string
        lastSuccessAt?: string | null
        lastDurationMs?: number | null
        lastHttpStatus?: number | null
        dataUpdatedAt?: string | null
        rateLimitedUntil?: string | null
        intervalMs?: number
      }
      services?: Array<{ name?: string }>
    }
    check('system reports sync healthy after success', sys2j.sync?.status === 'healthy' && !!sys2j.sync?.lastSuccessAt)
    check('sync exposes pull duration', typeof sys2j.sync?.lastDurationMs === 'number', `dur=${String(sys2j.sync?.lastDurationMs)}`)
    check('sync exposes last HTTP status (200)', sys2j.sync?.lastHttpStatus === 200, `http=${String(sys2j.sync?.lastHttpStatus)}`)
    check('sync exposes stored-data timestamp', typeof sys2j.sync?.dataUpdatedAt === 'string', `data=${String(sys2j.sync?.dataUpdatedAt)}`)
    check('sync exposes configured interval', typeof sys2j.sync?.intervalMs === 'number')
    check('sync exposes no active rate-limit window', sys2j.sync?.rateLimitedUntil === null || sys2j.sync?.rateLimitedUntil === undefined, `rl=${String(sys2j.sync?.rateLimitedUntil)}`)
    check('Rayern service health visible in system services', (sys2j.services ?? []).some((s) => s.name === 'Rayern API'))

    console.log('\n— pull-sync: privacy boundary —')
    rayern.setPayload({
      accounts: {
        totalAccounts: 10,
        clients: [{ name: 'Acme Corp', contact: 'ceo@acme.com' }],
        projects: [{ title: 'Secret project' }],
        activity: [{ user: 'u1', action: 'opened document' }],
      },
    })
    await awaitTick(3, token)
    const metrics3 = await req('GET', '/platform-metrics/overview', undefined, token)
    const m3 = metrics3.json as Record<string, unknown>
    check('valid aggregate fields still accepted', m3.dataSource === 'rayern-sync' && m3.registeredAccounts === 10)
    const metricsStr = JSON.stringify(metrics3.json)
    check('private fields never stored (no clients/projects/activity anywhere)', !metricsStr.includes('Acme') && !metricsStr.includes('Secret project') && !metricsStr.includes('u1'))

    // Direct contract checks (no extra sync cycle needed).
    const { SyncPayload, unwrapRayernEnvelope } = await import('./rayernSync')
    check('invalid aggregate types rejected', SyncPayload.safeParse({ accounts: { totalAccounts: 'not-a-number' } }).success === false)

    const nullableRun = SyncPayload.safeParse({
      accounts: { totalAccounts: 61, deletedAccounts30d: null, deletionRequestsPending: null },
    })
    check(
      'nullable untracked metrics accepted and normalized (production contract)',
      nullableRun.success &&
        nullableRun.data.accounts?.deletedAccounts30d === 0 &&
        nullableRun.data.accounts?.deletionRequestsPending === 0,
      nullableRun.success ? '' : `issues=${nullableRun.error.issues.map((i) => i.path.join('.')).join(',')}`,
    )
    check(
      'wrong-typed untracked metrics still rejected',
      SyncPayload.safeParse({ accounts: { totalAccounts: 1, deletionRequestsPending: 'pending' } }).success === false &&
        SyncPayload.safeParse({ accounts: { totalAccounts: 1, deletedAccounts30d: -5 } }).success === false &&
        SyncPayload.safeParse({ accounts: { totalAccounts: 1, newAccounts30d: '42' } }).success === false,
    )
    check('null core total rejected (counts must never be invented)', SyncPayload.safeParse({ accounts: { totalAccounts: null } }).success === false)
    const nullSections = SyncPayload.safeParse({ accounts: { totalAccounts: 1 }, workspaces: null, services: null })
    check(
      'null sections treated as absent (previous copy kept)',
      nullSections.success && nullSections.data.workspaces === undefined && nullSections.data.services === undefined,
    )
    const emptyContainer = SyncPayload.safeParse({})
    check(
      'empty container parses to zero sections (worker rejects it)',
      emptyContainer.success && emptyContainer.data.accounts === undefined && emptyContainer.data.workspaces === undefined,
    )
    check('success=false envelope treated as failure', unwrapRayernEnvelope({ success: false, error: {} }).ok === false)
    const strippedRun = SyncPayload.safeParse({ accounts: { totalAccounts: 1, secretClientEmail: 'x@y.z' } })
    check('unknown/private fields stripped (privacy)', strippedRun.success && !('secretClientEmail' in (strippedRun.data.accounts ?? {})))

    console.log('\n— pull-sync: Rayern auth failure (dashboard survives, data retained) —')
    rayern.setUnauthorized(true)
    // Wait for TWO failed cycles: the first registers the failure, the second
    // confirms the consecutive-failure counter and retention assertions.
    await awaitTick(4, token)
    await awaitTick(5, token)
    await awaitTick(6, token)
    const sync4 = await syncStatus(token)
    check('sync status turns failing with error info', sync4.status === 'failing' && sync4.consecutiveFailures >= 1 && !!sync4.lastError)
    check('401 exposed as last HTTP status', sync4.lastHttpStatus === 401, `http=${String(sync4.lastHttpStatus)}`)
    const metrics4 = await req('GET', '/platform-metrics/overview', undefined, token)
    check('previously synchronized data retained during outage', (metrics4.json as { registeredAccounts?: number })?.registeredAccounts === 10)
    const errors4 = await req('GET', '/errors', undefined, token)
    check('sync failure recorded as operational error', (errors4.json as Array<{ service?: string }>).some((e) => e.service === 'Rayern Sync'))

    console.log('\n— pull-sync: slow Rayern triggers timeout guard —')
    rayern.setUnauthorized(false)
    rayern.setDelayMs(SYNC_TIMEOUT_MS + 2000)
    await awaitTick(7, token)
    const sync5 = await syncStatus(token)
    check('hanging Rayern aborted with timeout error', (sync5.lastError ?? '').includes('timed out'))
    rayern.setDelayMs(0)

    console.log('\n— pull-sync: envelope-wrapped success payload (Rayern { success, data } convention) —')
    // The production Rayern API wraps responses in an envelope:
    // { success: true, data: { accounts…, workspaces… } }.
    rayern.setPayload({ success: true, data: GOOD_AGGREGATES })
    await awaitTick(8, token)
    const metrics7 = await req('GET', '/platform-metrics/overview', undefined, token)
    const m7 = metrics7.json as Record<string, unknown>
    check('envelope data unwrapped and stored', m7.dataSource === 'rayern-sync' && m7.registeredAccounts === 1234)
    check('envelope workspaces aggregate served', m7.totalWorkspaces === 87)
    const syncEnv = await syncStatus(token)
    check('envelope cycle marked success', syncEnv.status === 'healthy' && syncEnv.consecutiveFailures === 0)

    console.log('\n— pull-sync: envelope failure (success=false) —')
    rayern.setPayload({ success: false, error: { code: 'INTERNAL', message: 'simulated Rayern failure' } })
    // The worker's interval is clamped in config to a 30s minimum, so a fixed
    // tick window can read state from the previous (successful) cycle. Poll
    // for the actual postcondition instead: lastError mentions success=false.
    const failDeadline = Date.now() + 45_000
    let syncFail = await syncStatus(token)
    while (Date.now() < failDeadline && !(syncFail.lastError ?? '').includes('success=false')) {
      await sleep(500)
      syncFail = await syncStatus(token)
    }
    check('success=false recorded as sync failure', syncFail.lastError?.includes('success=false') === true, `lastError=${syncFail.lastError ?? 'null'}`)
    check('previously synced data retained after envelope failure', ((await req('GET', '/platform-metrics/overview', undefined, token)).json as { registeredAccounts?: number }).registeredAccounts === 1234)

    console.log('\n— pull-sync: recovery —')
    rayern.setPayload(GOOD_AGGREGATES)
    // Postcondition poll: wait until the next cycle actually recovers
    // (interval is clamped to 30s in config, so tick-counting is unreliable).
    const recoverDeadline = Date.now() + 45_000
    let sync6 = await syncStatus(token)
    while (Date.now() < recoverDeadline && !(sync6.status === 'healthy' && sync6.consecutiveFailures === 0)) {
      await sleep(500)
      sync6 = await syncStatus(token)
    }
    check('recovers automatically on next cycle', sync6.status === 'healthy' && sync6.consecutiveFailures === 0, `status=${sync6.status} consecutiveFailures=${sync6.consecutiveFailures}`)

    console.log('\n— pull-sync: HTTP 429 rate limit (failure recorded, data kept, Retry-After respected) —')
    rayern.setRateLimited(true, 45)
    const rlDeadline = Date.now() + 45_000
    let syncRL = await syncStatus(token)
    while (Date.now() < rlDeadline && !(syncRL.lastError ?? '').includes('429')) {
      await sleep(500)
      syncRL = await syncStatus(token)
    }
    check('HTTP 429 recorded as sync failure', (syncRL.lastError ?? '').includes('429'), `lastError=${syncRL.lastError ?? 'null'}`)
    check('429 exposed as last HTTP status', syncRL.lastHttpStatus === 429, `http=${String(syncRL.lastHttpStatus)}`)
    check('rate-limit window exposed', typeof syncRL.rateLimitedUntil === 'string', `rl=${String(syncRL.rateLimitedUntil)}`)
    const mRL = (await req('GET', '/platform-metrics/overview', undefined, token)).json as {
      registeredAccounts?: number
      dataSource?: string
    }
    check(
      'previously synced data kept during rate limit (not zeroed)',
      mRL.registeredAccounts === 1234 && mRL.dataSource === 'rayern-sync',
      `registeredAccounts=${String(mRL.registeredAccounts)}`,
    )
    const errs429 = (await req('GET', '/errors', undefined, token)).json as Array<{ service?: string; statusCode?: number }>
    check(
      '429 stored as operational error with status code',
      errs429.some((e) => e.service === 'Rayern Sync' && e.statusCode === 429),
    )

    // Retry-After=45s spans the next scheduled tick (~30s): that tick must be
    // skipped entirely — no new attempt, no hammering, no data changes.
    const attemptAfter429 = (await syncStatus(token)).lastAttemptAt
    await sleep(35_000)
    const attemptDuringWindow = (await syncStatus(token)).lastAttemptAt
    check(
      'scheduled pull skipped inside Retry-After window',
      attemptDuringWindow === attemptAfter429,
      `attempt before=${String(attemptAfter429)} during=${String(attemptDuringWindow)}`,
    )
    rayern.setRateLimited(false)

    console.log('\n— pull-sync: malformed payload (validation failure, data kept) —')
    rayern.setPayload({
      success: true,
      data: {
        accounts: { totalAccounts: 'not-a-number', deletedAccounts30d: null },
        workspaces: { totalWorkspaces: 99, planBreakdown: 'oops' },
      },
    })
    const valDeadline = Date.now() + 60_000
    let syncVal = await syncStatus(token)
    while (Date.now() < valDeadline && !(syncVal.lastError ?? '').includes('failed validation')) {
      await sleep(500)
      syncVal = await syncStatus(token)
    }
    check('malformed payload → validation failure recorded', (syncVal.lastError ?? '').includes('failed validation'), `lastError=${syncVal.lastError ?? 'null'}`)
    const mVal = (await req('GET', '/platform-metrics/overview', undefined, token)).json as { registeredAccounts?: number }
    check('previous synced data kept after validation failure', mVal.registeredAccounts === 1234, `registeredAccounts=${String(mVal.registeredAccounts)}`)

    console.log('\n— pull-sync: empty payload container rejected —')
    rayern.setPayload({ success: true, data: {} })
    const emptyDeadline = Date.now() + 60_000
    let syncEmpty = await syncStatus(token)
    while (Date.now() < emptyDeadline && !(syncEmpty.lastError ?? '').includes('no aggregate sections')) {
      await sleep(500)
      syncEmpty = await syncStatus(token)
    }
    check('empty payload recorded as failure (not fake-healthy)', (syncEmpty.lastError ?? '').includes('no aggregate sections'), `lastError=${syncEmpty.lastError ?? 'null'}`)
    const mEmpty = (await req('GET', '/platform-metrics/overview', undefined, token)).json as { registeredAccounts?: number }
    check('empty payload did not erase synced data', mEmpty.registeredAccounts === 1234, `registeredAccounts=${String(mEmpty.registeredAccounts)}`)

    console.log('\n— pull-sync: recovery after failure sequence —')
    rayern.setPayload({ success: true, data: GOOD_AGGREGATES })
    const finalDeadline = Date.now() + 60_000
    let syncFinal = await syncStatus(token)
    while (Date.now() < finalDeadline && !(syncFinal.status === 'healthy' && syncFinal.consecutiveFailures === 0)) {
      await sleep(500)
      syncFinal = await syncStatus(token)
    }
    check(
      'recovers to healthy after failure sequence',
      syncFinal.status === 'healthy' && syncFinal.consecutiveFailures === 0,
      `status=${syncFinal.status} consecutiveFailures=${syncFinal.consecutiveFailures}`,
    )

    console.log('\n— overlap guard: at most one pull per interval —')
    // The worker's interval is clamped to 30s minimum in config. In a 35s
    // window at most 2 pulls can legitimately land (one tick + boundary);
    // an overlap bug would double that.
    const pullsBefore = rayern.requestCount()
    await sleep(35_000)
    const pullsAfter = rayern.requestCount()
    check(
      'no overlapping duplicate pulls (≤2 in one interval)',
      pullsAfter - pullsBefore <= 2,
      `got ${pullsAfter - pullsBefore}`,
    )

    console.log('\n— emails (validation, enforced From, dedup, dry-run, copy) —')
    const emailStats = await req('GET', '/emails/stats', undefined, token)
    check('GET /emails/stats → 200', emailStats.status === 200 && 'totalSent' in (emailStats.json as object))

    const badSend = await req(
      'POST',
      '/emails/send',
      { from: 'Rayern <support@rayern.com.ng>', to: ['not-an-email'], subject: 'x', message: 'y' },
      token,
    )
    check('POST /emails/send with invalid recipient → 400', badSend.status === 400)

    const noTo = await req(
      'POST',
      '/emails/send',
      { from: 'Rayern <support@rayern.com.ng>', to: [], subject: 'x', message: 'y' },
      token,
    )
    check('POST /emails/send with all three fields empty → 400', noTo.status === 400)

    const noRecipientsAtAll = await req(
      'POST',
      '/emails/send',
      { from: 'Rayern <support@rayern.com.ng>', to: [], cc: [], bcc: [], subject: 'x', message: 'y' },
      token,
    )
    check('POST /emails/send with explicit empty To+CC+BCC → 400', noRecipientsAtAll.status === 400)

    const send = await req(
      'POST',
      '/emails/send',
      {
        from: 'attacker@evil.com',
        to: ['a@example.com', 'b@example.com', 'A@Example.com'],
        cc: ['c@example.com', 'a@example.com'],
        bcc: ['d@example.com', 'c@example.com'],
        subject: 'Smoke test update',
        message: 'Hello from the smoke test.',
        type: 'announcement',
      },
      token,
    )
    const sent = send.json as { from?: string; to?: string[]; cc?: string[]; bcc?: string[]; status?: string; type?: string }
    check('POST /emails/send → 201', send.status === 201)
    check('From identity enforced server-side (attacker ignored)', sent.from === 'Rayern <support@rayern.com.ng>')
    check('To deduplicated case-insensitively (3 → 2)', sent.to?.length === 2)
    check('cross-field dedup: a@example.com dropped from CC', sent.cc?.includes('a@example.com') === false)
    check('cross-field dedup: c@example.com dropped from BCC', sent.bcc?.includes('c@example.com') === false)
    check('CC preserved', sent.cc?.includes('c@example.com') === true)
    check('BCC preserved', sent.bcc?.includes('d@example.com') === true)
    check('type stored', sent.type === 'announcement')

    const history = await req('GET', '/emails', undefined, token)
    const historyArr = history.json as Array<{ id?: string; subject?: string }>
    check('GET /emails lists the sent email', history.status === 200 && historyArr.some((e) => e.subject === 'Smoke test update'))
    check('history metadata excludes message body', historyArr.length > 0 && !('message' in historyArr[0]) && !('body' in historyArr[0]))

    const copyBody = await req('GET', `/emails/${historyArr[0]?.id ?? 'x'}/body`, undefined, token)
    const bodyJson = copyBody.json as { subject?: string; message?: string }
    check('GET /emails/:id/body returns stored content for copy', copyBody.status === 200 && bodyJson.message === 'Hello from the smoke test.')

    const audience = await req('GET', '/emails/audience', undefined, token)
    check('GET /emails/audience → 200', audience.status === 200 && Array.isArray((audience.json as { recipients?: unknown[] })?.recipients))

    console.log('\n— emails: recipient combination matrix (send iff To/CC/BCC any non-empty) —')
    const comboBase = { from: 'Rayern <support@rayern.com.ng>', subject: 'Combo matrix', message: 'Hello' }
    const combos: Array<{ name: string; body: Record<string, unknown>; expect: number }> = [
      { name: 'To only → SEND', body: { to: ['to-only@example.com'] }, expect: 201 },
      { name: 'CC only → SEND', body: { to: [], cc: ['cc-only@example.com'] }, expect: 201 },
      { name: 'BCC only → SEND', body: { to: [], bcc: ['bcc-only@example.com'] }, expect: 201 },
      { name: 'To + CC → SEND', body: { to: ['a@example.com'], cc: ['c@example.com'] }, expect: 201 },
      { name: 'To + BCC → SEND', body: { to: ['a@example.com'], bcc: ['d@example.com'] }, expect: 201 },
      { name: 'CC + BCC → SEND', body: { to: [], cc: ['c@example.com'], bcc: ['d@example.com'] }, expect: 201 },
      { name: 'To + CC + BCC → SEND', body: { to: ['a@example.com'], cc: ['c@example.com'], bcc: ['d@example.com'] }, expect: 201 },
      { name: 'all three empty → REJECT', body: { to: [], cc: [], bcc: [] }, expect: 400 },
    ]
    for (const combo of combos) {
      const res = await req('POST', '/emails/send', { ...comboBase, ...combo.body }, token)
      check(combo.name, res.status === combo.expect, `status=${res.status}`)
    }

    // Visibility integrity: CC-only/BCC-only responses must not invent a To.
    const ccOnly = (await req('POST', '/emails/send', { ...comboBase, to: [], cc: ['cc-visibility@example.com'] }, token)).json as {
      to?: string[]
      cc?: string[]
      bcc?: string[]
    }
    check('CC-only send: no To address injected', Array.isArray(ccOnly.to) && ccOnly.to.length === 0)
    check('CC-only send: CC preserved', ccOnly.cc?.includes('cc-visibility@example.com') === true)
    const bccOnly = (await req('POST', '/emails/send', { ...comboBase, to: [], bcc: ['bcc-visibility@example.com'] }, token)).json as {
      to?: string[]
      cc?: string[]
      bcc?: string[]
    }
    check('BCC-only send: no To address injected (stays genuinely BCC)', Array.isArray(bccOnly.to) && bccOnly.to.length === 0)
    check('BCC-only send: no CC side-channel', Array.isArray(bccOnly.cc) && bccOnly.cc.length === 0)
    check('BCC-only send: BCC preserved', bccOnly.bcc?.includes('bcc-visibility@example.com') === true)

    console.log('\n— emails: exact Resend payload per recipient/body combination —')
    const { buildResendPayload, sanitizeEmailHtml, wrapHtmlFragment } = await import('./emailer')
    const identity = 'Rayern <support@rayern.com.ng>'
    const pBccOnly = buildResendPayload(
      { to: [], cc: [], bcc: ['hidden@example.com'], subject: 's', html: '<p>x</p>' },
      identity,
    )
    check('BCC-only payload: `to` present but empty (field required by SDK, no fake recipient)',
      Array.isArray(pBccOnly.to) && (pBccOnly.to as string[]).length === 0)
    check('BCC-only payload: cc omitted entirely', !('cc' in pBccOnly))
    check('BCC-only payload: bcc preserved', JSON.stringify(pBccOnly.bcc) === '["hidden@example.com"]')
    check('BCC-only payload: html mode → html field only', 'html' in pBccOnly && !('text' in pBccOnly))
    const pCcOnly = buildResendPayload({ to: [], cc: ['visible@example.com'], bcc: [], subject: 's', text: 'hi' }, identity)
    check('CC-only payload: to empty, cc kept, text field only',
      Array.isArray(pCcOnly.to) && (pCcOnly.to as string[]).length === 0 &&
      JSON.stringify(pCcOnly.cc) === '["visible@example.com"]' && 'text' in pCcOnly && !('html' in pCcOnly))
    check('full JSON payload contains no fabricated address for BCC-only',
      !/example\.com[^\]]*example\.com/.test(JSON.stringify({ to: pBccOnly.to })) && (pBccOnly.to as string[]).length === 0)
    const sanitized = sanitizeEmailHtml('<p>Keep</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><iframe src="https://evil"></iframe>')
    check('HTML sanitizer strips script/handlers/js-URL/iframe, keeps formatting',
      !/<script/i.test(sanitized) && !/onerror/i.test(sanitized) && !/javascript:/i.test(sanitized) &&
      !/<iframe/i.test(sanitized) && sanitized.includes('<p>Keep</p>'))
    check('HTML fragments wrapped into a document (no user boilerplate)',
      wrapHtmlFragment('<p>Hi</p>').startsWith('<!doctype html>') && wrapHtmlFragment('<!doctype html><html><body>x</body></html>') === '<!doctype html><html><body>x</body></html>')

    console.log('\n— emails: Plain Text / HTML bodyMode end-to-end —')
    const htmlSend = await req(
      'POST',
      '/emails/send',
      {
        to: ['html-mode@example.com'],
        subject: 'HTML mode test',
        message: '<p>Hello world</p><script>alert(1)</script><img src="x" onerror="alert(1)">',
        bodyType: 'html',
      },
      token,
    )
    check('html-mode send → 201 with bodyType=html', htmlSend.status === 201 && (htmlSend.json as { bodyType?: string }).bodyType === 'html')
    const history2 = (await req('GET', '/emails', undefined, token)).json as Array<{
      id?: string
      subject?: string
      bodyType?: string
      message?: string
      body?: string
    }>
    const htmlRow = history2.find((e) => e.subject === 'HTML mode test')
    check('history row records bodyType=html', htmlRow?.bodyType === 'html')
    check('history rows never expose the body', history2.every((e) => !('message' in e) && !('body' in e)))
    const htmlCopy = (await req('GET', `/emails/${htmlRow?.id ?? '00000000-0000-4000-8000-000000000000'}/body`, undefined, token)).json as {
      message?: string
      bodyType?: string
    }
    check('copy-as-new preserves HTML mode (never auto-sends)', htmlCopy.bodyType === 'html')
    check('stored HTML sanitized but formatting preserved',
      !!htmlCopy.message && htmlCopy.message.includes('<p>Hello world</p>') &&
      !/<script/i.test(htmlCopy.message) && !/onerror/i.test(htmlCopy.message))

    const textSend = await req(
      'POST',
      '/emails/send',
      { to: ['plain-mode@example.com'], subject: 'Plain mode test', message: '<p>literal tags</p>', bodyType: 'text' },
      token,
    )
    check('text-mode send → 201 with bodyType=text', textSend.status === 201 && (textSend.json as { bodyType?: string }).bodyType === 'text')
    const defaultSend = await req(
      'POST',
      '/emails/send',
      { to: ['default-mode@example.com'], subject: 'Default mode test', message: 'plain body' },
      token,
    )
    check('bodyType omitted → defaults to text', defaultSend.status === 201 && (defaultSend.json as { bodyType?: string }).bodyType === 'text')
    const history3 = (await req('GET', '/emails', undefined, token)).json as Array<{
      id?: string
      subject?: string
      bodyType?: string
    }>
    check('history records text mode rows as bodyType=text',
      history3.find((e) => e.subject === 'Plain mode test')?.bodyType === 'text' &&
      history3.find((e) => e.subject === 'Default mode test')?.bodyType === 'text')
    const textRow = history3.find((e) => e.subject === 'Default mode test')
    const textCopy = (await req('GET', `/emails/${textRow?.id ?? '00000000-0000-4000-8000-000000000000'}/body`, undefined, token)).json as {
      message?: string
      bodyType?: string
    }
    check('copy-as-new preserves Plain Text mode', textCopy.bodyType === 'text' && textCopy.message === 'plain body')
    const badBodyType = await req(
      'POST',
      '/emails/send',
      { to: ['x@example.com'], subject: 'Bad mode', message: 'x', bodyType: 'markdown' },
      token,
    )
    check('unknown bodyType rejected → 400', badBodyType.status === 400)

    console.log('\n— emails: BCC-only expansion + Batch API architecture —')
    // BCC-only sends must expand into individual messages (one To per
    // recipient) via the Batch API — never a fake/shared To, never leaked
    // visibility. Dry-run records one row per message with counts intact.
    const bccMulti = await req(
      'POST',
      '/emails/send',
      {
        to: [], cc: [],
        bcc: ['alice@example.com', 'bob@example.com', 'carol@example.com'],
        subject: 'BCC expansion test',
        message: 'Hidden recipients',
        bodyType: 'text',
      },
      token,
    )
    const bccMultiJson = bccMulti.json as {
      to?: string[]; bcc?: string[]; delivery?: { mode?: string; providerMessages?: number; batches?: number }
    }
    check('BCC-only 3 recipients → 201', bccMulti.status === 201, `status=${bccMulti.status}`)
    check('logical composition echoed (to stays empty, no fake To)', Array.isArray(bccMultiJson.to) && bccMultiJson.to.length === 0)
    check('BCC list echoed to the admin', bccMultiJson.bcc?.length === 3)
    check('expansion: 3 individual provider messages (not 1 batch email)', bccMultiJson.delivery?.providerMessages === 3, JSON.stringify(bccMultiJson.delivery))
    check('expansion: 1 batch request carried all 3', bccMultiJson.delivery?.batches === 1)
    check('delivery mode expanded', bccMultiJson.delivery?.mode === 'expanded')

    const bccUsage = await req('GET', '/emails/usage', undefined, token)
    const usageBeforeBcc = (bccUsage.json as { month?: { used?: number } }).month?.used ?? 0
    check('GET /emails/usage → 200 with both windows',
      bccUsage.status === 200 &&
      typeof (bccUsage.json as { month?: { used?: number } }).month?.used === 'number' &&
      typeof (bccUsage.json as { day?: { used?: number } }).day?.used === 'number')
    check(
      'usage counts individual messages (3 BCC recipients = 3 emails)',
      usageBeforeBcc >= 3,
      `monthUsed=${usageBeforeBcc}`,
    )

    console.log('\n— emails: BCC batch splitting (chunk size 100) —')
    // >100 recipients must split across multiple Batch API requests.
    const manyBcc = Array.from({ length: 120 }, (_, i) => `bulk${i}@example.com`)
    const bccBulk = await req(
      'POST',
      '/emails/send',
      { to: [], cc: [], bcc: manyBcc, subject: 'Bulk BCC test', message: 'Batch split', bodyType: 'text' },
      token,
    )
    const bccBulkJson = bccBulk.json as { delivery?: { providerMessages?: number; batches?: number } }
    check('BCC-only 120 recipients → 201', bccBulk.status === 201, `status=${bccBulk.status}`)
    check('120 recipients → 120 individual messages', bccBulkJson.delivery?.providerMessages === 120, JSON.stringify(bccBulkJson.delivery))
    check('120 recipients → 2 batch requests (100 + 20)', bccBulkJson.delivery?.batches === 2, JSON.stringify(bccBulkJson.delivery))

    console.log('\n— emails: CC-only + combined recipients —')
    const ccOnlySend = await req(
      'POST',
      '/emails/send',
      { to: [], cc: ['cc-one@example.com', 'cc-two@example.com'], bcc: [], subject: 'CC-only expansion', message: 'x', bodyType: 'text' },
      token,
    )
    const ccOnlyJson = ccOnlySend.json as { delivery?: { providerMessages?: number; batches?: number } }
    check('CC-only send → 201 with expanded delivery (2 messages)',
      ccOnlySend.status === 201 && ccOnlyJson.delivery?.providerMessages === 2, JSON.stringify(ccOnlyJson.delivery))
    const combined = await req(
      'POST',
      '/emails/send',
      { to: ['to-visible@example.com'], cc: ['cc-visible@example.com'], bcc: ['hidden-1@example.com', 'hidden-2@example.com'], subject: 'Combined visibility', message: 'x', bodyType: 'text' },
      token,
    )
    const combinedJson = combined.json as { delivery?: { providerMessages?: number; batches?: number } }
    check('To+CC+BCC → 1 normal visible message + 2 hidden = 3 messages',
      combined.status === 201 && combinedJson.delivery?.providerMessages === 3, JSON.stringify(combinedJson.delivery))

    console.log('\n— emails: idempotency (retry never re-sends) —')
    const idemKey = '11111111-1111-4111-8111-111111111111'
    const usageBeforeIdem = ((await req('GET', '/emails/usage', undefined, token)).json as { month?: { used?: number } }).month?.used ?? 0
    const idemFirst = await req(
      'POST',
      '/emails/send',
      { to: ['idem@example.com'], subject: 'Idempotent send', message: 'once', bodyType: 'text', idempotencyKey: idemKey },
      token,
    )
    const idemSecond = await req(
      'POST',
      '/emails/send',
      { to: ['idem@example.com'], subject: 'Idempotent send', message: 'once', bodyType: 'text', idempotencyKey: idemKey },
      token,
    )
    const idemFirstId = (idemFirst.json as { id?: string }).id
    const idemSecondId = (idemSecond.json as { id?: string }).id
    check('first submission → 201', idemFirst.status === 201)
    check('retried submission with same key → 200 replay (not a new send)', idemSecond.status === 200 && (idemSecond.json as { idempotentReplay?: boolean }).idempotentReplay === true)
    // The replay responds with the group's representative row id; either way
    // it must identify the SAME logical operation.
    check('replay returns the same logical send id',
      idemSecondId === idemFirstId || idemSecondId === idemKey,
      `first=${String(idemFirstId)} second=${String(idemSecondId)} key=${idemKey}`)
    const usageAfterIdem = ((await req('GET', '/emails/usage', undefined, token)).json as { month?: { used?: number } }).month?.used ?? 0
    check('retry did not double-count usage', usageAfterIdem === usageBeforeIdem + 1, `expected=${usageBeforeIdem + 1} got=${usageAfterIdem}`)

    console.log('\n— emails: quota enforcement —')
    // Shrink the monthly limit via a dedicated child? No — the running API
    // cannot change env; instead verify the 402 path with a recipient count
    // larger than the remaining daily/monthly capacity. With defaults
    // (3000/100) a 500-recipient send exceeds the DAILY limit after the
    // sends above.
    const quotaAttempt = await req(
      'POST',
      '/emails/send',
      { to: [], cc: [], bcc: Array.from({ length: 500 }, (_, i) => `quota${i}@example.com`), subject: 'Quota test', message: 'x', bodyType: 'text' },
      token,
    )
    const quotaJson = quotaAttempt.json as { quota?: { requested?: number; month?: { remaining?: number }; day?: { remaining?: number } } }
    check('operation exceeding remaining quota → 402 (rejected before sending)', quotaAttempt.status === 402, `status=${quotaAttempt.status}`)
    check('quota error exposes requested count + both windows (counts only)',
      quotaJson.quota?.requested === 500 &&
      typeof quotaJson.quota?.month?.remaining === 'number' &&
      typeof quotaJson.quota?.day?.remaining === 'number', JSON.stringify(quotaJson.quota ?? {}))
    check('quota rejection never exposes recipient addresses', !JSON.stringify(quotaJson).includes('quota1@'))
    const usageAfterQuota = ((await req('GET', '/emails/usage', undefined, token)).json as { month?: { used?: number } }).month?.used ?? 0
    check('rejected operation consumed nothing', usageAfterQuota === usageAfterIdem, `before=${usageAfterIdem} after=${usageAfterQuota}`)

    console.log('\n— emails: grouped history (logical operation, not 120 rows) —')
    const groupedHistory = (await req('GET', '/emails', undefined, token)).json as Array<{
      subject?: string
      delivery?: { mode?: string; providerMessages?: number; batches?: number }
    }>
    const bulkRows = groupedHistory.filter((e) => e.subject === 'Bulk BCC test')
    check('expanded operation collapses to ONE logical history row', bulkRows.length === 1, `rows=${bulkRows.length}`)
    check('grouped row carries providerMessages=120 batches=2',
      bulkRows[0]?.delivery?.providerMessages === 120 && bulkRows[0]?.delivery?.batches === 2, JSON.stringify(bulkRows[0]?.delivery ?? {}))
    const copyBulk = (await req('GET', `/emails/${(groupedHistory.find((e) => e.subject === 'Bulk BCC test') as unknown as { id?: string })?.id ?? 'x'}/body`, undefined, token)).json as {
      bcc?: string[]
    }
    check('copy-as-new restores the full hidden audience', copyBulk.bcc?.length === 120, `bcc=${copyBulk.bcc?.length}`)

    console.log('\n— emails: HTML preserved through BCC expansion —')
    const bccHtml = await req(
      'POST',
      '/emails/send',
      { to: [], bcc: ['hidden-html@example.com'], subject: 'HTML BCC mode', message: '<p>rendered</p>', bodyType: 'html' },
      token,
    )
    check('BCC-only HTML send → 201', bccHtml.status === 201)
    const htmlHistory = (await req('GET', '/emails', undefined, token)).json as Array<{ subject?: string; bodyType?: string }>
    check('expanded HTML operation keeps bodyType=html', htmlHistory.find((e) => e.subject === 'HTML BCC mode')?.bodyType === 'html')

    console.log('\n— emails: visibility integrity (no BCC in any row other than its own) —')
    // Every persisted per-recipient row stores ONLY that recipient in
    // to_addrs with an EMPTY bcc list — the group_meta/audit path carries
    // counts, so no row can leak another recipient's address.
    const { query: smokeQuery } = await import('./db')
    const leakRows = await smokeQuery<{ to_addrs: string[]; bcc_addrs: string[] }>(
      `SELECT to_addrs, bcc_addrs FROM emails WHERE subject = 'Bulk BCC test'`,
    )
    check('expanded rows: one To per row', leakRows.every((r) => r.to_addrs.length === 1))
    check('expanded rows: no BCC list stored per row (visibility sealed)', leakRows.every((r) => r.bcc_addrs.length === 0))

    console.log('\n— audit trail —')
    const auditAfter = await req('GET', '/audit', undefined, token)
    const events = auditAfter.json as Array<{ action?: string }>
    check('audit contains admin.login', events.some((e) => e.action === 'admin.login'))
    check('audit contains email.sent', events.some((e) => e.action === 'email.sent'))
    check('audit contains sync.completed', events.some((e) => e.action === 'sync.completed'))
    check('audit contains sync.failed', events.some((e) => e.action === 'sync.failed'))

    const emailEvents = (events as Array<{ action?: string; metadata?: Record<string, string> }>)
      .filter((e) => e.action === 'email.sent')
    check('audit email.sent events found', emailEvents.length > 0)
    check(
      'audit email.sent metadata stores recipient COUNTS (compact rows)',
      emailEvents.every((e) => 'toCount' in (e.metadata ?? {}) && 'ccCount' in (e.metadata ?? {}) && 'bccCount' in (e.metadata ?? {})),
    )
    check(
      'audit email.sent metadata never contains recipient addresses (incl. bulk sends)',
      emailEvents.every((e) => !JSON.stringify(e.metadata ?? {}).includes('@example.com')),
    )

    console.log('\n— platform health: history rollup + transitions + freshness —')
    // By now several telemetry flushes have run (rollup throttle = 2s), so the
    // hourly service_history buckets must contain real aggregated requests.
    const histFinal = (await req('GET', '/system/history?service=dashboard-api&range=24h', undefined, token)).json as {
      points?: Array<{ requestCount?: number; errorRatePct?: number | null; p95Ms?: number | null }>
    }
    check(
      'service_history rollup aggregates real requests',
      (histFinal.points ?? []).some((p) => (p.requestCount ?? 0) > 0),
      `max=${Math.max(0, ...(histFinal.points ?? []).map((p) => p.requestCount ?? 0))}`,
    )
    check(
      'history buckets without traffic report null metrics (not 0)',
      (histFinal.points ?? []).some((p) => p.requestCount === 0 && p.errorRatePct === null),
      JSON.stringify((histFinal.points ?? []).slice(0, 3)),
    )
    const histDb = await req('GET', '/system/history?service=postgres&range=7d', undefined, token)
    check('postgres history drill-down → 200', histDb.status === 200 && Array.isArray((histDb.json as { points?: unknown[] }).points))
    const transFinal = (await req('GET', '/system/transitions?range=24h', undefined, token)).json as Array<{
      from?: string
      to?: string
      reason?: string
    }>
    check(
      'health transitions use four-state statuses when present',
      transFinal.every((t) => ['healthy', 'degraded', 'failing', 'unknown'].includes(t.from ?? '')),
      JSON.stringify(transFinal.slice(0, 3)),
    )
    const sysFinal = (await req('GET', '/system/overview', undefined, token)).json as {
      services?: Array<{ name?: string; status?: string; freshness?: { status?: string } }>
    }
    const dashRow = (sysFinal.services ?? []).find((s) => s.name === 'Dashboard API')
    check(
      'actively observed service is fresh (cannot be silently stale)',
      dashRow?.freshness?.status === 'fresh' && ['healthy', 'degraded', 'failing'].includes(dashRow?.status ?? ''),
      JSON.stringify(dashRow ?? {}),
    )
    const obsFinal = (await req('GET', '/observability/overview', undefined, token)).json as {
      services?: Array<{ service?: string; status?: string; errorCount?: number; freshness?: { status?: string } }>
      slowOperations?: Array<{ avgMs?: number; p99?: number }>
      errorRateTrend?: Array<{ errorRatePct: number | null }>
    }
    check(
      'observability services carry four-state status + freshness + errorCount',
      (obsFinal.services ?? []).length > 0 &&
        (obsFinal.services ?? []).every(
          (s) => ['healthy', 'degraded', 'failing', 'unknown'].includes(s.status ?? '') &&
            typeof s.errorCount === 'number' &&
            ['fresh', 'stale', 'none'].includes(s.freshness?.status ?? ''),
        ),
      JSON.stringify((obsFinal.services ?? []).map((s) => `${s.service}:${s.status}`)),
    )
    check(
      'slow operations expose avg + p99 alongside p95',
      (obsFinal.slowOperations ?? []).every((op) => typeof op.avgMs === 'number' && typeof op.p99 === 'number'),
    )
    check(
      'error-rate trend allows null buckets (no traffic ≠ 0%)',
      (obsFinal.errorRateTrend ?? []).every((p) => p.errorRatePct === null || typeof p.errorRatePct === 'number'),
    )
    const errsFinal = (await req('GET', '/errors', undefined, token)).json as Array<{ statusClass?: string }>
    check(
      'errors expose bounded status classes',
      errsFinal.every((e) => ['1xx', '2xx', '3xx', '4xx', '5xx', 'n/a'].includes(e.statusClass ?? '')),
      JSON.stringify(errsFinal.slice(0, 3).map((e) => e.statusClass)),
    )

    console.log('\n— sync schedule: startup log + 30-minute default —')
    // CHILD_ENV sets RAYERN_SYNC_INTERVAL_MS=4000, which the config's safety
    // floor clamps to 30s — the log must report the ACTUAL schedule (30s),
    // never a stale 600000/600s value.
    check(
      'startup log reports the configured pull interval',
      apiLog.text.includes('pull-sync enabled') && apiLog.text.includes('every 30s'),
      `enabled=${apiLog.text.includes('pull-sync enabled')} every30s=${apiLog.text.includes('every 30s')}`,
    )
    check('startup log has no stale 600000/600s output', !apiLog.text.includes('600000') && !apiLog.text.includes('600s'))
    const { formatIntervalMs } = await import('./rayernSync')
    check('interval formatter renders the 30-minute default as 30m', formatIntervalMs(1_800_000) === '30m')
    if (!process.env.RAYERN_SYNC_INTERVAL_MS) {
      const { config } = await import('./config')
      check('default RAYERN sync interval is 1800000 ms (30 minutes)', config.rayern.intervalMs === 1_800_000, `got=${config.rayern.intervalMs}`)
    } else {
      check('default RAYERN sync interval check skipped (RAYERN_SYNC_INTERVAL_MS overridden in env)', true)
    }

    console.log('\n— old push endpoint removed —')
    const oldSync = await req('POST', '/sync/rayern', { accounts: { totalAccounts: 1 } })
    check('POST /sync/rayern no longer exists → 404', oldSync.status === 404)

    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exitCode = 1
  } catch (err) {
    console.error('Smoke test crashed:', err)
    process.exitCode = 1
  } finally {
    rayern.server.close()
    child.kill('SIGTERM')
    // Give the API a moment to shut down, then force-exit (open handles in the
    // API are in the child process; here just the mock needs closing).
    await sleep(500)
    process.exit(process.exitCode === 1 ? 1 : 0)
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
