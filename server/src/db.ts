import { Pool } from 'pg'
import { config, rayernSyncEnabled } from './config'

export const USING_EMBEDDED_DB = !config.databaseUrl

export const EMBEDDED_PG_PORT = Number(process.env.EMBEDDED_PG_PORT ?? 54329)

export const pool = new Pool({
  connectionString: config.databaseCaCert
    ? stripSslModeParam(config.databaseUrl || `postgres://postgres:postgres@127.0.0.1:${EMBEDDED_PG_PORT}/admin`)
    : config.databaseUrl || `postgres://postgres:postgres@127.0.0.1:${EMBEDDED_PG_PORT}/admin`,
  max: USING_EMBEDDED_DB ? 1 : 10,
  idleTimeoutMillis: 30_000,
  ...(config.databaseCaCert
    ? { ssl: { ca: normalizePem(config.databaseCaCert), rejectUnauthorized: true } }
    : {}),
})

function stripSslModeParam(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    for (const key of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey']) {
      url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return connectionString
  }
}

function normalizePem(pem: string): string {
  const decoded = pem.includes('\\n') && !pem.includes('\n') ? pem.replace(/\\n/g, '\n') : pem
  return decoded.endsWith('\n') ? decoded : `${decoded}\n`
}

export let dbReady = false
export function setDbReady(ready: boolean): void {
  dbReady = ready
}
export function isDbReady(): boolean {
  return dbReady
}

export async function startEmbeddedDbIfConfigured(): Promise<void> {
  if (!USING_EMBEDDED_DB) return
  const [{ PGlite }, { PGLiteSocketServer }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite-socket'),
  ])
  const pg = await PGlite.create('memory://')
  const server = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: EMBEDDED_PG_PORT, maxConnections: 8 })
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
      body        TEXT NOT NULL DEFAULT '',
      body_type   TEXT NOT NULL DEFAULT 'text',
      type        TEXT NOT NULL DEFAULT 'update'
                  CHECK (type IN ('update','announcement','promotion','notice')),
      status      TEXT NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('queued','sent','delivered','failed','bounced')),
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''`)
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS body_type TEXT NOT NULL DEFAULT 'text'`)

  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS idempotency_key TEXT`)
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS send_group_id TEXT`)
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 1`)
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS batch_count INTEGER NOT NULL DEFAULT 0`)
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS provider_message_id TEXT`)
  await query(`ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_status_check`)
  await query(`ALTER TABLE emails ADD CONSTRAINT emails_status_check CHECK (status IN ('queued','sent','delivered','accepted','uncertain','failed','bounced'))`)
  await query(`UPDATE emails SET status = 'accepted' WHERE status = 'sent' AND batch_count = 0 AND message_count = 1`)
  await query(`UPDATE emails SET provider_message_id = resend_id WHERE provider_message_id IS NULL AND resend_id IS NOT NULL AND resend_id <> ''`)
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS group_meta JSONB`)
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_provider_message_id ON emails (provider_message_id) WHERE provider_message_id IS NOT NULL`)
  await query(`CREATE INDEX IF NOT EXISTS idx_emails_status_sent ON emails (status, sent_at)`)

  await query(`CREATE TABLE IF NOT EXISTS marketing_consent (
      account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      status     TEXT NOT NULL CHECK (status IN ('opted_in','opted_out')),
      source     TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','sync')),
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_marketing_consent_status ON marketing_consent (status)`)

  await query(`CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id                UUID PRIMARY KEY,
      subject           TEXT NOT NULL,
      body_type         TEXT NOT NULL DEFAULT 'text' CHECK (body_type IN ('text','html')),
      type              TEXT NOT NULL DEFAULT 'promotion' CHECK (type IN ('update','announcement','promotion','notice')),
      audience_count    INTEGER NOT NULL DEFAULT 0 CHECK (audience_count >= 0),
      provider_messages INTEGER NOT NULL DEFAULT 0,
      batch_count       INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','queued')),
      sent_by           TEXT NOT NULL DEFAULT '',
      sent_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_sent ON marketing_campaigns (sent_at)`)

  await query(`CREATE TABLE IF NOT EXISTS rayern_sync_state (
      key         TEXT PRIMARY KEY,
      payload     JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)

  await query(`CREATE TABLE IF NOT EXISTS sync_status (
      id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_attempt_at    TIMESTAMPTZ,
      last_success_at    TIMESTAMPTZ,
      last_failure_at    TIMESTAMPTZ,
      last_error         TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      enabled            BOOLEAN NOT NULL DEFAULT false,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)

  await query(`CREATE TABLE IF NOT EXISTS errors (
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
    )`)

  await query(`CREATE TABLE IF NOT EXISTS audit_events (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor      TEXT NOT NULL,
      actor_kind TEXT NOT NULL DEFAULT 'admin' CHECK (actor_kind IN ('admin','system')),
      action     TEXT NOT NULL,
      target     TEXT NOT NULL DEFAULT '',
      metadata   JSONB NOT NULL DEFAULT '{}',
      timestamp  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)

  await query(`CREATE TABLE IF NOT EXISTS service_health (
      service          TEXT NOT NULL,
      kind             TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','failing')),
      uptime_pct_30d   NUMERIC,
      latency_p50      NUMERIC NOT NULL DEFAULT 0,
      latency_p95      NUMERIC NOT NULL DEFAULT 0,
      last_incident_at TIMESTAMPTZ,
      PRIMARY KEY (service, kind)
    )`)

  await query(`CREATE TABLE IF NOT EXISTS request_log (
      id          BIGSERIAL PRIMARY KEY,
      time        TIMESTAMPTZ NOT NULL DEFAULT now(),
      method      TEXT NOT NULL DEFAULT '',
      endpoint    TEXT NOT NULL DEFAULT '',
      status_code INTEGER NOT NULL DEFAULT 0,
      duration_ms NUMERIC NOT NULL DEFAULT 0
    )`)

  await query(`CREATE TABLE IF NOT EXISTS service_telemetry (
      service        TEXT PRIMARY KEY,
      request_count  BIGINT NOT NULL DEFAULT 0,
      error_rate_pct NUMERIC NOT NULL DEFAULT 0,
      p50            NUMERIC NOT NULL DEFAULT 0,
      p95            NUMERIC NOT NULL DEFAULT 0,
      p99            NUMERIC NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','failing')),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)

  await query(`CREATE TABLE IF NOT EXISTS trace_spans (
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
    )`)

  await query(`CREATE TABLE IF NOT EXISTS slow_operations (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service      TEXT NOT NULL,
      operation    TEXT NOT NULL,
      p95          NUMERIC NOT NULL DEFAULT 0,
      occurrences  BIGINT NOT NULL DEFAULT 0,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (service, operation)
    )`)

  await query(`CREATE TABLE IF NOT EXISTS span_metrics (
      time           TIMESTAMPTZ NOT NULL DEFAULT now(),
      service        TEXT NOT NULL,
      request_count  BIGINT NOT NULL DEFAULT 0,
      error_count    BIGINT NOT NULL DEFAULT 0
    )`)

  await query(`CREATE TABLE IF NOT EXISTS health_transitions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service     TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status   TEXT NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      metric      TEXT NOT NULL DEFAULT '',
      metric_value NUMERIC,
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_health_transitions_time ON health_transitions (triggered_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_health_transitions_service ON health_transitions (service, triggered_at)`)

  await query(`CREATE TABLE IF NOT EXISTS service_history (
      bucket_start  TIMESTAMPTZ NOT NULL,
      service       TEXT NOT NULL,
      request_count BIGINT NOT NULL DEFAULT 0,
      error_count   BIGINT NOT NULL DEFAULT 0,
      slow_count    BIGINT NOT NULL DEFAULT 0,
      p50           NUMERIC,
      p95           NUMERIC,
      p99           NUMERIC,
      PRIMARY KEY (service, bucket_start)
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_service_history_bucket ON service_history (bucket_start)`)

  await query(`ALTER TABLE service_telemetry DROP CONSTRAINT IF EXISTS service_telemetry_status_check`)
  await query(`ALTER TABLE service_telemetry ADD CONSTRAINT service_telemetry_status_check CHECK (status IN ('healthy','degraded','failing','unknown'))`)

  await query(`CREATE TABLE IF NOT EXISTS rayern_sync_diagnostics (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      source        TEXT NOT NULL DEFAULT 'sync',
      endpoint      TEXT NOT NULL DEFAULT '',
      host          TEXT NOT NULL DEFAULT '',
      method        TEXT NOT NULL DEFAULT 'GET',
      outcome       TEXT NOT NULL DEFAULT 'http_error',
      status        INTEGER,
      duration_ms   NUMERIC NOT NULL DEFAULT 0,
      error_code    TEXT,
      message       TEXT NOT NULL DEFAULT '',
      response_body TEXT,
      headers            JSONB NOT NULL DEFAULT '{}',
      request_id         TEXT,
      final_url          TEXT,
      request_started_at TIMESTAMPTZ,
      reached_application BOOLEAN
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rayern_sync_diagnostics_time ON rayern_sync_diagnostics (occurred_at DESC)`)
  await query(`ALTER TABLE service_health ALTER COLUMN uptime_pct_30d DROP NOT NULL`)
  await query(`ALTER TABLE service_health ALTER COLUMN uptime_pct_30d DROP DEFAULT`)
  await query(`ALTER TABLE rayern_sync_diagnostics ADD COLUMN IF NOT EXISTS final_url TEXT`)
  await query(`ALTER TABLE rayern_sync_diagnostics ADD COLUMN IF NOT EXISTS request_started_at TIMESTAMPTZ`)
  await query(`ALTER TABLE rayern_sync_diagnostics ADD COLUMN IF NOT EXISTS reached_application BOOLEAN`)
  await query(`ALTER TABLE sync_status ADD COLUMN IF NOT EXISTS last_duration_ms INTEGER`)
  await query(`ALTER TABLE sync_status ADD COLUMN IF NOT EXISTS last_http_status INTEGER`)
  await query(`ALTER TABLE slow_operations ADD COLUMN IF NOT EXISTS avg_ms NUMERIC NOT NULL DEFAULT 0`)
  await query(`ALTER TABLE slow_operations ADD COLUMN IF NOT EXISTS p99 NUMERIC NOT NULL DEFAULT 0`)

  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_created ON accounts (created_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts (status)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails (sent_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_request_log_time ON request_log (time)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_errors_last_seen ON errors (last_seen_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events (timestamp)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_sync_status_updated ON sync_status (updated_at)`)

  await query(`INSERT INTO sync_status (id, enabled) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled`, [rayernSyncEnabled()])
  await query(`CREATE INDEX IF NOT EXISTS idx_trace_spans_start ON trace_spans (start_time)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_span_metrics_time ON span_metrics (time)`)

  await query(`CREATE TABLE IF NOT EXISTS rayern_snapshots (
      snapshot_id   TEXT PRIMARY KEY,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      payload       JSONB NOT NULL,
      status        TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed')),
      error         TEXT,
      generated_at  TEXT
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rayern_snapshots_received ON rayern_snapshots (received_at DESC)`)

  await query(`CREATE TABLE IF NOT EXISTS rayern_ingestion_status (
      id                    INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_snapshot_id      TEXT,
      last_received_at      TIMESTAMPTZ,
      last_success_at       TIMESTAMPTZ,
      last_failure_at       TIMESTAMPTZ,
      last_error            TEXT,
      consecutive_failures  INTEGER NOT NULL DEFAULT 0,
      enabled               BOOLEAN NOT NULL DEFAULT false,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await query(`INSERT INTO rayern_ingestion_status (id, enabled) VALUES (1, true) ON CONFLICT (id) DO NOTHING`)

  await query(`CREATE TABLE IF NOT EXISTS rayern_audience (
      email           TEXT PRIMARY KEY,
      first_name      TEXT,
      last_name       TEXT,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
      email_verified  BOOLEAN NOT NULL DEFAULT false,
      workspace_plan  TEXT,
      subscription_plan TEXT,
      subscription_status TEXT,
      has_paid_access BOOLEAN NOT NULL DEFAULT false,
      consent_opted_in BOOLEAN NOT NULL DEFAULT false,
      consented_at    TIMESTAMPTZ,
      consent_updated_at TIMESTAMPTZ,
      consent_source  TEXT,
      user_updated_at TIMESTAMPTZ,
      synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rayern_audience_consent ON rayern_audience (consent_opted_in, status)`)
}
