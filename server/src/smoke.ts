/**
 * Integration smoke test for the dashboard API.
 *
 * Boots the standalone backend exactly as production would (embedded dev
 * database when DATABASE_URL is unset), then exercises:
 *   - health, auth (bad + good credentials, JWT issuance)
 *   - authorization (401 without token, 200 with token on every data route)
 *   - all 12 dashboard endpoints and their response shapes
 *   - server-to-server sync with a valid and an invalid key
 *   - email send: falls back to a no-op transport when RESEND_API_KEY is not
 *     set (the request is still validated, stored, audit-logged, and returned)
 *
 * Usage: bun run src/smoke.ts
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 4557
const BASE = `http://127.0.0.1:${PORT}`

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
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(path === '/sync/rayern' ? { 'x-sync-key': process.env.SMOKE_SYNC_KEY ?? '' } : {}),
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

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Server did not become ready in time')
}

async function main(): Promise<void> {
  console.log('Starting dashboard API for smoke test…')
  const child = spawn('bun', ['run', 'src/index.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      API_PORT: String(PORT),
      CORS_ORIGINS: 'http://localhost:5173',
      EMBEDDED_PG_PORT: '54330',
      SMOKE_SYNC_KEY: 'smoke-sync-key',
      SYNC_API_KEY: 'smoke-sync-key',
      ADMIN_JWT_SECRET: 'smoke-jwt-secret',
      EMAIL_DRY_RUN: '1',
      ADMIN_EMAIL: 'smoke-admin@rayern.com.ng',
      ADMIN_PASSWORD: 'smoke-test-password-123',
      ADMIN_NAME: 'Smoke Admin',
      // No RESEND_API_KEY → email send uses the no-op fallback transport.
      // No DATABASE_URL → embedded Postgres (PGlite) is used.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`  [api] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`  [api] ${d}`))

  try {
    await waitForServer()
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
    const unauthorized = await req('GET', '/users')
    check('GET /users without token → 401', unauthorized.status === 401)
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

    const metrics = await req('GET', '/platform-metrics/overview', undefined, token)
    const m = metrics.json as Record<string, unknown>
    check('GET /platform-metrics/overview → 200', metrics.status === 200)
    check(
      'metrics has privacy-safe aggregate fields only',
      'registeredAccounts' in m &&
        'registrationsTrend' in m &&
        'planBreakdown' in m &&
        !('dau' in m) &&
        !('wau' in m) &&
        !('mau' in m),
    )

    const system = await req('GET', '/system/overview', undefined, token)
    check('GET /system/overview → 200', system.status === 200 && 'overall' in (system.json as object))
    const errors = await req('GET', '/errors', undefined, token)
    check('GET /errors → 200 array', errors.status === 200 && Array.isArray(errors.json))
    const obs = await req('GET', '/observability/overview', undefined, token)
    check('GET /observability/overview → 200', obs.status === 200 && 'services' in (obs.json as object))
    const audit = await req('GET', '/audit', undefined, token)
    check('GET /audit → 200 array', audit.status === 200 && Array.isArray(audit.json))

    console.log('\n— emails —')
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
        from: 'Rayern <support@rayern.com.ng>',
        to: ['a@example.com', 'b@example.com', 'a@example.com'],
        cc: ['c@example.com'],
        bcc: ['d@example.com'],
        subject: 'Smoke test update',
        message: 'Hello from the smoke test.',
      },
      token,
    )
    const sent = send.json as { to?: string[]; cc?: string[]; bcc?: string[]; resendId?: string; status?: string }
    check('POST /emails/send → 201', send.status === 201)
    check('dry-run send marked as sent', sent.status === 'sent')
    check('To deduplicated (a@example.com once)', sent.to?.length === 2)
    check('CC preserved', sent.cc?.includes('c@example.com') === true)
    check('BCC preserved', sent.bcc?.includes('d@example.com') === true)

    const history = await req('GET', '/emails', undefined, token)
    const historyArr = history.json as Array<{ subject?: string }>
    check('GET /emails lists the sent email', history.status === 200 && historyArr.some((e) => e.subject === 'Smoke test update'))

    console.log('\n— audit trail —')
    const auditAfter = await req('GET', '/audit', undefined, token)
    const events = auditAfter.json as Array<{ action?: string }>
    check('audit contains admin.login', events.some((e) => e.action === 'admin.login'))
    check('audit contains email.sent', events.some((e) => e.action === 'email.sent'))

    console.log('\n— server-to-server sync (STEP 7) —')
    process.env.SMOKE_SYNC_KEY = 'wrong-key'
    const badSync = await req('POST', '/sync/rayern', { accounts: { totalAccounts: 10 } })
    check('sync with wrong key → 401', badSync.status === 401)
    process.env.SMOKE_SYNC_KEY = 'smoke-sync-key'
    const goodSync = await req('POST', '/sync/rayern', {
      accounts: { totalAccounts: 1234, newAccounts30d: 42 },
      workspaces: { totalWorkspaces: 87 },
      services: [
        { service: 'Rayern API', kind: 'api', status: 'healthy', uptimePct30d: 99.98, latencyMsP50: 41, latencyMsP95: 180, lastIncidentAt: null },
      ],
    })
    check('sync with valid key → 200', goodSync.status === 200)

    // Aggregate override should now flow through to platform metrics? No —
    // sync state is stored separately; verify sync is recorded in audit.
    const auditSync = await req('GET', '/audit?search=sync.received', undefined, token)
    check('audit contains sync.received', (auditSync.json as Array<{ action?: string }>).some((e) => e.action === 'sync.received'))

    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exitCode = 1
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
