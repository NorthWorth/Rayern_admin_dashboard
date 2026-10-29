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
  /** Which source served these counts: synchronized Rayern aggregates or the local registry. */
  dataSource: 'rayern-sync' | 'local-registry'
  /** When the Rayern aggregates behind this response were last pulled (null for local registry). */
  syncedAt: string | null
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

  /**
   * Health of the dashboard-side Rayern pull-sync worker. The dashboard
   * OUTBOUND polls Rayern; Rayern never calls the dashboard.
   */
  sync: RayernSyncStatus
}

/**
 * Health of the dashboard-side Rayern pull-sync worker (spec section 12).
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

/* -------------------------------- Revenue --------------------------------- */

/**
 * Billing block of `GET /api/v1/admin/metrics` (docs/ADMIN_DASHBOARD_BILLING_CONTRACT.md
 * §2.3). Rayern is the source of truth: these values are rendered exactly as
 * reported — never recalculated client-side.
 */
export interface MrrByPlanEntry {
  plan: string
  subscriberCount: number
  mrrMinor: number
}

export interface PlanBreakdownEntry {
  plan: string
  userCount: number
  subscriptionCount: number
  isPaid: boolean
}

export interface AdminMetricBilling {
  currency: string
  amountUnit: string
  generatedAt: string
  activePaidSubscribers: number
  freeUsers: number
  totalAccounts: number
  mrr: { amountMinor: number; amountMajor: number; byPlan: MrrByPlanEntry[] }
  arr: { amountMinor: number; amountMajor: number; definition: string }
  planBreakdown: PlanBreakdownEntry[]
  definitions: Record<string, unknown>
}

export interface AdminMetricPayload {
  accounts: {
    totalAccounts: number
    newAccounts30d: number
    verifiedAccounts: number
    unverifiedAccounts: number
    deletedAccounts30d: number | null
    deletionRequestsPending: number | null
    registrationsTrend: Array<{ date: string; count: number }>
    planBreakdown: Array<{ plan: string; count: number }>
  } | null
  workspaces: {
    totalWorkspaces: number
    newWorkspaces30d: number
    avgMembersPerWorkspace: number
  } | null
  billing: AdminMetricBilling | null
  services: Array<Record<string, unknown>> | null
  telemetry: Record<string, unknown> | null
}

/** Envelope of `GET /api/v1/admin/metrics` (§2.3) and error responses (§1). */
export interface AdminMetricResponse {
  success: boolean
  data?: AdminMetricPayload
  error?: { code?: string; message?: string }
}

/* --------------------------- Campaigns & recipients ----------------------- */

/** Plan catalog from `GET /api/v1/admin/users` (§4). */
export type RayernPlan = 'starter' | 'pro' | 'business' | 'premium'
export const RAYERN_PLANS: RayernPlan[] = ['starter', 'pro', 'business', 'premium']

/** `subscriptionStatus` values accepted by the admin users API (§4). */
export type SubscriptionStatus = 'none' | 'active' | 'non_renewing' | 'past_due' | 'canceled' | 'expired'
export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  'none', 'active', 'non_renewing', 'past_due', 'canceled', 'expired',
]

/** `consent` filter values accepted by the admin users API (§4). */
export type ConsentFilter = 'opted_in' | 'opted_out'

export interface AdminUserFilters {
  page?: number
  limit?: number
  plan?: RayernPlan | 'all'
  subscriptionStatus?: SubscriptionStatus | 'all'
  consent?: ConsentFilter | 'all'
}

/** One row of `GET /api/v1/admin/users` (§4) — fields used by the picker. */
export interface AdminUserRecord {
  id: ID
  email: string
  firstName?: string | null
  lastName?: string | null
  emailVerified?: boolean
  accountStatus?: string
  createdAt?: string
  marketingConsent?: { optedIn: boolean; consentedAt?: string | null; updatedAt?: string | null; source?: string } | null
  workspace?: { id?: string; name?: string; plan?: string } | null
  subscription?: {
    plan?: string
    status?: string
    billingInterval?: string | null
    currentPeriodEnd?: string | null
    cancelAtPeriodEnd?: boolean
    hasPaidAccess?: boolean
  } | null
}

export interface AdminUsersPage {
  pagination: { page: number; limit: number; totalResults: number; totalPages: number }
  filters: Record<string, string | null>
  currency?: string
  users: AdminUserRecord[]
}

/** Audience selector shared by preview and send (§5.1). */
export type CampaignAudience =
  | { type: 'all_eligible' }
  | { type: 'filters'; plan?: RayernPlan; subscriptionStatus?: SubscriptionStatus }
  | { type: 'manual_emails'; emails: string[] }

/** Response of `POST /api/v1/admin/campaigns/preview` (§5.2). */
export interface CampaignPreviewResponse {
  audience: CampaignAudience
  eligibleCount: number
  skippedCount: number
  sizeCap: number
  capped: boolean
  preview: Array<{ email: string }>
  previewTruncated: boolean
  skipped: Array<{ email: string; reason: SkipReason }>
}

/** Server-side skip reasons (§5.1) — mapped to human labels in the UI. */
export type SkipReason = 'unknown_address' | 'not_opted_in' | 'account_suspended' | 'consent_revoked_at_send' | string

export const SKIP_REASON_LABELS: Record<string, string> = {
  unknown_address: 'Not a known Rayern account',
  not_opted_in: 'No marketing opt-in',
  account_suspended: 'Account suspended',
  consent_revoked_at_send: 'Opted out during send',
}

export interface CampaignComposePayload {
  subject: string
  bodyHtml: string
  bodyText?: string
  audience: CampaignAudience
  idempotencyKey?: string
}

/** Response of `POST /api/v1/admin/campaigns/send` (§5.3). */
export interface CampaignSendResponse {
  duplicate?: boolean
  campaign: {
    id: string
    status: string
    subject: string
    audience: CampaignAudience
    totals: { resolved: number; accepted: number; failed: number; skipped: number }
    accepted: Array<{ email: string; providerMessageId?: string }>
    failed: Array<{ email: string; error: string }>
    skipped: Array<{ email: string; reason: SkipReason }>
    startedAt?: string
    completedAt?: string
    createdAt?: string
  }
}

/* ===========================================================================
 * Rayern instrumentation & monitoring (contract: Instrumentation & Monitoring)
 *
 * Mirrors the dashboard backend's normalized DTOs (server/src/instrumentation.ts).
 * `null` always means "not available / not reported" — it is never rendered as 0.
 * =========================================================================== */

export interface FunnelDailyPoint {
  date: string
  visits: number | null
  signupIntents: number | null
  registrations: number | null
  activated: number | null
}

export interface FunnelBlock {
  hasVisitorData: boolean
  visits30d: number | null
  signupIntents30d: number | null
  registrations30d: number | null
  activated30d: number | null
  attributedSignups30d: number | null
  daily: FunnelDailyPoint[]
  topSources: Array<{ source: string; count: number }>
  /** Denominators are named in the field; `null` = not computable (0 or unknown). */
  conversion: {
    visitToIntentPct: number | null
    intentToRegistrationPct: number | null
    registrationToActivationPct: number | null
    visitToRegistrationPct: number | null
  }
  attributionCoveragePct: number | null
}

/** Rayern's four client-reported error kinds (§5). */
export type ClientErrorKind = 'api_error' | 'network_error' | 'unexpected_response' | 'config_error' | string

export const CLIENT_ERROR_KIND_LABELS: Record<string, string> = {
  api_error: 'API error',
  network_error: 'Network error',
  unexpected_response: 'Unexpected response',
  config_error: 'Configuration error',
}

/** Kinds that usually indicate a wrong API base URL or frontend misconfiguration. */
export const CLIENT_ERROR_CONFIG_HINT: Record<string, string> = {
  unexpected_response: 'HTML or a non-JSON body came back where JSON was expected — often a wrong API base URL.',
  config_error: 'The browser could not build a usable API base URL at startup.',
}

export interface ClientErrorsBlock {
  total: number | null
  byKind: Array<{ kind: ClientErrorKind; count: number }>
  topEndpoints: Array<{ endpoint: string; count: number }>
  lastOccurredAt: string | null
}

export interface EndpointHealthRoute {
  key: string
  method: string
  route: string
  requests: number
  ok2xx: number
  err4xx: number
  err5xx: number
  p50Ms: number | null
  p95Ms: number | null
  samples: number | null
  unmatched: boolean
}

export interface EndpointHealthBlock {
  available: boolean
  reason: string | null
  windowMinutes: number | null
  routes: EndpointHealthRoute[]
}

export interface DependencyConfigItem {
  group: string
  name: string
  label: string
  configured: boolean | null
  detail: string | null
}

export interface DependencyConfigBlock {
  available: boolean
  items: DependencyConfigItem[]
}

export interface SyntheticCheck {
  name: string
  status: string
  httpStatus: number | null
  latencyMs: number | null
  p95Ms: number | null
  reason: string | null
  consecutiveFailures: number | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastRecoveredAt: string | null
  history: Array<{ at: string; status: string; httpStatus: number | null; latencyMs: number | null }>
}

export interface SyntheticMonitoringBlock {
  available: boolean
  reason: string | null
  lastCheckedAt: string | null
  lastSuccessfulCheckAt: string | null
  checks: SyntheticCheck[]
}

export interface ProductAdoptionModule {
  module: string
  total: number | null
  created30d: number | null
  completed: number | null
  completionReported: boolean
}

export interface ProductAdoptionBlock {
  available: boolean
  modules: ProductAdoptionModule[]
}

export interface MarketingConsentBlock {
  totalRegisteredUsers: number | null
  optedIn: number | null
  optedOut: number | null
  optedInPct: number | null
  /** False = the three figures disagree; flagged, never corrected. */
  reconciles: boolean
}

export interface EngagementCohort {
  weekStart: string
  size: number | null
  retainedNextWeek: number | null
  retentionPct: number | null
  /** False while the following week has not elapsed — not a 0% result. */
  mature: boolean
}

export interface EngagementBlock {
  available: boolean
  reason: string | null
  dau: number | null
  wau: number | null
  mau: number | null
  dailyActiveUsers: Array<{ date: string; count: number | null }>
  cohorts: EngagementCohort[]
}

export interface InstrumentationBlocks {
  funnel: FunnelBlock | null
  clientErrors: ClientErrorsBlock | null
  endpointHealth: EndpointHealthBlock | null
  dependencyConfig: DependencyConfigBlock | null
  syntheticMonitoring: SyntheticMonitoringBlock | null
  productAdoption: ProductAdoptionBlock | null
  marketingConsent: MarketingConsentBlock | null
  engagement: EngagementBlock | null
}

export interface InstrumentationResponse {
  blocks: InstrumentationBlocks
  syncedAt: string | null
  /** Keys Rayern actually sent. Absent = never received (not "empty"). */
  received: string[]
}

/** One server log line. Sanitized upstream and allow-listed by the proxy. */
export interface RayernLogEntry {
  at: string | null
  level: string | null
  code: string | null
  message: string | null
  status: number | null
  method: string | null
  route: string | null
  requestId: string | null
}

export interface RayernLogMeta {
  source: string
  requestId: string | null
  fetchedAt: string
  level: string | null
  since: string | null
  limit: number
  retentionDays: number
  maxEntries: number
  durable: boolean
  note: string
}

export interface RayernLogsResponse {
  entries: RayernLogEntry[]
  meta: RayernLogMeta
}

export interface SyntheticResponse {
  synthetic: SyntheticMonitoringBlock
  meta: { source: string; requestId: string | null; fetchedAt: string; durable: boolean; note: string }
}
