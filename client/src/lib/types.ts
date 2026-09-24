/**
 * Central domain types shared across services and components.
 * These intentionally mirror the shapes the future dashboard backend will expose.
 */

export type ID = string

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface PageRequest {
  page?: number
  pageSize?: number
}

/* ---------------------------------- Users --------------------------------- */

export type VerificationStatus = 'verified' | 'unverified' | 'pending'
export type AccountStatus = 'active' | 'suspended' | 'closed'

/**
 * Privacy-safe account record for administrative purposes only.
 * Deliberately contains NO links into a customer's workspace content
 * (no clients, leads, projects, tasks, documents, meetings, or activity).
 */
export interface User {
  id: ID
  name: string
  email: string
  verification: VerificationStatus
  status: AccountStatus
  createdAt: string
}

export interface UserStats {
  totalUsers: number
  newUsers7d: number
  verified: number
  unverified: number
  deleted30d: number
}

export interface UserFilters {
  search?: string
  verification?: VerificationStatus | 'all'
  status?: AccountStatus | 'all'
}

/* ------------------------------- Workspaces ------------------------------- */

/**
 * Aggregate workspace registration row. Contains administrative metadata only —
 * never contents, activity, or per-workspace usage of customer data.
 */
export interface Workspace {
  id: ID
  name: string
  memberCount: number
  createdAt: string
  plan: 'free' | 'pro' | 'team'
}

export interface WorkspaceStats {
  total: number
  newWorkspaces30d: number
  avgMembersPerWorkspace: number
  proWorkspaces: number
  teamWorkspaces: number
}

export interface WorkspaceFilters {
  search?: string
  plan?: Workspace['plan'] | 'all'
}

/* ----------------------------- Platform metrics ---------------------------- */

/**
 * Privacy-safe, aggregate platform statistics.
 * Answers "how is Rayern doing as a platform?" without exposing
 * how any individual customer uses the product.
 */
export interface PlatformMetricsOverview {
  registeredAccounts: number
  newAccounts30d: number
  verifiedAccounts: number
  unverifiedAccounts: number
  deletedAccounts30d: number
  deletionRequestsPending: number
  totalWorkspaces: number
  newWorkspaces30d: number
  registrationsTrend: Array<{ date: string; count: number }>
  /**
   * Plan names come from the synchronized Rayern aggregates and may include
   * platform-specific tiers (e.g. 'starter'), so they are plain labels here.
   */
  planBreakdown: Array<{ plan: string; count: number }>
}

/* --------------------------------- Emails --------------------------------- */

export type EmailStatus = 'sent' | 'delivered' | 'failed' | 'bounced' | 'queued'
/**
 * Types of emails the dashboard sends. Verification and password-reset emails
 * belong to Rayern's own application flow and are never sent from here.
 */
export type EmailType = 'update' | 'announcement' | 'promotion' | 'notice'

/**
 * Explicit composer body mode. Chosen by the admin, sent through the matching
 * provider field (html → `html`, text → `text`), persisted with the history
 * record, and preserved by "copy as new". Never inferred from content.
 */
export type EmailBodyType = 'html' | 'text'

export interface EmailMessage {
  id: ID
  resendId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyType: EmailBodyType
  type: EmailType
  status: EmailStatus
  sentAt: string
}

export interface EmailStats {
  totalSent: number
  delivered: number
  failed: number
  bounced: number
  byType: Array<{ type: EmailType; count: number }>
  daily: Array<{ date: string; sent: number; failed: number }>
}

/* ------------------------------ Email usage ------------------------------- */

/** A quota window computed from persisted individual-message rows. */
export interface EmailUsageWindow {
  used: number
  limit: number
  remaining: number
  /** `used / limit * 100` (1 decimal) — null when the limit is 0. */
  usedPct: number | null
}

export interface EmailUsage {
  month: EmailUsageWindow
  day: EmailUsageWindow
  computedAt: string
  /** null until a reconciliation pass has ever run. */
  lastReconciledAt: string | null
  limits: { monthly: number; daily: number }
}

/** Aggregate delivery info for expanded (BCC/CC-only) operations — counts only. */
export interface EmailDeliveryInfo {
  mode: 'expanded' | 'normal'
  providerMessages: number
  batches: number
  accepted: number
  uncertain: number
  failed: number
}

export interface EmailMessage {
  id: ID
  resendId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyType: EmailBodyType
  type: EmailType
  status: EmailStatus
  sentAt: string
  /** Present on expanded operations: counts, never recipient lists. */
  delivery?: EmailDeliveryInfo
}

export interface ComposeEmailPayload {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  message: string
  /** How the body must be sent: 'text' → text field, 'html' → html field. */
  bodyType: EmailBodyType
}

/* --------------------------------- System --------------------------------- */

/**
 * Four-state health model computed BY THE BACKEND from real telemetry.
 * `unknown` = no or stale telemetry — absence of data is never `healthy`.
 */
export type HealthStatus = 'healthy' | 'degraded' | 'failing' | 'unknown'

export type TelemetryFreshness = 'fresh' | 'stale' | 'none'

export interface TelemetryFreshnessInfo {
  /** Last time real telemetry was observed (null = never). */
  lastTelemetryAt: string | null
  ageMs: number | null
  status: TelemetryFreshness
}

/** Bounded HTTP status-class distribution (2xx/3xx/4xx/5xx). */
export interface StatusClassDistribution {
  c2: number
  c3: number
  c4: number
  c5: number
}

export interface ServiceHealth {
  id: ID
  name: string
  kind: 'api' | 'database' | 'cache' | 'queue' | 'email' | 'storage'
  status: HealthStatus
  /** Why the backend decided this state (threshold trigger / staleness). */
  reason: string | null
  /** Where the row comes from: own telemetry vs. Rayern pull-sync. */
  dataSource: 'self' | 'rayern-sync'
  /** Rayern's reported state when staleness overrode it with `unknown`. */
  reportedStatus: HealthStatus | null
  /** Observed availability (%). null = insufficient telemetry — never faked. */
  uptimePct30d: number | null
  /** null = not yet measured (insufficient telemetry). */
  latencyMsP50: number | null
  latencyMsP95: number | null
  lastIncidentAt: string | null
  /** Window request metrics — null for synced rows that have no local series. */
  requestCount: number | null
  successCount: number | null
  errorRatePct: number | null
  rpm: number | null
  slowCount: number | null
  statusClasses: StatusClassDistribution | null
  freshness: TelemetryFreshnessInfo
  /** Most recent persisted health-state transition for this service. */
  lastChange: { at: string; from: HealthStatus; to: HealthStatus; reason: string } | null
  /** Telemetry-service key for history drill-down (null = no local history). */
  historyKey: string | null
}

/** A real dependency of the dashboard backend (no invented ones). */
export interface DependencyHealth {
  id: ID
  name: string
  kind: 'database' | 'api' | 'email'
  status: HealthStatus
  reason: string | null
  availabilityPct: number | null
  requestCount: number | null
  errorCount: number | null
  errorRatePct: number | null
  p95Ms: number | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastObservedAt: string | null
  freshness: TelemetryFreshnessInfo
  configured: boolean
  /** Bounded operational detail lines (pool pressure, pull cadence, …). */
  detail: Array<{ label: string; value: string }>
  /** Telemetry-service key for history drill-down. */
  historyKey: string | null
}

export interface LatencyPercentiles {
  /** null = no measured requests in the window (rendered as "—", never 0). */
  p50: number | null
  p90: number | null
  p95: number | null
  p99: number | null
}

/** Runtime/process health + the configured thresholds health is derived from. */
export interface SystemRuntimeMeta {
  processUptimeSec: number
  dbLatencyMs: number
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  /** null when the runtime cannot measure it (never a fabricated 0). */
  cpuPercent: number | null
  eventLoopDelayP95Ms: number | null
  pool: { total: number; idle: number; waiting: number }
  telemetryStaleMs: number
  healthThresholds: {
    errorRateDegradedPct: number
    errorRateFailingPct: number
    latencyP95DegradedMs: number
    latencyP95FailingMs: number
  }
}

export interface SystemOverview {
  overall: HealthStatus
  services: ServiceHealth[]
  dependencies: DependencyHealth[]
  requestVolume: Array<{ time: string; count: number; errors: number }>
  /** null = no requests measured in the window (rendered as "—", never 0). */
  errorRatePct: number | null
  requestCount24h: number
  latency: LatencyPercentiles
  recentFailures: RecentFailure[]
  /** Backend-computed explanation of the overall rollup (spec §21). */
  overallSummary: { failing: string[]; degraded: string[]; healthy: number; unknown: number }

  /**
   * Health of the dashboard-side Rayern pull-sync worker. The dashboard
   * OUTBOUND polls Rayern; Rayern never calls the dashboard.
   */
  sync: RayernSyncStatus
  /**
   * Spec §17: the metrics-PULL process as its OWN signal, separate from
   * Rayern API health rows (a 429 means Rayern is reachable but rate-limiting
   * the dashboard's pull — not that the API is failing).
   */
  metricsSync: { status: HealthStatus; reason: string; dataAgeMs: number | null }
  meta: SystemRuntimeMeta
}

/**
 * Health of the dashboard-side Rayern pull-sync worker (spec section 12).
 * Includes full operational observability: duration, last HTTP status, the
 * last time valid data was STORED, and any active rate-limit window.
 */
export interface RayernSyncStatus {
  enabled: boolean
  status: HealthStatus
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  consecutiveFailures: number
  stale: boolean
  running: boolean
  lastDurationMs: number | null
  lastHttpStatus: number | null
  /** Last timestamp valid aggregates were written — failed pulls never move it. */
  dataUpdatedAt: string | null
  intervalMs: number
  /** Active HTTP 429 back-off window (null = not rate limited). */
  rateLimitedUntil: string | null
}

/* ---------------------------- Health history ------------------------------ */

export type HistoryRange = '24h' | '7d' | '30d'

export interface ServiceHistoryPoint {
  time: string
  requestCount: number
  errorCount: number
  /** null bucket = no traffic (never rendered as a fake 0%). */
  errorRatePct: number | null
  availabilityPct: number | null
  p95Ms: number | null
}

export interface ServiceHistory {
  service: string
  range: HistoryRange
  points: ServiceHistoryPoint[]
}

/** A genuine health-state transition (deduplicated backend-side). */
export interface HealthTransition {
  id: ID
  service: string
  from: HealthStatus
  to: HealthStatus
  reason: string
  metric: string
  metricValue: number | null
  at: string
}

export interface RecentFailure {
  id: ID
  service: string
  /** Normalized route pattern (e.g. `POST /emails/send`) when known. */
  route: string
  /** Bounded status class ("5xx") or "error" for non-HTTP failures. */
  statusCategory: string
  time: string
  firstSeenAt: string
  lastSeenAt: string
  message: string
  count: number
}

/* --------------------------------- Errors --------------------------------- */

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface ErrorEntry {
  id: ID
  severity: ErrorSeverity
  service: string
  endpoint: string
  method: string
  statusCode: number
  /** Bounded status class (2xx…5xx / n/a) derived from the status code. */
  statusClass: string
  message: string
  traceId: string | null
  count: number
  firstSeenAt: string
  lastSeenAt: string
}

export interface ErrorFilters {
  search?: string
  severity?: ErrorSeverity | 'all'
}

/* ------------------------------ Observability ----------------------------- */

export interface TraceSpan {
  id: ID
  traceId: string
  spanId: string
  parentSpanId: string | null
  service: string
  operation: string
  startTime: string
  durationMs: number
  statusCode: number
  hasError: boolean
}

export interface ServiceTelemetry {
  service: string
  requestCount: number
  errorCount: number
  successCount: number
  errorRatePct: number
  p50: number
  p95: number
  p99: number
  status: HealthStatus
  freshness: TelemetryFreshnessInfo
}

export interface ObservabilityOverview {
  services: ServiceTelemetry[]
  recentTraces: TraceSpan[]
  slowOperations: Array<{
    id: ID
    service: string
    operation: string
    p95: number
    avgMs: number
    p99: number
    occurrences: number
    lastSeenAt: string
  }>
  /** null = no traffic in the bucket (never a fabricated 0% error rate). */
  errorRateTrend: Array<{ time: string; errorRatePct: number | null }>
}

/* -------------------------------- Audit log ------------------------------- */

export type AuditActorKind = 'admin' | 'system'

export interface AuditEvent {
  id: ID
  actor: string
  actorKind: AuditActorKind
  action: string
  target: string
  timestamp: string
  metadata: Record<string, string>
}

export interface AuditFilters {
  search?: string
  actorKind?: AuditActorKind | 'all'
}

/* --------------------------------- Auth ----------------------------------- */

export interface AdminOperator {
  name: string
  email: string
  role: string
}
