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
  registrationsTrend: Array<{ date: string; count: number }>
  planBreakdown: Array<{ plan: Workspace['plan']; count: number }>
}

/* --------------------------------- Emails --------------------------------- */

export type EmailStatus = 'sent' | 'delivered' | 'failed' | 'bounced' | 'queued'
/**
 * Types of emails the dashboard sends. Verification and password-reset emails
 * belong to Rayern's own application flow and are never sent from here.
 */
export type EmailType = 'update' | 'announcement' | 'promotion' | 'notice'

export interface EmailMessage {
  id: ID
  resendId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
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

export interface ComposeEmailPayload {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  message: string
}

/* --------------------------------- System --------------------------------- */

export type HealthStatus = 'healthy' | 'degraded' | 'failing'

export interface ServiceHealth {
  id: ID
  name: string
  kind: 'api' | 'database' | 'cache' | 'queue' | 'email' | 'storage'
  status: HealthStatus
  uptimePct30d: number
  latencyMsP50: number
  latencyMsP95: number
  lastIncidentAt: string | null
}

export interface LatencyPercentiles {
  p50: number
  p90: number
  p95: number
  p99: number
}

export interface SystemOverview {
  overall: HealthStatus
  services: ServiceHealth[]
  requestVolume: Array<{ time: string; count: number; errors: number }>
  errorRatePct: number
  requestCount24h: number
  latency: LatencyPercentiles
  recentFailures: RecentFailure[]
}

export interface RecentFailure {
  id: ID
  service: string
  time: string
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
  errorRatePct: number
  p50: number
  p95: number
  p99: number
  status: HealthStatus
}

export interface ObservabilityOverview {
  services: ServiceTelemetry[]
  recentTraces: TraceSpan[]
  slowOperations: Array<{
    id: ID
    service: string
    operation: string
    p95: number
    occurrences: number
    lastSeenAt: string
  }>
  errorRateTrend: Array<{ time: string; errorRatePct: number }>
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
