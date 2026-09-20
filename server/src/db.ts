/**
 * Database layer — own PostgreSQL instance, completely separate from Rayern.
 *
 * Production: set DATABASE_URL to a real PostgreSQL server (managed, Docker,
 * or hosted). Dev/test without Postgres available: the server transparently
 * boots an embedded Postgres (PGlite over the wire protocol) in-process, so
 * the full API works end-to-end with zero external services.
 *
 * Tables hold ONLY administrative/aggregate data:
 *  - admin_users: dashboard operators (bcrypt password hashes)
 *  - accounts:    privacy-safe account registry (identifier, name, email,
 *                 verification, status, created) — no workspace linkage
 *  - workspaces:  registration metadata only (name, member_count, plan, created)
 *  - emails:      admin-sent email history with recipient metadata (no bodies)
 *  - errors:      operational error records (service/endpoint/status/message/trace)
 *  - audit_events: admin/system actions performed through the dashboard
 *  - service_health / request_log / service_telemetry / trace_spans /
 *    slow_operations / span_metrics: operational telemetry only (no customer
 *    identifiers — request logs store method/endpoint/status/duration, never
 *    user ids, emails, or payloads).
 *
 * By design there is no table for customer workspace content, customer
 * activity, or customer behavioral analytics — the dashboard cannot expose
 * what its own database does not contain.
 */
import { Pool } from 'pg'
import { config } from './config'

export const USING_EMBEDDED_DB = !config.databaseUrl

// Embedded PGlite port: configurable to allow smoke tests and preview to run simultaneously.
export const EMBEDDED_PG_PORT = Number(process.env.EMBEDDED_PG_PORT ?? 54329)

export const pool = new Pool({
  connectionString: config.databaseUrl || `postgres://postgres:postgres@127.0.0.1:${EMBEDDED_PG_PORT}/admin`,
  max: USING_EMBEDDED_DB ? 1 : 10,
  idleTimeoutMillis: 30_000,
})

/**
 * Degraded-mode flag: when the database cannot be initialized the API still
 * boots (so /healthz works) but data routes fail cleanly instead of
 * pretending to have data.
 */
export let dbReady = false
export function setDbReady(ready: boolean): void {
  dbReady = ready
}
export function isDbReady(): boolean {
  return dbReady
}

/** Starts the embedded Postgres (PGlite wire server) when DATABASE_URL is unset. */
export async function startEmbeddedDbIfConfigured(): Promise<void> {
  if (!USING_EMBEDDED_DB) return
  const [{ PGlite }, { PGLiteSocketServer }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite-socket'),
  ])
  const pg = await PGlite.create('memory://')
  const server = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: EMBEDDED_PG_PORT })
  await server.start()
  console.log(`[dashboard-api] embedded Postgres (PGlite) listening on 127.0.0.1:${EMBEDDED_PG_PORT} (dev mode)`)
}

export async function query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as never[])
  return res.rows as T[]
}

let initialized = false

export async function initDb(): Promise<void> {
  if (initialized) return
  initialized = true

  await query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      verification  TEXT NOT NULL DEFAULT 'unverified'
                    CHECK (verification IN ('verified','unverified','pending')),
      status        TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','closed')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name         TEXT NOT NULL,
      member_count INTEGER NOT NULL DEFAULT 1 CHECK (member_count >= 0),
      plan         TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS emails (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resend_id   TEXT,
      from_addr   TEXT NOT NULL,
      to_addrs    TEXT[] NOT NULL,
      cc_addrs    TEXT[] NOT NULL DEFAULT '{}',
      bcc_addrs   TEXT[] NOT NULL DEFAULT '{}',
      subject     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'update'
                  CHECK (type IN ('update','announcement','promotion','notice')),
      status      TEXT NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('queued','sent','delivered','failed','bounced')),
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS errors (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      severity      TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
      service       TEXT NOT NULL,
      endpoint      TEXT NOT NULL DEFAULT '',
      method        TEXT NOT NULL DEFAULT '',
      status_code   INTEGER NOT NULL DEFAULT 0,
      message       TEXT NOT NULL,
      trace_id      TEXT,
      count         INTEGER NOT NULL DEFAULT 1,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor      TEXT NOT NULL,
      actor_kind TEXT NOT NULL DEFAULT 'admin' CHECK (actor_kind IN ('admin','system')),
      action     TEXT NOT NULL,
      target     TEXT NOT NULL DEFAULT '',
      metadata   JSONB NOT NULL DEFAULT '{}',
      timestamp  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS service_health (
      service          TEXT NOT NULL,
      kind             TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','failing')),
      uptime_pct_30d   NUMERIC NOT NULL DEFAULT 100,
      latency_p50      NUMERIC NOT NULL DEFAULT 0,
      latency_p95      NUMERIC NOT NULL DEFAULT 0,
      last_incident_at TIMESTAMPTZ,
      PRIMARY KEY (service, kind)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS request_log (
      id          BIGSERIAL PRIMARY KEY,
      time        TIMESTAMPTZ NOT NULL DEFAULT now(),
      method      TEXT NOT NULL DEFAULT '',
      endpoint    TEXT NOT NULL DEFAULT '',
      status_code INTEGER NOT NULL DEFAULT 0,
      duration_ms NUMERIC NOT NULL DEFAULT 0
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS service_telemetry (
      service        TEXT PRIMARY KEY,
      request_count  BIGINT NOT NULL DEFAULT 0,
      error_rate_pct NUMERIC NOT NULL DEFAULT 0,
      p50            NUMERIC NOT NULL DEFAULT 0,
      p95            NUMERIC NOT NULL DEFAULT 0,
      p99            NUMERIC NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','failing')),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS trace_spans (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trace_id       TEXT NOT NULL,
      span_id        TEXT NOT NULL,
      parent_span_id TEXT,
      service        TEXT NOT NULL,
      operation      TEXT NOT NULL,
      start_time     TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms    NUMERIC NOT NULL DEFAULT 0,
      status_code    INTEGER NOT NULL DEFAULT 0,
      has_error      BOOLEAN NOT NULL DEFAULT false
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS slow_operations (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service      TEXT NOT NULL,
      operation    TEXT NOT NULL,
      p95          NUMERIC NOT NULL DEFAULT 0,
      occurrences  BIGINT NOT NULL DEFAULT 0,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (service, operation)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS span_metrics (
      time           TIMESTAMPTZ NOT NULL DEFAULT now(),
      service        TEXT NOT NULL,
      request_count  BIGINT NOT NULL DEFAULT 0,
      error_count    BIGINT NOT NULL DEFAULT 0
    )
  `)

  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_created ON accounts (created_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts (status)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails (sent_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_errors_last_seen ON errors (last_seen_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events (timestamp)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_request_log_time ON request_log (time)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_trace_spans_start ON trace_spans (start_time)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_span_metrics_time ON span_metrics (time)`)
}
