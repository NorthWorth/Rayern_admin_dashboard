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
  EmailMessage,
  EmailStats,
  EmailType,
  ErrorEntry,
  ErrorSeverity,
  ObservabilityOverview,
  PlatformMetricsOverview,
  RecentFailure,
  ServiceHealth,
  SystemOverview,
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

/* --------------------------------- System --------------------------------- */

export function buildSystemOverview(): SystemOverview {
  const services: ServiceHealth[] = [
    { id: 'svc_api', name: 'Rayern API', kind: 'api', status: 'healthy', uptimePct30d: 99.98, latencyMsP50: 84, latencyMsP95: 210, lastIncidentAt: daysAgo(19) },
    { id: 'svc_dash', name: 'Dashboard API', kind: 'api', status: 'healthy', uptimePct30d: 100, latencyMsP50: 41, latencyMsP95: 96, lastIncidentAt: null },
    { id: 'svc_db', name: 'Primary Database', kind: 'database', status: 'healthy', uptimePct30d: 99.99, latencyMsP50: 12, latencyMsP95: 34, lastIncidentAt: daysAgo(34) },
    { id: 'svc_replica', name: 'Read Replica', kind: 'database', status: 'degraded', uptimePct30d: 99.72, latencyMsP50: 28, latencyMsP95: 180, lastIncidentAt: minutesAgo(47) },
    { id: 'svc_cache', name: 'Cache', kind: 'cache', status: 'healthy', uptimePct30d: 99.95, latencyMsP50: 3, latencyMsP95: 9, lastIncidentAt: daysAgo(11) },
    { id: 'svc_queue', name: 'Job Queue', kind: 'queue', status: 'healthy', uptimePct30d: 99.91, latencyMsP50: 18, latencyMsP95: 65, lastIncidentAt: daysAgo(6) },
    { id: 'svc_email', name: 'Email Delivery', kind: 'email', status: 'healthy', uptimePct30d: 99.87, latencyMsP50: 220, latencyMsP95: 640, lastIncidentAt: daysAgo(3) },
    { id: 'svc_storage', name: 'Object Storage', kind: 'storage', status: 'healthy', uptimePct30d: 99.99, latencyMsP50: 45, latencyMsP95: 120, lastIncidentAt: null },
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
    { id: 'fail_1', service: 'Read Replica', time: minutesAgo(47), message: 'Replication lag exceeded 30s threshold', count: 14 },
    { id: 'fail_2', service: 'Email Delivery', time: minutesAgo(212), message: 'Upstream provider timeout on 3 sends', count: 3 },
    { id: 'fail_3', service: 'Rayern API', time: minutesAgo(780), message: '5xx spike on /api/workspaces (rate limiter)', count: 27 },
  ]

  return {
    overall: 'degraded',
    services,
    requestVolume,
    errorRatePct: 0.42,
    requestCount24h: requestVolume.reduce((s, p) => s + p.count, 0),
    latency: { p50: 86, p90: 148, p95: 224, p99: 410 },
    recentFailures,
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
    },
  }
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
  const serviceTelemetry = services.map((s) => ({
    service: s,
    requestCount: randInt(4000, 22000),
    errorRatePct: Math.round(rand() * 220) / 100,
    p50: randInt(8, 90),
    p95: randInt(120, 340),
    p99: randInt(300, 900),
    status: (chance(0.75) ? 'healthy' : chance(0.6) ? 'degraded' : 'failing') as 'healthy' | 'degraded' | 'failing',
  }))

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

  const slowOperations = OPERATIONS.slice(0, 6).map((op, i) => ({
    id: `slow_${i}`,
    service: pick(services),
    operation: op,
    p95: randInt(400, 1800),
    occurrences: randInt(12, 300),
    lastSeenAt: minutesAgo(randInt(5, 600)),
  })).sort((a, b) => b.p95 - a.p95)

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
