import type {
  AuditRow,
  BillingEstimate,
  EmailBodyType,
  EmailMessage,
  EmailStats,
  EmailUsage,
  EmailUsageWindow,
  HistoryRange,
  MarketingCampaign,
  MarketingEvent,
  ObservabilityIncident,
  PlatformMetric,
  ServiceHistory,
  ServiceHistoryPoint,
  SystemOverview,
  User,
  UserStats,
  Workspace,
  WorkspaceStats,
} from '../lib/types'

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

function uid(seed: string): string {\n  let hash = 0\n  for (let i = 0; i < seed.length; i++) {\n    const c = seed.charCodeAt(i)\n    hash = (hash * 31 + c) | 0\n  }\n  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {\n    const r = (hash + Math.random() * 16) % 16\n    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)\n  })\n}

const now = new Date()
const today = now.toISOString().slice(0, 10)

function daysAgo(n: number, sameTime = false): string {\n  const d = new Date(now)\n  d.setUTCDate(d.getUTCDate() - n)\n  return d.toISOString().slice(0, sameTime ? 19 : 10)\n}

function isoNow(addDays = 0, addMs = 0): string {\n  const d = new Date(now.getTime() + addDays * 86400000 + addMs)\n  return d.toISOString()\n}

// ------------------------------------------------------------------
// Users
// ------------------------------------------------------------------

export function buildUsers(seed = 'users'): User[] {\n  const names = [\n    'Ada Lovelace', 'Grace Hopper', 'Margaret Hamilton', 'Annie Easley',\n    'Katherine Johnson', 'Mary Jackson', 'Hedy Lamarr', 'Radia Perlman',\n    'Elizabeth Feinler', 'Sister Mary Kenneth Keller', 'Frances Allen',\n    'Shafi Goldwasser', 'Barbara Liskov', 'Donna Dubinsky',\n  ]\n  const roles = ['Owner', 'Admin', 'Member']\n  return names.map((name, i) => {\n    const email = `user${i + 1}@rayern.com.ng`\n    const created = daysAgo(30 - i, true)\n    return {\n      id: uid(name),\n      name,\n      email,\n      role: roles[i % roles.length],\n      status: i < 9 ? 'active' : i === 9 ? 'suspended' : 'closed',\n      verification: i < 7 ? 'verified' : i === 7 ? 'pending' : 'unverified',\n      createdAt: created,\n    }\n  })\n}

export function buildUserStats(_users: User[]): UserStats {\n  return {\n    totalUsers: 12,\n    newUsers7d: 2,\n    verified: 7,\n    unverified: 3,\n    deleted30d: 1,\n  }\n}

// ------------------------------------------------------------------
// Workspaces
// ------------------------------------------------------------------

export function buildWorkspaces(seed = 'workspaces'): Workspace[] {\n  const items = [\n    { name: 'Alpha Inc.', owner: 'Ada Lovelace', status: 'active' as const, oid: 'org-1' },\n    { name: 'Beta Ltd.', owner: 'Grace Hopper', status: 'active' as const, oid: 'org-2' },\n    { name: 'Gamma Co.', owner: 'Margaret Hamilton', status: 'archived' as const, oid: 'org-3' },\n    { name: 'Delta GmbH', owner: 'Annie Easley', status: 'building' as const, oid: 'org-4' },\n    { name: 'Epsilon SARL', owner: 'Katherine Johnson', status: 'failed' as const, oid: 'org-5' },\n    { name: 'Zeta Oy', owner: 'Mary Jackson', status: 'pending' as const, oid: 'org-6' },\n  ]\n  return items.map((item, i) => ({\n    id: `ws-${i + 1}`,\n    name: item.name,\n    status: item.status,\n    ownerId: `user-${i + 1}`,\n    owner: item.owner,\n    createdAt: isoNow(-i - 1, -Math.floor(Math.random() * 3600000)),\n  }))\n}

export function buildWorkspaceStats(_items: Workspace[], _oid?: string): WorkspaceStats {\n  return { total: 6, active: 2, archived: 1, building: 1, failed: 1, pending: 1 }\n}

// ------------------------------------------------------------------
// System / observability
// ------------------------------------------------------------------

export function buildSystemOverview(): SystemOverview {\n  return {\n    services: [\n      { name: 'api', state: 'healthy', uptime: 99.94, lastChange: daysAgo(2) },\n      { name: 'worker', state: 'healthy', uptime: 99.91, lastChange: daysAgo(5) },\n      { name: 'db', state: 'degraded', uptime: 99.78, lastChange: daysAgo(1) },\n      { name: 'cdn', state: 'healthy', uptime: 99.99, lastChange: daysAgo(12) },\n      { name: 'billing', state: 'down', uptime: 98.22, lastChange: daysAgo(10) },\n    ],\n    ranges: ['6h', '24h', '7d', '30d'] as HistoryRange[],\n  }\n}

export function buildTransitions(range: HistoryRange): { service: string; from: 'healthy' | 'degraded' | 'down'; to: 'healthy' | 'degraded' | 'down'; at: string }[] {\n  const base = range === '30d' ? 30 : range === '7d' ? 7 : range === '24h' ? 1 : 0\n  return [\n    { service: 'db', from: 'healthy', to: 'degraded', at: isoNow(-1 * base, -1800000) },\n    { service: 'billing', from: 'healthy', to: 'down', at: isoNow(-10 * base, -3600000) },\n    { service: 'billing', from: 'down', to: 'degraded', at: isoNow(-9 * base, -1200000) },\n    { service: 'billing', from: 'degraded', to: 'down', at: isoNow(-8 * base, -2400000) },\n  ]\n}

function ramp(count: number, healthy: number, degraded: number, down: number): ServiceHistoryPoint[] {\n  const out: ServiceHistoryPoint[] = []\n  for (let i = 0; i < count; i++) {\n    const frac = i / Math.max(1, count - 1)\n    out.push({\n      time: isoNow(-count + i, -(i % 60) * 60000).slice(0, 19).replace('T', ' '),\n      healthy: Math.round(healthy + (1 - frac) * 2),\n      degraded: Math.round(degraded + frac * 4),\n      down: Math.round(down + frac * 0.4),\n    })\n  }\n  return out\n}

export function buildServiceHistory(_service: string, range: HistoryRange): ServiceHistory {\n  const count = range === '30d' ? 30 : range === '7d' ? 7 : range === '24h' ? 24 : 6\n  return {\n    service: 'platform',\n    range,\n    metrics: [\n      {\n        name: 'Requests',\n        unit: 'req/s',\n        values: ramp(count, 820, 800, 760),\n      },\n      {\n        name: 'Latency p95',\n        unit: 'ms',\n        values: ramp(count, 180, 220, 340).map((p) => ({ ...p, healthy: 180 + Math.round(Math.random() * 20), degraded: 220 + Math.round(Math.random() * 30), down: 340 + Math.round(Math.random() * 50) })),\n      },\n      {\n        name: 'Errors',\n        unit: 'err/s',\n        values: ramp(count, 0, 2, 9).map((p) => ({ ...p, healthy: 0, degraded: 2 + Math.round(Math.random() * 2), down: 9 + Math.round(Math.random() * 3) })),\n      },\n    ],\n  }\n}

export function buildObservabilityIncidents(): ObservabilityIncident[] {\n  return [\n    {\n      id: 'inc-1',\n      title: 'Elevated 5xx rate on api.west',\n      status: 'open',\n      severity: 'high',\n      source: 'sentry',\n      service: 'api',\n      startedAt: isoNow(-2, -7200000),\n      updatedAt: isoNow(-1, -3600000),\n      message: '5xx rate exceeded 1% for 5 minutes.',\n      assignment: { assignedTo: 'ops-oncall', notified: true },\n    },\n    {\n      id: 'inc-2',\n      title: 'DB connection pool exhaustion',\n      status: 'investigating',\n      severity: 'critical',\n      source: 'prometheus',\n      service: 'db',\n      startedAt: isoNow(-6, -1800000),\n      updatedAt: isoNow(-1, -1200000),\n      message: 'DB connections sustained above 90% of pool size.',\n      assignment: { assignedTo: 'dba-oncall', notified: true },\n    },\n    {\n      id: 'inc-3',\n      title: 'Billing worker backlog growing',\n      status: 'closed',\n      severity: 'medium',\n      source: 'opentelemetry',\n      service: 'worker',\n      startedAt: isoNow(-12, -4200000),\n      updatedAt: isoNow(-10, -3600000),\n      message: 'Backlog cleared after autoscaling trigger.',\n      assignment: { assignedTo: 'platform-oncall', notified: true },\n    },\n  ]\n}

export function buildObservabilitySources(): PlatformMetric[] {\n  return [\n    { category: 'Sentry', metric: '5xx rate', series: Array.from({ length: 6 }, (_, i) => ({ time: daysAgo(5 - i, true).slice(0, 19).replace('T', ' '), value: 0.2 + i * 0.15 })) },\n    { category: 'Prometheus', metric: 'DB connections', series: Array.from({ length: 6 }, (_, i) => ({ time: daysAgo(5 - i, true).slice(0, 19).replace('T', ' '), value: 120 + i * 25 })) },\n    { category: 'OpenTelemetry', metric: 'Worker queue depth', series: Array.from({ length: 6 }, (_, i) => ({ time: daysAgo(5 - i, true).slice(0, 19).replace('T', ' '), value: 400 + i * 80 })) },\n  ]\n}

// ------------------------------------------------------------------
// Emails
// ------------------------------------------------------------------

export function buildEmails(seed = 'emails'): EmailMessage[] {\n  const types: EmailBodyType[] = ['text', 'html', 'text', 'html']\n  const statuses: EmailMessage['status'][] = ['sent', 'delivered', 'delivered', 'failed', 'bounced', 'sent']\n  const subjects = [\n    'Q4 product update is live',\n    'Maintenance window this Saturday',\n    'Your invoice is ready',\n    'New team invite: Rayern Studio',\n    'Welcome to Rayern — next steps',\n    'Survey: help us improve onboarding',\n  ]\n  const messages = [\n    'Hi team, the Q4 update shipped today. Highlights: dark mode, bulk actions, and faster exports.',\n    'We will perform scheduled maintenance on Saturday 02:00–04:00 UTC. Expect brief downtime.',\n    'Your latest invoice is attached. Let us know if anything looks off.',\n    'Someone invited you to collaborate on Rayern Studio. Accept the invite in your dashboard.',\n    'Welcome aboard! Here are a few steps to get the most out of your account.',\n    'We would love your feedback on the new onboarding flow. It takes about 2 minutes.',\n  ]\n  return Array.from({ length: 12 }, (_, i) => {\n    const type = i % 4 === 0 ? 'update' : i % 4 === 1 ? 'announcement' : i % 4 === 2 ? 'promotion' : 'notice'\n    const bodyType = types[i % types.length]\n    const status = statuses[i % statuses.length]\n    return {\n      id: `email-${i + 1}`,\n      resendId: `re_${uid('resend-' + i)}`,\n      type: type as EmailMessage['type'],\n      bodyType,\n      from: 'no-reply@rayern.com.ng',\n      to: [`user${(i % 6) + 1}@rayern.com.ng`],\n      cc: i % 3 === 0 ? ['ops@rayern.com.ng'] : [],\n      bcc: i % 5 === 0 ? ['audit@rayern.com.ng'] : [],\n      subject: subjects[i % subjects.length],\n      message: messages[i % messages.length],\n      status,\n      sentAt: isoNow(-i, -(i % 86400) * 1000),\n      error: status === 'failed' || status === 'bounced' ? 'Temporary provider issue; will retry.' : undefined,\n    }\n  })\n}

export function buildEmailStats(emails: EmailMessage[]): EmailStats {\n  const totalSent = emails.length\n  const delivered = emails.filter((e) => e.status === 'delivered' || e.status === 'sent').length\n  const failed = emails.filter((e) => e.status === 'failed').length\n  const bounced = emails.filter((e) => e.status === 'bounced').length\n  const byType: Record<string, number> = {}\n  for (const e of emails) {\n    byType[e.type] = (byType[e.type] ?? 0) + 1\n  }\n  const daily: { date: string; sent: number; failed: number }[] = []\n  for (let d = 29; d >= 0; d--) {\n    const date = daysAgo(d)\n    const sent = Math.max(0, Math.round(3 + Math.random() * 8))\n    const fail = Math.round(sent * (Math.random() * 0.1))\n    daily.push({ date, sent, failed: fail })\n  }\n  return {\n    totalSent,\n    delivered,\n    failed,\n    bounced,\n    byType: Object.entries(byType).map(([type, count]) => ({ type: type as EmailStats['byType'][0]['type'], count })),\n    daily,\n  }\n}

export function buildEmailUsage(): EmailUsage {\n  const monthLimit = 5000\n  const monthUsed = 3872\n  const dayLimit = 250\n  const dayUsed = 178\n  return {\n    month: {\n      used: monthUsed,\n      remaining: monthLimit - monthUsed,\n      limit: monthLimit,\n      usedPct: monthUsed / monthLimit,\n    },\n    day: {\n      used: dayUsed,\n      remaining: dayLimit - dayUsed,\n      limit: dayLimit,\n      usedPct: dayUsed / dayLimit,\n    },\n    limits: { monthly: monthLimit, daily: dayLimit },\n    lastReconciledAt: today + 'T12:00:00Z',\n  }\n}

export function buildSentEmail({ subject, to, cc, bcc, bodyType }: { subject: string; to: string[]; cc?: string[]; bcc?: string[]; bodyType: EmailBodyType }): EmailMessage {\n  return {\n    id: uid('sent'),\n    resendId: `re_${uid('sent-' + Date.now())}`,\n    type: 'update',\n    bodyType,\n    from: 'no-reply@rayern.com.ng',\n    to: to || ['user1@rayern.com.ng'],\n    cc: cc ?? [],\n    bcc: bcc ?? [],\n    subject: subject || 'New message',\n    message: 'This is a preview of the sent email.',\n    status: 'queued',\n    sentAt: isoNow(0, 0),\n  }\n}

// ------------------------------------------------------------------
// Marketing
// ------------------------------------------------------------------

export function buildCampaigns(): MarketingCampaign[] {\n  return [\n    { id: 'mc-1', name: 'Q4 launch announcement', channel: 'email', state: 'active', audience: 'all-users', scheduledAt: daysAgo(2, true), createdBy: 'Ada Lovelace', createdAt: daysAgo(5, true) },\n    { id: 'mc-2', name: 'Onboarding drip day 3', channel: 'email', state: 'active', audience: 'new-users', scheduledAt: daysAgo(1, true), createdBy: 'Grace Hopper', createdAt: daysAgo(4, true) },\n    { id: 'mc-3', name: 'Beta feedback request', channel: 'in-app', state: 'draft', audience: 'beta-users', createdBy: 'Margaret Hamilton', createdAt: daysAgo(2, true) },\n    { id: 'mc-4', name: 'US blackout window', channel: 'email', state: 'failed', audience: 'us-users', scheduledAt: daysAgo(7, true), createdBy: 'Annie Easley', createdAt: daysAgo(9, true) },\n    { id: 'mc-5', name: 'Security advisory', channel: 'email', state: 'completed', audience: 'all-users', scheduledAt: daysAgo(14, true), sentAt: daysAgo(13, true), createdBy: 'Katherine Johnson', createdAt: daysAgo(16, true) },\n  ]\n}

export function buildEvents(): MarketingEvent[] {\n  return [\n    { id: 'ev-1', event: 'survey_response', platform: 'web', users: 214, createdAt: daysAgo(2, true) },\n    { id: 'ev-2', event: 'feature_adopted', platform: 'ios', users: 89, createdAt: daysAgo(2, true) },\n    { id: 'ev-3', event: 'feature_adopted', platform: 'android', users: 54, createdAt: daysAgo(3, true) },\n    { id: 'ev-4', event: 'campaign_sent', platform: 'web', users: 4120, createdAt: daysAgo(1, true) },\n  ]\n}

export function buildStats(campaigns: MarketingCampaign[]): MarketingStats {\n  const byChannel: Record<string, number> = { email: 0, 'in-app': 0, sms: 0 }\n  for (const c of campaigns) byChannel[c.channel] = (byChannel[c.channel] ?? 0) + 1\n  return {\n    totalCampaigns: campaigns.length,\n    activeCampaigns: campaigns.filter((c) => c.state === 'active').length,\n    completedCampaigns: campaigns.filter((c) => c.state === 'completed').length,\n    failedCampaigns: campaigns.filter((c) => c.state === 'failed').length,\n    byChannel: Object.entries(byChannel).map(([channel, count]) => ({ channel: channel as MarketingCampaign['channel'], count })),\n  }\n}

// ------------------------------------------------------------------
// Audit
// ------------------------------------------------------------------

export function buildAuditRows(): AuditRow[] {\n  return [\n    { id: 'au-1', timestamp: daysAgo(2, true), actor: 'Ada Lovelace', actorEmail: 'ada@rayern.com.ng', action: 'workspace.create', entity: 'Workspace', entityId: 'ws-1', description: 'Created workspace Alpha Inc.' },\n    { id: 'au-2', timestamp: daysAgo(2, true), actor: 'Grace Hopper', actorEmail: 'grace@rayern.com.ng', action: 'user.invite', entity: 'User', entityId: 'user-2', description: 'Invited user Grace Hopper to Alpha Inc.' },\n    { id: 'au-3', timestamp: daysAgo(1, true), actor: 'Margaret Hamilton', actorEmail: 'margaret@rayern.com.ng', action: 'billing.upgrade', entity: 'Subscription', entityId: 'sub-1', description: 'Upgraded Alpha Inc. to Studio plan' },\n    { id: 'au-4', timestamp: daysAgo(1, true), actor: 'Annie Easley', actorEmail: 'annie@rayern.com.ng', action: 'workspace.archive', entity: 'Workspace', entityId: 'ws-3', description: 'Archived workspace Gamma Co.' },\n    { id: 'au-5', timestamp: daysAgo(0, true), actor: 'Katherine Johnson', actorEmail: 'katherine@rayern.com.ng', action: 'user.reset-password', entity: 'User', entityId: 'user-4', description: 'Password reset for Annie Easley' },\n  ]\n}

export function buildAuditStats(rows: AuditRow[]): { totalEvents: number; byAction: { action: string; count: number }[] } {\n  const map: Record<string, number> = {}\n  for (const r of rows) {\n    map[r.action] = (map[r.action] ?? 0) + 1\n  }\n  return {\n    totalEvents: rows.length,\n    byAction: Object.entries(map).map(([action, count]) => ({ action, count })),\n  }\n}

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

export function buildErrorGroups(): Array<{\n  id: string\n  message: string\n  status: 'open' | 'closed'\n  count: number\n  firstSeenAt: string\n  lastSeenAt: string\n  stacktraceFileId?: string\n}> {\n  return [\n    { id: 'grp-1', message: 'TypeError: Cannot read properties of undefined (reading \'id\')', status: 'open', count: 14, firstSeenAt: daysAgo(1, true), lastSeenAt: daysAgo(0, true), stacktraceFileId: 'st-1' },\n    { id: 'grp-2', message: 'POST /api/workspaces 500 (timeout)', status: 'open', count: 7, firstSeenAt: daysAgo(2, true), lastSeenAt: daysAgo(0, true) },\n    { id: 'grp-3', message: 'Unhandled promise rejection: ECONNREFUSED', status: 'closed', count: 3, firstSeenAt: daysAgo(4, true), lastSeenAt: daysAgo(3, true), stacktraceFileId: 'st-3' },\n  ]\n}

export function buildErrorTimeline(): Array<{\n  groupId: string\n  level: string\n  message: string\n  count?: number\n  at: string\n}> {\n  return [\n    { groupId: 'grp-1', level: 'error', message: 'TypeError: Cannot read properties of undefined', count: 9, at: daysAgo(1, true) },\n    { groupId: 'grp-1', level: 'error', message: 'TypeError: Cannot read properties of undefined', count: 5, at: daysAgo(0, true) },\n    { groupId: 'grp-2', level: 'error', message: 'POST /api/workspaces 500', count: 7, at: daysAgo(0, true) },\n  ]\n}

// ------------------------------------------------------------------
// Platform metrics
// ------------------------------------------------------------------

export function buildMetrics(): PlatformMetric[] {\n  return [\n    {\n      category: 'Usage',\n      metric: 'Active workspaces',\n      series: Array.from({ length: 30 }, (_, i) => ({ time: daysAgo(29 - i), value: 380 + i * 2 })),\n    },\n    {\n      category: 'Usage',\n      metric: 'Seat utilization',\n      series: Array.from({ length: 30 }, (_, i) => ({ time: daysAgo(29 - i), value: 72 + Math.round(3 * Math.sin(i / 4)) })),\n    },\n    {\n      category: 'Billing',\n      metric: 'MRR',\n      series: Array.from({ length: 30 }, (_, i) => ({ time: daysAgo(29 - i), value: 42000 + i * 400 })),\n    },\n    {\n      category: 'Billing',\n      metric: 'Overage seats',\n      series: Array.from({ length: 30 }, (_, i) => ({ time: daysAgo(29 - i), value: 12 + Math.round(Math.random() * 4) })),\n    },\n    {\n      category: 'Platform',\n      metric: 'API latency p95',\n      series: Array.from({ length: 30 }, (_, i) => ({ time: daysAgo(29 - i), value: 140 + Math.round(Math.random() * 40) })),\n    },\n    {\n      category: 'Platform',\n      metric: 'Error rate',\n      series: Array.from({ length: 30 }, (_, i) => ({ time: daysAgo(29 - i), value: 0.12 + Math.random() * 0.08 })),\n    },\n  ]\n}

// ------------------------------------------------------------------
// Billing
// ------------------------------------------------------------------

export function buildBilling(): {\n  currency: string\n  country: string\n  locale: string\n  amount: number\n} {\n  return { currency: 'USD', country: 'US', locale: 'en-US', amount: 1234 }\n}

export function buildBillingEstimates(currentPeriod: string): BillingEstimate[] {\n  return [\n    {\n      tier: currentPeriod === '2025-Q1' ? 'desk' : 'studio',\n      period: currentPeriod as BillingEstimate['period'],\n      seats: 8,\n      billedSeats: 8,\n      estimateInCurrency: 8000,\n      estimateInUsd: 8000,\n    },\n    {\n      tier: currentPeriod === '2025-Q2' ? 'studio' : 'studio-plus',\n      period: currentPeriod as BillingEstimate['period'],\n      seats: 12,\n      billedSeats: 12,\n      estimateInCurrency: 14400,\n      estimateInUsd: 14400,\n    },\n    {\n      tier: currentPeriod === '2025-Q3' ? 'studio-plus' : 'desk',\n      period: currentPeriod as BillingEstimate['period'],\n      seats: 5,\n      billedSeats: 5,\n      estimateInCurrency: 4200,\n      estimateInUsd: 4200,\n    },\n  ]\n}

// ------------------------------------------------------------------
// Shared date helpers re-exported for demo consistency
// ------------------------------------------------------------------

export { daysAgo, isoNow, today }
