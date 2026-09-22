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
 *       * Rayern auth failure / slow responses → failure recorded, dashboard survives,
 *         previously synchronized data retained, automatic recovery
 *   - emails: validation, server-enforced From, cross-field dedup, dry-run,
 *     history without bodies, copy-body endpoint, audience endpoint
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
  setDelayMs: (ms: number) => void
  requestCount: () => number
  lastAuthHeader: () => string | null
}

function startMockRayern(): Promise<MockRayern> {
  let payload: unknown = { ok: true }
  let unauthorized = false
  let delayMs = 0
  let count = 0
  let lastAuth: string | null = null

  const server = createServer((req, res) => {
    count++
    lastAuth = req.headers.authorization ?? null
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
    deletedAccounts30d: 3,
    deletionRequestsPending: 1,
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
  workspaces: { totalWorkspaces: 87, newWorkspaces30d: 5, avgMembersPerWorkspace: 3.2 },
  services: [
    { service: 'Rayern API', kind: 'api', status: 'healthy', uptimePct30d: 99.98, latencyMsP50: 41, latencyMsP95: 180, lastIncidentAt: null },
  ],
}

/* ---------------------------------- Main ----------------------------------- */

async function main(): Promise<void> {
  const rayern = await startMockRayern()
  console.log('Starting dashboard API for smoke test…')

  const bootApi = (): ChildProcess => {
    // Use the same tsx-under-bun invocation the preview/dev scripts use —
    // spawning `bun run` recursively is unreliable in constrained sandboxes.
    const child = spawn('bun', ['node_modules/.bin/tsx', 'src/index.ts'], {
      cwd: path.resolve(__dirname, '..'),
      env: CHILD_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => process.stdout.write(`  [api] ${d}`))
    child.stderr.on('data', (d) => process.stderr.write(`  [api] ${d}`))
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

    const sys2j = (await req('GET', '/system/overview', undefined, token)).json as {
      sync?: { status?: string; lastSuccessAt?: string | null }
      services?: Array<{ name?: string }>
    }
    check('system reports sync healthy after success', sys2j.sync?.status === 'healthy' && !!sys2j.sync?.lastSuccessAt)
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

    // Direct schema check: wrong types are rejected outright.
    const { SyncPayload } = await import('./rayernSync')
    check('invalid aggregate types rejected', SyncPayload.safeParse({ accounts: { totalAccounts: 'not-a-number' } }).success === false)

    console.log('\n— pull-sync: Rayern auth failure (dashboard survives, data retained) —')
    rayern.setUnauthorized(true)
    // Wait for TWO failed cycles: the first registers the failure, the second
    // confirms the consecutive-failure counter and retention assertions.
    await awaitTick(4, token)
    await awaitTick(5, token)
    await awaitTick(6, token)
    const sync4 = await syncStatus(token)
    check('sync status turns failing with error info', sync4.status === 'failing' && sync4.consecutiveFailures >= 1 && !!sync4.lastError)
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

    console.log('\n— overlap guard: request count matches schedule —')
    // Elapsed ticks since boot ≈ 10 → at most 12 requests if no overlap doubling.
    check('no overlapping duplicate pulls', rayern.requestCount() <= 12, `count=${rayern.requestCount()}`)

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
    check('POST /emails/send with empty To → 400', noTo.status === 400)

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

    console.log('\n— audit trail —')
    const auditAfter = await req('GET', '/audit', undefined, token)
    const events = auditAfter.json as Array<{ action?: string }>
    check('audit contains admin.login', events.some((e) => e.action === 'admin.login'))
    check('audit contains email.sent', events.some((e) => e.action === 'email.sent'))
    check('audit contains sync.completed', events.some((e) => e.action === 'sync.completed'))
    check('audit contains sync.failed', events.some((e) => e.action === 'sync.failed'))

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
