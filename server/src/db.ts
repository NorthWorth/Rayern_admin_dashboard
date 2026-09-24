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
 *  - emails:      admin-sent email history with recipient metadata and body
 *                 (body stored to power "copy as new email"; never exposed in lists)
 *  - sync_status: dashboard-side pull-sync health (last success/attempt/error)
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
import { config, rayernSyncEnabled } from './config'

export const USING_EMBEDDED_DB = !config.databaseUrl

// Embedded PGlite port: configurable to allow smoke tests and preview to run simultaneously.
export const EMBEDDED_PG_PORT = Number(process.env.EMBEDDED_PG_PORT ?? 54329)

export const pool = new Pool({
  // When a CA cert is supplied, strip sslmode from the URL: pg merges URL params
  // OVER Pool options, so a URL `?sslmode=require` would otherwise replace our
  // pinned-CA ssl config with its own weaker defaults.
  connectionString: config.databaseCaCert
    ? stripSslModeParam(config.databaseUrl || `postgres://postgres:postgres@127.0.0.1:${EMBEDDED_PG_PORT}/admin`)
    : config.databaseUrl || `postgres://postgres:postgres@127.0.0.1:${EMBEDDED_PG_PORT}/admin`,
  max: USING_EMBEDDED_DB ? 1 : 10,
  idleTimeoutMillis: 30_000,
  // Managed Postgres (e.g. Aiven, sslmode=require) presents a CA-signed chain.
  // Pin the CA so verification succeeds instead of failing with SELF_SIGNED_CERT_IN_CHAIN.
  // Env vars can mangle multiline PEMs (literal "\n" or missing final newline).
  ...(config.databaseCaCert
    ? { ssl: { ca: normalizePem(config.databaseCaCert), rejectUnauthorized: true } }
    : {}),
})

/** Removes sslmode and legacy ssl params from a connection string's query part. */
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

/** Repairs PEMs delivered through env vars: literal "\n" -> real newlines, single trailing newline. */
function normalizePem(pem: string): string {
  const decoded = pem.includes('\\n') && !pem.includes('\n') ? pem.replace(/\\n/g, '\n') : pem
  return decoded.endsWith('\n') ? decoded : `${decoded}\n`
}

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
      body        TEXT NOT NULL DEFAULT '',
      body_type   TEXT NOT NULL DEFAULT 'text',
      type        TEXT NOT NULL DEFAULT 'update'
                  CHECK (type IN ('update','announcement','promotion','notice')),
      status      TEXT NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('queued','sent','delivered','failed','bounced')),
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  // Migration for pre-existing installs created before the body column existed.
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''`)
  // Migration: explicit composer body mode ('text' | 'html') so history and
  // "copy as new" preserve how the message was sent.
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS body_type TEXT NOT NULL DEFAULT 'text'`)

  /* --------------------- Batch delivery / usage accounting ----------------- */
  // Idempotency: deterministic key per provider message
  // (logical-send-id:index). Retries re-submit with the SAME key, so Resend
  // (or the unique index below for the local DB) deduplicates instead of
  // re-sending. Written only after a provider submission attempt.
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS idempotency_key TEXT`)
  // The logical send operation the admin performed — one id per composer
  // submission, shared by every expanded message of that operation.
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS send_group_id TEXT`)
  // How many individual provider messages this logical operation produced,
  // and how many provider requests (batch API calls) carried them. The pair
  // lets history show "BCC: 100 recipients · Provider messages: 100 ·
  // Batches: 1" without ever counting a batch as one email.
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 1`)
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS batch_count INTEGER NOT NULL DEFAULT 0`)
  // Usage semantics per individual provider message:
  //   accepted  → provider confirmed receipt (usage counts THIS)
  //   uncertain → submission outcome unknown (timeout/lost response) — NOT
  //               counted until reconciliation resolves it
  //   failed    → provider rejected / not submitted — never counted
  // Provider message id per individual message (the batch response returns
  // one id per message — stored so reconciliation/audit can reference them).
  // Added BEFORE the backfill statements below reference it.
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS provider_message_id TEXT`)
  await query(`
    ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_status_check
  `)
  await query(`
    ALTER TABLE emails ADD CONSTRAINT emails_status_check
    CHECK (status IN ('queued','sent','delivered','accepted','uncertain','failed','bounced'))
  `)
  // Historical rows predate batch delivery and always counted toward usage:
  // single-recipient/successful legacy rows are 'accepted'; failures stay
  // failed. sent/delivered keep their meaning (legacy + post-send states).
  await query(`
    UPDATE emails SET status = 'accepted'
    WHERE status = 'sent' AND batch_count = 0 AND message_count = 1
  `)
  // Seed provider_message_id from legacy resend_id ONLY when it is a real
  // non-empty id. Empty strings (dry-run/no-op rows) must stay NULL — the
  // unique index below would otherwise collapse every empty value into a
  // duplicate-key violation on the second insert.
  await query(`
    UPDATE emails SET provider_message_id = resend_id
    WHERE provider_message_id IS NULL AND resend_id IS NOT NULL AND resend_id <> ''
  `)
  // Group metadata for expanded (BCC) operations: the ORIGINAL logical
  // composition (visible To/CC), the delivery mode, and total recipients.
  // One row per group carries this identically; history collapses expanded
  // groups back into the admin's single logical action using it.
  await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS group_meta JSONB`)
  // Deterministic duplicate protection: a provider message id can be recorded
  // at most once (partial — NULLs are exempt, legacy rows keep working).
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_provider_message_id
    ON emails (provider_message_id)
    WHERE provider_message_id IS NOT NULL
  `)
  // Usage lookups aggregate by status over a time window; this keeps them
  // cheap (the existing sent_at index covers the ordering path).
  await query(`CREATE INDEX IF NOT EXISTS idx_emails_status_sent ON emails (status, sent_at)`)

  await query(`
    CREATE TABLE IF NOT EXISTS rayern_sync_state (
      key         TEXT PRIMARY KEY,
      payload     JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS sync_status (
      id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_attempt_at    TIMESTAMPTZ,
      last_success_at    TIMESTAMPTZ,
      last_failure_at    TIMESTAMPTZ,
      last_error         TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      enabled            BOOLEAN NOT NULL DEFAULT false,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
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

  /* ---------------- Platform health / observability (spec §7–§9) ------------ */
  // Health-state transitions: one row per genuine state change (deduplicated
  // by the flush loop comparing against the persisted status — an ongoing
  // condition never produces duplicate rows). Aggregate-only: service name,
  // statuses, reason and a single metric value. Never customer data.
  await query(`
    CREATE TABLE IF NOT EXISTS health_transitions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service     TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status   TEXT NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      metric      TEXT NOT NULL DEFAULT '',
      metric_value NUMERIC,
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_health_transitions_time ON health_transitions (triggered_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_health_transitions_service ON health_transitions (service, triggered_at)`)

  // Hourly per-service rollups derived from trace_spans (idempotent
  // recomputation). This is the long-retention aggregate layer for the
  // 24h / 7d / 30d health history charts — raw spans keep their short
  // retention while history stays queryable for 30 days by default.
  await query(`
    CREATE TABLE IF NOT EXISTS service_history (
      bucket_start  TIMESTAMPTZ NOT NULL,
      service       TEXT NOT NULL,
      request_count BIGINT NOT NULL DEFAULT 0,
      error_count   BIGINT NOT NULL DEFAULT 0,
      slow_count    BIGINT NOT NULL DEFAULT 0,
      p50           NUMERIC,
      p95           NUMERIC,
      p99           NUMERIC,
      PRIMARY KEY (service, bucket_start)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_service_history_bucket ON service_history (bucket_start)`)

  // Four-state health model: `unknown` = no recent telemetry / not observed.
  // (service_health keeps its original 3-state CHECK — Rayern-reported rows
  // only ever carry Rayern's three states; staleness for those is applied at
  // read time.)
  await query(`ALTER TABLE service_telemetry DROP CONSTRAINT IF EXISTS service_telemetry_status_check`)
  await query(`
    ALTER TABLE service_telemetry ADD CONSTRAINT service_telemetry_status_check
    CHECK (status IN ('healthy','degraded','failing','unknown'))
  `)

  // Sync observability: duration + last HTTP status of the most recent pull.
  await query(`ALTER TABLE sync_status ADD COLUMN IF NOT EXISTS last_duration_ms INTEGER`)
  await query(`ALTER TABLE sync_status ADD COLUMN IF NOT EXISTS last_http_status INTEGER`)

  // Slow operations: average + p99 alongside the existing p95.
  await query(`ALTER TABLE slow_operations ADD COLUMN IF NOT EXISTS avg_ms NUMERIC NOT NULL DEFAULT 0`)
  await query(`ALTER TABLE slow_operations ADD COLUMN IF NOT EXISTS p99 NUMERIC NOT NULL DEFAULT 0`)

  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_created ON accounts (created_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts (status)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails (sent_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_request_log_time ON request_log (time)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_errors_last_seen ON errors (last_seen_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events (timestamp)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_sync_status_updated ON sync_status (updated_at)`)

  await query(`
    INSERT INTO sync_status (id, enabled) VALUES (1, $1)
    ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled
  `, [rayernSyncEnabled()])
  await query(`CREATE INDEX IF NOT EXISTS idx_trace_spans_start ON trace_spans (start_time)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_span_metrics_time ON span_metrics (time)`)
}
