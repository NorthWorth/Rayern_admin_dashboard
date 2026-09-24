/**
 * Demo data layer for the admin dashboard.
 *
 * Everything here is generated deterministically and exists ONLY so the UI can
 * be built and reviewed before the dedicated dashboard backend is wired up.
 * When VITE_ADMIN_API_URL is configured, services switch to real endpoints and
 * this module is no longer used by the UI.
 *
 * PRIVACY: the dataset intentionally contains no customer workspace content —
 * no clients, leads, projects, tasks, documents, meetings, or activity data.
 * Only account-level and aggregate platform information is represented.
 */

import type {
  AuditEvent,
  DependencyHealth,
  EmailMessage,
  EmailStats,
  EmailType,
  EmailUsage,
  ErrorEntry,
  ErrorSeverity,
  HealthTransition,
  HistoryRange,
  ObservabilityOverview,
  PlatformMetricsOverview,
  RecentFailure,
  ServiceHealth,
  ServiceHistory,
  SystemOverview,
  TelemetryFreshnessInfo,
  User,
  UserStats,
  Workspace,
  WorkspaceStats,
} from '../lib/types'

/* ------------------------------ Deterministic RNG ------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20260920)
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)] as T
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min
}
function chance(p: number): boolean {
  return rand() < p
}

/* ---------------------------------- Names --------------------------------- */

const FIRST = [
  'Adaeze', 'Tunde', 'Chinedu', 'Amara', 'Ibrahim', 'Ngozi', 'Emeka', 'Fatima', 'Obi', 'Zainab',
  'Kelechi', 'Aisha', 'Yusuf', 'Chiamaka', 'Damilola', 'Oluwaseun', 'Halima', 'Ifeanyi', 'Bola', 'Nneka',
  'Segun', 'Uche', 'Amina', 'Tobi', 'Ejiro', 'Hauwa', 'Kunle', 'Ladi', 'Musa', 'Oge',
  'Ruth', 'Sadiq', 'Temi', 'Uzoma', 'Wale', 'Yemi', 'Bisi', 'Chuka', 'Deji', 'Efe',
]
const LAST = [
  'Okafor', 'Balogun', 'Eze', 'Abubakar', 'Nwosu', 'Adeyemi', 'Mohammed', 'Obi', 'Okonkwo', 'Bello',
  'Ibrahim', 'Chukwu', 'Lawal', 'Ogun', 'Danjuma', 'Afolabi', 'Igwe', 'Sule', 'Umeh', 'Yakubu',
  'Onyeka', 'Salihu', 'Ojo', 'Etim', 'Nnaji',
]
const WORKSPACE_NAMES = [
  'Studio A', 'Studio B', 'Studio C', 'Studio D', 'Studio E', 'Studio F',
  'Studio G', 'Studio H', 'Studio I', 'Studio J', 'Studio K', 'Studio L',
]

function makeEmail(name: string, n: number): string {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.')
  const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'icloud.com', 'proton.me']
  return `${slug}${n % 3 === 0 ? randInt(2, 99) : ''}@${pick(domains)}`
}

/* --------------------------------- Users ---------------------------------- */

export function buildUsers(): User[] {
  const users: User[] = []
  for (let i = 0; i < 86; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`
    const createdDaysAgo = randInt(0, 150)
    const verification = createdDaysAgo > 3 ? (chance(0.72) ? 'verified' : 'unverified') : chance(0.4) ? 'verified' : 'pending'
    const status = createdDaysAgo > 100 && chance(0.08) ? 'suspended' : chance(0.03) ? 'closed' : 'active'
    users.push({
      id: `usr_${String(i + 1).padStart(3, '0')}`,
      name,
      email: makeEmail(name, i),
      verification: verification as User['verification'],
      status: status as User['status'],
      createdAt: daysAgo(createdDaysAgo),
    })
  }
  return users.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(randInt(8, 20), randInt(0, 59), 0, 0)
  return d.toISOString()
}

export function buildUserStats(users: User[]): UserStats {
  const now = Date.now()
  const sevenDays = 7 * 24 * 3600 * 1000
  const thirtyDays = 30 * 24 * 3600 * 1000
  return {
    totalUsers: users.length,
    newUsers7d: users.filter((u) => now - new Date(u.createdAt).getTime() < sevenDays).length,
    verified: users.filter((u) => u.verification === 'verified').length,
    unverified: users.filter((u) => u.verification !== 'verified').length,
    deleted30d: users.filter((u) => u.status === 'closed' && now - new Date(u.createdAt).getTime() < thirtyDays).length,
  }
}

/* ------------------------------- Workspaces ------------------------------- */

export function buildWorkspaces(): Workspace[] {
  const workspaces: Workspace[] = []
  for (let i = 0; i < 32; i++) {
    workspaces.push({
      id: `wsp_${String(i + 1).padStart(3, '0')}`,
      name: WORKSPACE_NAMES[i % WORKSPACE_NAMES.length] ?? 'Studio',
      memberCount: randInt(1, 14),
      createdAt: daysAgo(randInt(1, 200)),
      plan: chance(0.3) ? 'pro' : chance(0.15) ? 'team' : 'free',
    })
  }
  return workspaces.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function buildWorkspaceStats(workspaces: Workspace[]): WorkspaceStats {
  const now = Date.now()
  const thirtyDays = 30 * 24 * 3600 * 1000
  const members = workspaces.reduce((s, w) => s + w.memberCount, 0)
  return {
    total: workspaces.length,
    newWorkspaces30d: workspaces.filter((w) => now - new Date(w.createdAt).getTime() < thirtyDays).length,
    avgMembersPerWorkspace: Math.round((members / workspaces.length) * 10) / 10,
    proWorkspaces: workspaces.filter((w) => w.plan === 'pro').length,
    teamWorkspaces: workspaces.filter((w) => w.plan === 'team').length,
  }
}

/* ----------------------------- Platform metrics --------------------------- */

export function buildPlatformMetrics(users: User[], workspaces: Workspace[]): PlatformMetricsOverview {
  const userStats = buildUserStats(users)
  const wsStats = buildWorkspaceStats(workspaces)

  const registrationsTrend = []
  const today = new Date()
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    registrationsTrend.push({ date: d.toISOString().slice(0, 10), count: randInt(1, 9) })
  }

  return {
    registeredAccounts: userStats.totalUsers,
    newAccounts30d: registrationsTrend.slice(-30).reduce((s, d) => s + d.count, 0),
    verifiedAccounts: userStats.verified,
    unverifiedAccounts: userStats.unverified,
    deletedAccounts30d: userStats.deleted30d,
    deletionRequestsPending: randInt(0, 3),
    totalWorkspaces: wsStats.total,
    newWorkspaces30d: wsStats.newWorkspaces30d,
    registrationsTrend,
    planBreakdown: [
      { plan: 'free', count: wsStats.total - wsStats.proWorkspaces - wsStats.teamWorkspaces },
      { plan: 'pro', count: wsStats.proWorkspaces },
      { plan: 'team', count: wsStats.teamWorkspaces },
    ],
  }
}

/* --------------------------------- Emails --------------------------------- */

const EMAIL_TYPES: EmailType[] = ['update', 'announcement', 'promotion', 'notice']
const EMAIL_SUBJECTS: Record<EmailType, string[]> = {
  update: ['Platform update: new exports', 'Rayern update — June release notes', 'Improved workspace management is live'],
  announcement: ['Scheduled maintenance notice', 'Upcoming platform maintenance window', 'Introducing Rayern Templates'],
  promotion: ['Upgrade to Rayern Pro this month', 'Save 20% on annual plans', 'Team plan launch offer'],
  notice: ['Important: security improvements', 'Action required: billing details', 'End-of-year platform schedule'],
}

export function buildEmails(): EmailMessage[] {
  const emails: EmailMessage[] = []
  for (let i = 0; i < 40; i++) {
    const type = chance(0.35) ? 'update' : chance(0.3) ? 'announcement' : chance(0.5) ? 'promotion' : 'notice'
    const status = chance(0.86) ? 'delivered' : chance(0.5) ? 'sent' : chance(0.6) ? 'failed' : 'bounced'
    const recipient = `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${randInt(1, 99)}@${pick(['gmail.com', 'yahoo.com', 'outlook.com'])}`
    const ccCount = chance(0.3) ? randInt(1, 2) : 0
    const bccCount = chance(0.25) ? randInt(1, 4) : 0
    emails.push({
      id: `eml_${String(i + 1).padStart(3, '0')}`,
      resendId: `re_${[...Array(10)].map(() => 'abcdefghijklmnopqrstuvwxyz0123456789'[randInt(0, 35)]).join('')}`,
      to: [recipient],
      cc: Array.from({ length: ccCount }, () => makeEmail(pick(FIRST), i + 400)),
      bcc: Array.from({ length: bccCount }, () => makeEmail(pick(FIRST), i + 500)),
      subject: pick(EMAIL_SUBJECTS[type]),
      bodyType: chance(0.35) ? 'html' : 'text',
      type,
      status: status as EmailMessage['status'],
      sentAt: minutesAgo(randInt(3, 60 * 24 * 30)),
    })
  }
  return emails.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString()
}

export function buildEmailStats(emails: EmailMessage[]): EmailStats {
  const byType = EMAIL_TYPES.map((type) => ({ type, count: emails.filter((e) => e.type === type).length * 37 }))
  const daily = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    daily.push({ date: d.toISOString().slice(0, 10), sent: randInt(6, 32), failed: randInt(0, 3) })
  }
  const totalSent = daily.reduce((s, d) => s + d.sent, 0)
  return {
    totalSent,
    delivered: Math.round(totalSent * 0.94),
    failed: daily.reduce((s, d) => s + d.failed, 0),
    bounced: Math.round(totalSent * 0.012),
    byType,
    daily,
  }
}

export function buildSentEmail(payload: {
  subject: string
  to: string[]
  cc: string[]
  bcc: string[]
  bodyType?: EmailMessage['bodyType']
}): EmailMessage {
  return {
    id: `eml_${Date.now()}`,
    resendId: `re_demo${Date.now().toString(36)}`,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    bodyType: payload.bodyType ?? 'text',
    type: 'announcement',
    status: 'queued',
    sentAt: new Date().toISOString(),
  }
}

/* ------------------------------- Email usage ------------------------------- */

/** Demo usage consistent with the Free-plan defaults (3,000/mo, 100/day). */
export function buildEmailUsage(): EmailUsage {
  const monthUsed = 2_145
  const dayUsed = 43
  const win = (used: number, limit: number) => ({
    used,
    limit,
    remaining: Math.max(0, limit - used),
    usedPct: Number(((used / limit) * 100).toFixed(1)),
  })
  return {
    month: win(monthUsed, 3_000),
    day: win(dayUsed, 100),
    computedAt: new Date().toISOString(),
    lastReconciledAt: minutesAgo(30),
    limits: { monthly: 3_000, daily: 100 },
  }
}

/* --------------------------------- System --------------------------------- */

function demoFreshness(status: TelemetryFreshnessInfo['status'] = 'fresh', ageMs = 45_000): TelemetryFreshnessInfo {
  if (status === 'none' || ageMs === null) {
    return { lastTelemetryAt: null, ageMs: null, status: 'none' }
  }
  return {
    lastTelemetryAt: new Date(Date.now() - ageMs).toISOString(),
    ageMs,
    status,
  }
}

export function buildSystemOverview(): SystemOverview {
  const base = {
    reason: 'all metrics within thresholds',
    dataSource: 'self' as const,
    reportedStatus: null,
    successCount: 4_812,
    errorRatePct: 0.21,
    rpm: 12,
    slowCount: 3,
    statusClasses: { c2: 4_796, c3: 16, c4: 12, c5: 4 },
    freshness: demoFreshness(),
    lastChange: null,
    historyKey: null as string | null,
  }
  const services: ServiceHealth[] = [
    { id: 'svc_dash', name: 'Dashboard API', kind: 'api', status: 'healthy', uptimePct30d: 99.97, latencyMsP50: 41, latencyMsP95: 96, lastIncidentAt: null, requestCount: 4_828, ...base, historyKey: 'dashboard-api' },
    { id: 'svc_db', name: 'PostgreSQL', kind: 'database', status: 'healthy', uptimePct30d: 99.99, latencyMsP50: 12, latencyMsP95: 34, lastIncidentAt: daysAgo(34), requestCount: 9_410, ...base, historyKey: 'postgres' },
    { id: 'svc_api', name: 'Rayern API', kind: 'api', status: 'healthy', uptimePct30d: 99.98, latencyMsP50: 84, latencyMsP95: 210, lastIncidentAt: daysAgo(19), requestCount: null, successCount: null, errorRatePct: null, rpm: null, slowCount: null, statusClasses: null, dataSource: 'rayern-sync', reportedStatus: null, reason: 'reported by Rayern with the latest successful sync', freshness: demoFreshness('fresh', 4 * 60_000), lastChange: null, historyKey: null },
    { id: 'svc_replica', name: 'Read Replica', kind: 'database', status: 'degraded', uptimePct30d: 99.72, latencyMsP50: 28, latencyMsP95: 180, lastIncidentAt: minutesAgo(47), requestCount: null, successCount: null, errorRatePct: null, rpm: null, slowCount: null, statusClasses: null, dataSource: 'rayern-sync', reportedStatus: 'degraded', reason: 'reported by Rayern with the latest successful sync', freshness: demoFreshness('fresh', 4 * 60_000), lastChange: { at: minutesAgo(47), from: 'healthy', to: 'degraded', reason: 'replication lag above threshold' }, historyKey: null },
    { id: 'svc_email', name: 'Resend (email sending)', kind: 'email', status: 'unknown', uptimePct30d: null, latencyMsP50: null, latencyMsP95: null, lastIncidentAt: null, requestCount: 0, successCount: 0, errorRatePct: null, rpm: 0, slowCount: 0, statusClasses: { c2: 0, c3: 0, c4: 0, c5: 0 }, dataSource: 'self', reportedStatus: null, reason: 'no telemetry observed yet', freshness: { lastTelemetryAt: null, ageMs: null, status: 'none' }, lastChange: null, historyKey: 'resend' },
  ]

  const requestVolume = []
  for (let i = 47; i >= 0; i--) {
    const time = new Date(Date.now() - i * 30 * 60000)
    const hour = time.getHours()
    const traffic = hour >= 8 && hour <= 19 ? 1 : 0.35
    const count = Math.round(randInt(160, 240) * traffic)
    requestVolume.push({ time: time.toISOString(), count, errors: Math.round(count * (rand() * 0.018)) })
  }

  const recentFailures: RecentFailure[] = [
    {
      id: 'fail_1', service: 'Dashboard API', route: 'POST /emails/send', statusCategory: '5xx',
      time: minutesAgo(2), firstSeenAt: minutesAgo(42), lastSeenAt: minutesAgo(2),
      message: 'Upstream provider rejected the send payload', count: 3,
    },
    {
      id: 'fail_2', service: 'Rayern Sync', route: 'GET /internal/dashboard-metrics', statusCategory: '429',
      time: minutesAgo(38), firstSeenAt: minutesAgo(38), lastSeenAt: minutesAgo(38),
      message: 'Rayern API responded with HTTP 429 (rate limited)', count: 1,
    },
    {
      id: 'fail_3', service: 'Rayern API', route: 'GET /api/workspaces', statusCategory: '5xx',
      time: minutesAgo(780), firstSeenAt: minutesAgo(780), lastSeenAt: minutesAgo(780),
      message: '5xx spike on workspaces listing (rate limiter)', count: 27,
    },
  ]

  const dependencies: DependencyHealth[] = [
    {
      id: 'dep:postgresql', name: 'PostgreSQL', kind: 'database', status: 'healthy',
      reason: 'all metrics within thresholds', availabilityPct: 99.99, requestCount: 9_410,
      errorCount: 2, errorRatePct: 0.02, p95Ms: 34,
      lastSuccessAt: minutesAgo(1), lastFailureAt: daysAgo(3), lastObservedAt: minutesAgo(1),
      freshness: demoFreshness(), configured: true,
      detail: [
        { label: 'Probe', value: 'reachable in 3ms' },
        { label: 'Pool', value: '4 open · 3 idle · 0 waiting' },
        { label: 'Mode', value: 'managed' },
      ],
      historyKey: 'postgres',
    },
    {
      id: 'dep:rayern-metrics', name: 'Rayern metrics endpoint', kind: 'api', status: 'healthy',
      reason: 'all metrics within thresholds', availabilityPct: 100, requestCount: 48,
      errorCount: 0, errorRatePct: 0, p95Ms: 412,
      lastSuccessAt: minutesAgo(4), lastFailureAt: daysAgo(2), lastObservedAt: minutesAgo(4),
      freshness: demoFreshness('fresh', 4 * 60_000), configured: true,
      detail: [
        { label: 'Pull interval', value: '30m' },
        { label: 'Last pull', value: '412ms' },
        { label: 'Last HTTP', value: '200' },
        { label: 'Consecutive failures', value: '0' },
        { label: 'Data updated', value: new Date(Date.now() - 4 * 60_000).toLocaleString() },
      ],
      historyKey: 'rayern-sync',
    },
    {
      id: 'dep:resend', name: 'Resend (email sending)', kind: 'email', status: 'unknown',
      reason: 'no telemetry observed yet', availabilityPct: null, requestCount: 0,
      errorCount: 0, errorRatePct: null, p95Ms: null,
      lastSuccessAt: null, lastFailureAt: null, lastObservedAt: null,
      freshness: { lastTelemetryAt: null, ageMs: null, status: 'none' }, configured: true,
      detail: [{ label: 'Observed via', value: 'admin-initiated sends (resend.send spans)' }],
      historyKey: 'resend',
    },
  ]

  return {
    overall: 'degraded',
    services,
    dependencies,
    requestVolume,
    errorRatePct: 0.42,
    requestCount24h: requestVolume.reduce((s, p) => s + p.count, 0),
    latency: { p50: 86, p90: 148, p95: 224, p99: 410 },
    recentFailures,
    overallSummary: {
      failing: [],
      degraded: ['Read Replica'],
      healthy: 4,
      unknown: 1,
    },
    sync: {
      enabled: true,
      status: 'healthy' as const,
      lastSuccessAt: minutesAgo(4),
      lastAttemptAt: minutesAgo(4),
      lastFailureAt: daysAgo(2),
      lastError: null,
      consecutiveFailures: 0,
      stale: false,
      running: false,
      lastDurationMs: 412,
      lastHttpStatus: 200,
      dataUpdatedAt: minutesAgo(4),
      intervalMs: 1_800_000,
      rateLimitedUntil: null,
    },
    metricsSync: {
      status: 'healthy' as const,
      reason: 'pulls succeeding on schedule',
      dataAgeMs: 4 * 60_000,
    },
    meta: {
      processUptimeSec: 86_400,
      dbLatencyMs: 3,
      rssBytes: 148 * 1024 * 1024,
      heapUsedBytes: 62 * 1024 * 1024,
      heapTotalBytes: 96 * 1024 * 1024,
      cpuPercent: 7.4,
      eventLoopDelayP95Ms: 2.8,
      pool: { total: 4, idle: 3, waiting: 0 },
      telemetryStaleMs: 900_000,
      healthThresholds: {
        errorRateDegradedPct: 1,
        errorRateFailingPct: 5,
        latencyP95DegradedMs: 500,
        latencyP95FailingMs: 2_000,
      },
    },
  }
}

/** Demo drill-down series: platform → service → metric → time range. */
export function buildServiceHistory(service: string, range: HistoryRange): ServiceHistory {
  const points = range === '30d' ? 30 : range === '7d' ? 168 : 24
  const stepMs = range === '30d' ? 86_400_000 : 3_600_000
  const out: ServiceHistory['points'] = []
  for (let i = points - 1; i >= 0; i--) {
    const empty = chance(0.12)
    const requestCount = empty ? 0 : randInt(120, 900)
    out.push({
      time: new Date(Date.now() - i * stepMs).toISOString(),
      requestCount,
      errorCount: empty ? 0 : Math.round(requestCount * (rand() * 0.03)),
      errorRatePct: empty ? null : Math.round(rand() * 300) / 100,
      availabilityPct: empty ? null : Math.round((100 - rand() * 2) * 100) / 100,
      p95Ms: empty ? null : randInt(80, 640),
    })
  }
  return { service, range, points: out }
}

/** Demo health-state transitions (the backend dedups real ones the same way). */
export function buildTransitions(range: HistoryRange): HealthTransition[] {
  const count = range === '24h' ? 4 : range === '7d' ? 9 : 14
  const rows: HealthTransition[] = []
  for (let i = 0; i < count; i++) {
    const flip = i % 2 === 0
    rows.push({
      id: `tr_${i}`,
      service: pick(['dashboard-api', 'postgres', 'rayern-sync', 'resend']),
      from: flip ? 'healthy' : 'degraded',
      to: flip ? 'degraded' : 'healthy',
      reason: flip ? 'p95 latency 612ms ≥ degraded 500ms' : 'all metrics within thresholds',
      metric: flip ? 'p95Ms' : '',
      metricValue: flip ? 612 : null,
      at: minutesAgo(randInt(10, range === '24h' ? 1_440 : range === '7d' ? 10_080 : 43_200)),
    })
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at))
}

/* --------------------------------- Errors --------------------------------- */

const ENDPOINTS = ['/api/auth/login', '/api/users', '/api/workspaces', '/api/projects', '/api/tasks', '/api/emails/send', '/api/files/upload', '/api/search']
const ERROR_MESSAGES: Record<ErrorSeverity, string[]> = {
  low: ['Slow query warning on aggregate collection', 'Deprecated API version called', 'Retry succeeded after backoff'],
  medium: ['Failed to render aggregate summary', 'Webhook delivery returned 502', 'Token refresh failed for 3 sessions'],
  high: ['Database timeout on aggregation query', 'Unhandled exception in export worker', 'Third-party webhook signature mismatch'],
  critical: ['Connection pool exhausted', 'Primary database failover initiated', 'Queue backlog above critical threshold'],
}

export function buildErrors(): ErrorEntry[] {
  const entries: ErrorEntry[] = []
  const severities: ErrorSeverity[] = ['critical', 'high', 'medium', 'low']
  for (let i = 0; i < 26; i++) {
    const severity = severities[Math.floor(rand() * 4)] as ErrorSeverity
    const status = severity === 'critical' ? 500 : pick([400, 401, 403, 404, 409, 422, 429, 500, 502, 503])
    entries.push({
      id: `err_${String(i + 1).padStart(3, '0')}`,
      severity,
      service: pick(['Rayern API', 'Dashboard API', 'Job Queue', 'Email Delivery']),
      endpoint: pick(ENDPOINTS),
      method: pick(['GET', 'POST', 'PATCH']),
      statusCode: status,
      statusClass: `${Math.floor(status / 100)}xx`,
      message: pick(ERROR_MESSAGES[severity]),
      traceId: chance(0.8) ? [...Array(16)].map(() => '0123456789abcdef'[randInt(0, 15)]).join('') : null,
      count: randInt(1, 48),
      firstSeenAt: minutesAgo(randInt(60, 60 * 24 * 14)),
      lastSeenAt: minutesAgo(randInt(1, 120)),
    })
  }
  return entries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

/* ------------------------------ Observability ----------------------------- */

const OPERATIONS = ['GET /aggregate/metrics', 'POST /auth/session', 'db.accounts.aggregate', 'queue.consume', 'email.send', 'cache.get', 'db.sessions.findOne']

export function buildObservability(): ObservabilityOverview {
  const services = ['rayern-api', 'dashboard-api', 'worker', 'email-service']
  const serviceTelemetry = services.map((s) => {
    const requestCount = randInt(4000, 22000)
    const errorRatePct = Math.round(rand() * 220) / 100
    const status = (chance(0.7) ? 'healthy' : chance(0.6) ? 'degraded' : chance(0.8) ? 'failing' : 'unknown') as ServiceHealth['status']
    const errorCount = Math.round((requestCount * errorRatePct) / 100)
    return {
      service: s,
      requestCount,
      errorCount,
      successCount: requestCount - errorCount,
      errorRatePct,
      p50: randInt(8, 90),
      p95: randInt(120, 340),
      p99: randInt(300, 900),
      status,
      freshness: status === 'unknown'
        ? { lastTelemetryAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), ageMs: 3 * 3_600_000, status: 'stale' as const }
        : demoFreshness(),
    }
  })

  const recentTraces = []
  for (let i = 0; i < 24; i++) {
    const traceId = [...Array(16)].map(() => '0123456789abcdef'[randInt(0, 15)]).join('')
    const root = { service: pick(services), operation: pick(OPERATIONS) }
    const spanCount = randInt(2, 4)
    for (let s = 0; s < spanCount; s++) {
      const hasError = chance(0.12)
      recentTraces.push({
        id: `span_${i}_${s}`,
        traceId,
        spanId: [...Array(8)].map(() => '0123456789abcdef'[randInt(0, 15)]).join(''),
        parentSpanId: s === 0 ? null : 'root',
        service: s === 0 ? root.service : pick(services),
        operation: s === 0 ? root.operation : pick(OPERATIONS),
        startTime: minutesAgo(randInt(1, 90)),
        durationMs: Math.round(rand() * 480 + 6),
        statusCode: hasError ? 500 : chance(0.5) ? 200 : 201,
        hasError,
      })
    }
  }
  recentTraces.sort((a, b) => b.startTime.localeCompare(a.startTime))

  const slowOperations = OPERATIONS.slice(0, 6).map((op, i) => {
    const p95 = randInt(400, 1800)
    return {
      id: `slow_${i}`,
      service: pick(services),
      operation: op,
      p95,
      avgMs: Math.round(p95 * 0.45),
      p99: Math.round(p95 * 1.6),
      occurrences: randInt(12, 300),
      lastSeenAt: minutesAgo(randInt(5, 600)),
    }
  }).sort((a, b) => b.p95 - a.p95)

  const errorRateTrend = []
  for (let i = 23; i >= 0; i--) {
    errorRateTrend.push({ time: new Date(Date.now() - i * 3600 * 1000).toISOString(), errorRatePct: Math.round(rand() * 160) / 100 })
  }

  return { services: serviceTelemetry, recentTraces, slowOperations, errorRateTrend }
}

/* -------------------------------- Audit log ------------------------------- */

const AUDIT_ACTIONS: Array<[string, string, 'admin' | 'system']> = [
  ['email.sent', 'Rayern <support@rayern.com.ng>', 'admin'],
  ['email.sent', 'Rayern <support@rayern.com.ng>', 'admin'],
  ['email.sent', 'Rayern <support@rayern.com.ng>', 'admin'],
  ['user.viewed', 'usr_042', 'admin'],
  ['error.reviewed', 'err_017', 'admin'],
  ['config.updated', 'dashboard.settings', 'admin'],
  ['service.restarted', 'worker', 'system'],
  ['backup.completed', 'primary-database', 'system'],
  ['config.updated', 'alerting.rules', 'admin'],
  ['service.deployed', 'dashboard-api v1.4.2', 'system'],
]

export function buildAuditEvents(): AuditEvent[] {
  return AUDIT_ACTIONS.map(([action, target, actorKind], i) => {
    const meta: Record<string, string> = {}
    if (action === 'email.sent') {
      meta.subject = pick(['Platform update: new exports', 'Scheduled maintenance notice'])
      meta.recipients = String(randInt(1, 24))
    } else if (action === 'user.viewed') {
      meta.reason = 'support investigation'
    } else if (action === 'config.updated') {
      meta.section = pick(['alerts', 'retention', 'access'])
    } else if (action === 'service.restarted') {
      meta.reason = 'memory pressure'
    }
    return {
      id: `aud_${String(i + 1).padStart(3, '0')}`,
      actor: actorKind === 'admin' ? 'Admin (you)' : 'System',
      actorKind,
      action,
      target,
      timestamp: minutesAgo(i === 0 ? 4 : randInt(30, 60 * 24 * 21)),
      metadata: meta,
    }
  })
}
