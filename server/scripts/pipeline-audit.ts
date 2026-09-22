/**
 * End-to-end pipeline audit: Rayern → sync → PostgreSQL → readSyncedAggregates
 *                 → dashboard API routes → deployed API responses.
 *
 * SECURITY: prints ONLY structural information (key names, flags, HTTP status)
 * and aggregate counts. Never prints tokens, Authorization headers, emails,
 * names, IDs, or customer data. Secret env vars are reported as set/unset only.
 */
import { SyncPayload, unwrapRayernEnvelope, describeSyncShape, readSyncedAggregates } from '../src/rayernSync'
import { config, rayernSyncEnabled } from '../src/config'

const RAYERN_LIVE = 'https://rayern-backend.onrender.com/internal/dashboard-metrics'
const DASHBOARD_API = 'https://rayern-admin-dashboard.onrender.com'

const line = (label: string, value: string) => console.log(`${label.padEnd(34)} ${value}`)
const section = (name: string) => console.log(`\n=== ${name} ===`)

async function safeFetch(url: string, init: RequestInit, timeoutMs = 25_000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/* ------------------------- Stage 1: Rayern endpoint ----------------------- */
async function stageRayern(): Promise<unknown> {
  section('STAGE 1 — Rayern endpoint (live)')
  const token = config.rayern.monitoringToken || process.env.SYNC_API_KEY?.trim() || ''
  line('RAYERN_SYNC_ENDPOINT set:', rayernSyncEnabled() ? 'yes' : 'no')
  line('endpoint URL:', config.rayern.syncEndpoint || '(none)')
  line('monitoring token source:', config.rayern.monitoringToken ? 'RAYERN_MONITORING_TOKEN' : process.env.SYNC_API_KEY ? 'SYNC_API_KEY' : '(none — will probe unauthenticated)')
  if (!rayernSyncEnabled()) {
    line('probe:', 'skipped (sync not configured in this environment)')
    return undefined
  }
  try {
    const res = await safeFetch(config.rayern.syncEndpoint, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    line('Rayern HTTP status:', String(res.status))
    const text = await res.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      line('Rayern body:', `non-JSON (${text.length} bytes)`)
      return undefined
    }
    if (typeof raw === 'object' && raw !== null) {
      line('Rayern top-level keys:', Object.keys(raw as Record<string, unknown>).join(', ') || '(none)')
    }
    line('Rayern envelope (shape):', describeSyncShape(raw))
    return raw
  } catch (err) {
    line('probe error:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error')
    return undefined
  }
}

/* ------------ Stage 2: the REAL worker code path against the real body ---- */
function stageSyncParse(raw: unknown): { validated: boolean; sections: string[] } {
  section('STAGE 2 — sync worker parse/validate (actual rayernSync.ts code)')
  if (raw === undefined) {
    line('parse:', 'no live payload available in this environment')
    return { validated: false, sections: [] }
  }
  const unwrapped = unwrapRayernEnvelope(raw)
  if (!unwrapped.ok) {
    line('unwrap:', `FAILED — ${unwrapped.error}`)
    return { validated: false, sections: [] }
  }
  const isEnvelope = unwrapped.value !== raw
  line('envelope unwrapped:', isEnvelope ? 'yes ({success,data} detected)' : 'no (bare payload)')
  const inner = unwrapped.value
  if (typeof inner === 'object' && inner !== null) {
    line('container keys after unwrap:', Object.keys(inner as Record<string, unknown>).join(', ') || '(empty)')
    const o = inner as Record<string, unknown>
    line('accounts section present:', o.accounts !== undefined ? 'yes' : 'NO')
    line('workspaces section present:', o.workspaces !== undefined ? 'yes' : 'NO')
    if (typeof o.accounts === 'object' && o.accounts !== null) {
      line('accounts container keys:', Object.keys(o.accounts as Record<string, unknown>).join(', '))
    }
    if (typeof o.workspaces === 'object' && o.workspaces !== null) {
      line('workspaces container keys:', Object.keys(o.workspaces as Record<string, unknown>).join(', '))
    }
  }
  const parsed = SyncPayload.safeParse(inner)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    line('Zod validation:', `FAILED — ${parsed.error.issues.length} issue(s), first path: ${issue?.path.join('.') || 'root'} (${issue?.code})`)
    return { validated: false, sections: [] }
  }
  line('Zod validation:', 'OK')
  const sections: string[] = []
  if (parsed.data.accounts) {
    sections.push('accounts')
    line('  would persist totalAccounts:', String(parsed.data.accounts.totalAccounts))
  }
  if (parsed.data.workspaces) {
    sections.push('workspaces')
    line('  would persist totalWorkspaces:', String(parsed.data.workspaces.totalWorkspaces))
  }
  if (parsed.data.services && parsed.data.services.length > 0) sections.push('services')
  line('sections that would persist:', sections.join(',') || 'NONE ← empty sync success')
  return { validated: true, sections }
}

/* ---------------- Stage 3+4: PostgreSQL persistence + read path ----------- */
async function stageDatabase(): Promise<void> {
  section('STAGE 3+4 — PostgreSQL rayern_sync_state + readSyncedAggregates')
  line('DATABASE_URL configured:', config.databaseUrl ? 'yes (real PostgreSQL)' : 'NO (embedded dev DB mode)')
  line('DATABASE_CA_CERT set:', config.databaseCaCert ? 'yes' : 'no')
  try {
    const { query } = await import('../src/db')
    const status = await query<{
      last_attempt_at: Date | null
      last_success_at: Date | null
      last_failure_at: Date | null
      last_error: string | null
      consecutive_failures: number
      enabled: boolean
    }>(
      `SELECT last_attempt_at, last_success_at, last_failure_at, last_error, consecutive_failures, enabled
       FROM sync_status WHERE id = 1`,
    )
    const s = status[0]
    if (s) {
      line('sync_status.enabled:', String(s.enabled))
      line('last_attempt_at:', s.last_attempt_at ? s.last_attempt_at.toISOString() : 'null')
      line('last_success_at:', s.last_success_at ? s.last_success_at.toISOString() : 'null')
      line('last_failure_at:', s.last_failure_at ? s.last_failure_at.toISOString() : 'null')
      line('consecutive_failures:', String(s.consecutive_failures))
      line('last_error:', s.last_error ? s.last_error.slice(0, 200) : 'null')
    } else {
      line('sync_status:', 'NO ROW (id=1)')
    }

    const rows = await query<{ key: string; payload: unknown; updated_at: Date }>(
      `SELECT key, payload, updated_at FROM rayern_sync_state ORDER BY key`,
    )
    line('persisted rows:', String(rows.length))
    for (const r of rows) {
      const p = (typeof r.payload === 'object' && r.payload !== null ? r.payload : {}) as Record<string, unknown>
      line(`  [${r.key}] updated_at:`, r.updated_at.toISOString())
      if (r.key === 'accounts') line(`  [${r.key}] totalAccounts:`, String(p.totalAccounts ?? '(missing)'))
      if (r.key === 'workspaces') line(`  [${r.key}] totalWorkspaces:`, String(p.totalWorkspaces ?? '(missing)'))
      if (r.key === 'services') line(`  [${r.key}] count:`, Array.isArray(p as unknown[]) ? String((p as unknown[]).length) : '(non-array)')
    }
    line('persisted sections:', rows.map((r) => r.key).join(',') || 'NONE')

    const synced = await readSyncedAggregates()
    line('readSyncedAggregates.accounts:', synced.accounts ? `present (totalAccounts=${synced.accounts.totalAccounts})` : 'null ← routes fall back to local tables')
    line('readSyncedAggregates.workspaces:', synced.workspaces ? `present (totalWorkspaces=${synced.workspaces.totalWorkspaces})` : 'null ← routes fall back to local tables')
    line('readSyncedAggregates.syncedAt:', synced.syncedAt ?? 'null')
    line('users/stats would use source:', synced.accounts ? 'rayern-sync' : 'local-registry')
    line('workspaces/stats would use:', synced.workspaces ? 'rayern-sync' : 'local-registry')
    line('platform-metrics source:', synced.accounts ? 'rayern-sync' : 'local-registry')
  } catch (err) {
    line('database query:', `FAILED — ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`)
  }
}

/* ------------------ Stage 5: deployed dashboard API responses ------------- */
async function stageDeployedApi(): Promise<void> {
  section('STAGE 5 — deployed dashboard API (production)')
  try {
    const health = await safeFetch(`${DASHBOARD_API}/healthz`, { method: 'GET' }, 40_000)
    const healthBody = (await health.json()) as { ok?: boolean; db?: boolean; version?: string; uptimeSec?: number }
    line('GET /healthz:', `HTTP ${health.status} ok=${healthBody.ok} db=${healthBody.db} uptimeSec=${healthBody.uptimeSec}`)
  } catch (err) {
    line('GET /healthz:', `FAILED — ${err instanceof Error ? err.message : 'unreachable'}`)
    return
  }

  const email = process.env.ADMIN_EMAIL?.trim() ?? ''
  const password = process.env.ADMIN_PASSWORD ?? ''
  line('ADMIN_EMAIL present in env:', email ? 'yes' : 'no')
  line('ADMIN_PASSWORD present in env:', password ? 'yes' : 'no')
  if (!email || !password) {
    line('login:', 'skipped (no admin credentials in this environment)')
    return
  }
  let token: string
  try {
    const loginRes = await safeFetch(`${DASHBOARD_API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const loginBody = (await loginRes.json()) as { token?: string; error?: string }
    if (!loginRes.ok || !loginBody.token) {
      line('POST /auth/login:', `HTTP ${loginRes.status} ${loginBody.error ?? '(no token)'}`)
      return
    }
    token = loginBody.token
    line('POST /auth/login:', 'HTTP 200 (token received, not printed)')
  } catch (err) {
    line('POST /auth/login:', `FAILED — ${err instanceof Error ? err.message : 'unreachable'}`)
    return
  }

  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  try {
    const users = await (await safeFetch(`${DASHBOARD_API}/users/stats`, { headers: auth })).json() as Record<string, unknown>
    line('GET /users/stats:', `totalUsers=${users.totalUsers} newUsers7d=${users.newUsers7d} verified=${users.verified} unverified=${users.unverified}`)
  } catch (err) {
    line('GET /users/stats:', `FAILED — ${err instanceof Error ? err.message : 'error'}`)
  }
  try {
    const ws = await (await safeFetch(`${DASHBOARD_API}/workspaces/stats`, { headers: auth })).json() as Record<string, unknown>
    line('GET /workspaces/stats:', `total=${ws.total} newWorkspaces30d=${ws.newWorkspaces30d}`)
  } catch (err) {
    line('GET /workspaces/stats:', `FAILED — ${err instanceof Error ? err.message : 'error'}`)
  }
  try {
    const pm = await (await safeFetch(`${DASHBOARD_API}/platform-metrics/overview`, { headers: auth })).json() as Record<string, unknown>
    line('GET /platform-metrics/overview:', `registeredAccounts=${pm.registeredAccounts} totalWorkspaces=${pm.totalWorkspaces} dataSource=${pm.dataSource} syncedAt=${pm.syncedAt}`)
  } catch (err) {
    line('GET /platform-metrics/overview:', `FAILED — ${err instanceof Error ? err.message : 'error'}`)
  }
}

async function main(): Promise<void> {
  console.log('Rayern → Admin Dashboard end-to-end pipeline audit')
  console.log('(structural info + aggregate counts only — no secrets printed)')
  const raw = await stageRayern()
  stageSyncParse(raw)
  await stageDatabase()
  await stageDeployedApi()
  console.log('\nAUDIT COMPLETE')
}

void main()
