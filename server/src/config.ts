/**
 * Backend configuration — reads only from environment variables.
 * No secrets are ever hardcoded; .env is gitignored.
 */
function required(name: string, fallbackIfOptional = false): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    if (fallbackIfOptional) return ''
    throw new Error(`Missing required env var: ${name}`)
  }
  return value.trim()
}

function optionalWithDevFallback(name: string, label: string): string {
  const value = process.env[name]?.trim() ?? ''
  if (value) return value
  // Dev convenience: ephemeral in-memory secret so local/dev runs work without
  // configuration. Production MUST set these via env — see server/env.example.
  const generated = `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  console.warn(`[dashboard-api] WARNING: ${name} is not set — using an ephemeral ${label}. Set it in production.`)
  return generated
}

/** Raw env value with surrounding whitespace trimmed; '' when unset. */
function trimmed(name: string): string {
  return process.env[name]?.trim() ?? ''
}

/** Numeric env with fallback + clamping. Invalid values fall back silently. */
function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw)) return fallback
  return Math.min(Math.max(raw, min), max)
}

/**
 * Numeric env that REJECTS invalid values instead of silently clamping them:
 * a malformed override (empty string, typo, garbage) must fall back to the
 * default — never become NaN. NaN reaching a scheduler would make
 * `setInterval(fn, NaN)` behave like `setInterval(fn, 1)`, turning a sync
 * worker into an accidental tight loop.
 */
function envFiniteNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw.trim())
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/** Boolean env (`1/true/yes` on, `0/false/no` off) with fallback. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = trimmed(name).toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}

/**
 * Parses the standard OTLP header list format: `key=value,key2=value2`
 * (values percent-encoded per the OTel spec). Never logged.
 */
function parseOtlpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (!key) continue
    try {
      headers[key] = decodeURIComponent(value)
    } catch {
      headers[key] = value
    }
  }
  return headers
}

/* --------------------------- Telemetry config ----------------------------- */
// Everything is optional and env-driven. Defaults: local telemetry ON (the
// dashboard's own System/Observability pages read it), OTLP export OFF until
// an endpoint is configured. No telemetry setting can fail API startup.
const otlpTracesEndpoint = trimmed('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')
const otlpBaseEndpoint = trimmed('OTEL_EXPORTER_OTLP_ENDPOINT')
const otlpHeadersRaw = trimmed('OTEL_EXPORTER_OTLP_TRACES_HEADERS') || trimmed('OTEL_EXPORTER_OTLP_HEADERS')

// Rayern pull-sync: the dashboard OUTBOUND-polls the Rayern API. Rayern never
// calls the dashboard and never depends on it. The exact endpoint URL is
// configured (not invented) — when unset, synchronization stays disabled.
const rayernApiBaseUrl = trimmed('RAYERN_API_BASE_URL')
const rayernSyncEndpoint = trimmed('RAYERN_SYNC_ENDPOINT')

export const config = {
  // API_PORT keeps the dashboard API on its own port even where the platform
  // injects PORT for the frontend dev server (they run side by side in dev).
  port: Number(process.env.API_PORT ?? process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL', true),
  /** Managed-Postgres CA certificate (PEM, e.g. Aiven) for SSL verification; '' when unset. */
  databaseCaCert: trimmed('DATABASE_CA_CERT'),
  jwtSecret: optionalWithDevFallback('ADMIN_JWT_SECRET', 'ephemeral JWT secret'),
  // In production, restrict to an explicit origin allow-list (never '*': the
  // API is called with credentials: 'include'). The production dashboard
  // frontend origin is allowed by default; CORS_ORIGINS can extend the list.
  // In dev/preview, allow all — the API uses bearer tokens (not cookies) so
  // CORS is defense-in-depth only.
  corsOrigins:
    process.env.NODE_ENV === 'production'
      ? [
          ...new Set([
            'https://admin.rayern.com.ng',
            ...(process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          ]),
        ]
      : [], // empty = allow all origins
  bootstrap: {
    email: process.env.ADMIN_EMAIL?.trim() || '',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME?.trim() || 'Administrator',
  },
  resendApiKey: required('RESEND_API_KEY', true),
  emailFrom: {
    name: process.env.EMAIL_FROM_NAME?.trim() || 'Rayern',
    address: process.env.EMAIL_FROM_ADDRESS?.trim() || 'support@rayern.com.ng',
  },
  registrationTrendDays: Number(process.env.REGISTRATION_TREND_DAYS ?? 90),

  /* ------------------------- Resend plan limits ---------------------------- */
  /**
   * Usage/quota limits for the Resend account backing the dashboard. The
   * current Free plan allows 3,000 emails/month and 100/day (the Batch API
   * accepts up to 100 messages per request — enforced separately as a
   * transport chunk size). Configurable so a plan upgrade is an env change,
   * not a code change. Limiting env values are validated (fallback on
   * invalid) — a broken env can never disable or inflate the accounting.
   */
  resend: {
    monthlyEmailLimit: envFiniteNumber('RESEND_MONTHLY_EMAIL_LIMIT', 3_000, 1, 10_000_000),
    dailyEmailLimit: envFiniteNumber('RESEND_DAILY_EMAIL_LIMIT', 100, 1, 1_000_000),
    /** Batch API transport chunk — Resend accepts at most 100 messages/request. */
    batchChunkSize: envFiniteNumber('RESEND_BATCH_CHUNK_SIZE', 100, 1, 100),
    /** Reconcile uncertain (timeout/lost-response) batches with Resend. */
    reconcileUncertainBatches: envBool('RESEND_RECONCILE_UNCERTAIN_BATCHES', true),
  },
  /** Usage-lookup depth for /emails/usage (bounded; no full-table scans). */
  emailUsageWindowDays: envFiniteNumber('EMAIL_USAGE_WINDOW_DAYS', 95, 30, 730),
  /** Serve the compiled dashboard frontend from ../dist (single-origin deploys). */
  serveStatic: (process.env.SERVE_STATIC ?? 'false') === 'true',
  /** Dev/test only: validate + record emails without calling Resend. */
  emailDryRun: (process.env.EMAIL_DRY_RUN ?? '') === '1',

  /* -------------------------- Telemetry (OpenTelemetry) -------------------- */
  telemetry: {
    /** Master switch for the dashboard's own telemetry pipeline. The standard
     * OTEL_SDK_DISABLED=true also disables it. Disabled = zero telemetry work;
     * the API runs exactly as before and unavailable values are reported as null. */
    enabled: envBool('TELEMETRY_ENABLED', true) && !envBool('OTEL_SDK_DISABLED', false),
    /** OTLP/HTTP traces endpoint. '' = no external export (local telemetry only). */
    otlpEndpoint:
      otlpTracesEndpoint ||
      (otlpBaseEndpoint ? `${otlpBaseEndpoint.replace(/\/$/, '')}/v1/traces` : ''),
    /** Standard OTLP auth headers (e.g. `api-key=...`). Kept out of all logs. */
    otlpHeaders: parseOtlpHeaders(otlpHeadersRaw),
    /** Standard OTel service identity. Sampler is read from OTEL_TRACES_SAMPLER /
     * OTEL_TRACES_SAMPLER_ARG by the SDK itself and only affects OTLP export. */
    serviceName: trimmed('OTEL_SERVICE_NAME') || 'rayern-admin-dashboard-api',
    environment: trimmed('TELEMETRY_ENVIRONMENT') || process.env.NODE_ENV || 'development',
    /** Requests slower than this count as slow (HTTP span + metrics). */
    slowRequestMs: envNumber('TELEMETRY_SLOW_REQUEST_MS', 1_000, 1, 600_000),
    /** Queries slower than this count as slow. */
    slowQueryMs: envNumber('TELEMETRY_SLOW_QUERY_MS', 250, 1, 600_000),
    /** How often buffered telemetry is persisted to the dashboard database. */
    flushMs: envNumber('TELEMETRY_FLUSH_MS', 10_000, 1_000, 300_000),
    /** Retention pruning so telemetry tables stay bounded. */
    traceRetentionHours: envNumber('TELEMETRY_TRACE_RETENTION_HOURS', 48, 1, 8_760),
    requestLogRetentionHours: envNumber('TELEMETRY_REQUEST_LOG_RETENTION_HOURS', 168, 1, 8_760),
    spanMetricsRetentionHours: envNumber('TELEMETRY_SPAN_METRICS_RETENTION_HOURS', 168, 1, 8_760),
    /** Hourly rollups (service_history) live longer than raw spans — 30 days. */
    serviceHistoryRetentionHours: envNumber('TELEMETRY_SERVICE_HISTORY_RETENTION_HOURS', 720, 1, 8_760),
    /** Health-state transitions are small but valuable incident history — 30 days. */
    transitionRetentionHours: envNumber('TELEMETRY_TRANSITION_RETENTION_HOURS', 720, 1, 8_760),
    /** How often hourly history rollups are recomputed from trace_spans. */
    historyRollupMs: envNumber('TELEMETRY_HISTORY_ROLLUP_MS', 300_000, 1_000, 3_600_000),
    /** Rollup recomputes the trailing N hours (idempotent upserts). */
    historyRollupWindowHours: envNumber('TELEMETRY_HISTORY_ROLLUP_WINDOW_HOURS', 48, 1, 8_760),
  },

  /* --------------------- Deterministic health thresholds ------------------- */
  health: {
    /** Samples required before latency/availability metrics are reported at all
     * (below this they are null — never a fake 0). */
    minSamples: envNumber('HEALTH_MIN_SAMPLES', 10, 1, 1_000_000),
    errorRateDegradedPct: envNumber('HEALTH_ERROR_RATE_DEGRADED_PCT', 1, 0, 100),
    errorRateFailingPct: envNumber('HEALTH_ERROR_RATE_FAILING_PCT', 5, 0, 100),
    latencyP95DegradedMs: envNumber('HEALTH_LATENCY_P95_DEGRADED_MS', 500, 1, 3_600_000),
    latencyP95FailingMs: envNumber('HEALTH_LATENCY_P95_FAILING_MS', 2_000, 1, 3_600_000),
    availabilityDegradedPct: envNumber('HEALTH_AVAILABILITY_DEGRADED_PCT', 99, 0, 100),
    availabilityFailingPct: envNumber('HEALTH_AVAILABILITY_FAILING_PCT', 95, 0, 100),
    dbErrorRateDegradedPct: envNumber('HEALTH_DB_ERROR_RATE_DEGRADED_PCT', 1, 0, 100),
    dbErrorRateFailingPct: envNumber('HEALTH_DB_ERROR_RATE_FAILING_PCT', 10, 0, 100),
    /**
     * Freshness threshold: when a service has produced no telemetry for
     * longer than this, its health becomes `unknown` ("no data") instead of
     * silently staying `healthy`. Absence of telemetry is not proof of health.
     */
    telemetryStaleMs: envNumber('HEALTH_TELEMETRY_STALE_MS', 900_000, 5_000, 604_800_000),
  },

  /* ------------------------- Rayern pull-sync config ------------------------ */
  rayern: {
    /** Optional base URL, e.g. https://api.rayern.com — RAYERN_SYNC_ENDPOINT wins if set. */
    apiBaseUrl: rayernApiBaseUrl,
    /** Full URL of the Rayern metrics endpoint the dashboard GETs. Empty = sync disabled. */
    syncEndpoint: rayernSyncEndpoint || (rayernApiBaseUrl ? `${rayernApiBaseUrl.replace(/\/$/, '')}/internal/dashboard-metrics` : ''),
    /** Bearer token sent to Rayern. Lives only on this server; never in the browser. */
    monitoringToken: trimmed('RAYERN_MONITORING_TOKEN'),
    /**
     * How often the dashboard pulls from Rayern (ms). Default 30 minutes
     * (1800000 — long enough to stay clear of Rayern's rate limits).
     * Overridable via RAYERN_SYNC_INTERVAL_MS, clamped to a 30s floor so a
     * misconfiguration can never turn the worker into an aggressive retry
     * loop. Invalid values fall back to the default instead of becoming NaN
     * (NaN in setInterval would hammer Rayern ~every millisecond).
     */
    intervalMs: envFiniteNumber('RAYERN_SYNC_INTERVAL_MS', 1_800_000, 30_000, 86_400_000),
    /** Per-request timeout (ms) — a hanging Rayern must never hang the worker. */
    timeoutMs: Math.min(Math.max(Number(process.env.RAYERN_SYNC_TIMEOUT_MS ?? 15_000), 2_000), 120_000),
  },
}

export const rayernSyncEnabled = (): boolean => config.rayern.syncEndpoint.length > 0
