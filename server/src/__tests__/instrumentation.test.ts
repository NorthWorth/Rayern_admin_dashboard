/**
 * Rayern instrumentation blocks → dashboard DTOs.
 *
 * The contract's core promise is honesty: missing data is never rendered as
 * zero, unknown is never rendered as healthy, and every percentage carries the
 * denominator it was computed from. These tests pin that behaviour down block
 * by block, including the backward-compatible case of an older payload that
 * carries none of the new blocks.
 */
import { describe, it, expect } from 'vitest'
import {
  pct,
  normalizeFunnel,
  normalizeClientErrors,
  normalizeEndpointHealth,
  normalizeDependencyConfig,
  normalizeSynthetic,
  normalizeProductAdoption,
  normalizeMarketingConsent,
  normalizeEngagement,
  normalizeInstrumentation,
} from '../instrumentation'

describe('pct — documented denominators', () => {
  it('computes and rounds a percentage', () => {
    expect(pct(1, 3)).toBe(33.3)
    expect(pct(50, 100)).toBe(50)
  })

  it('returns null for a zero denominator instead of Infinity/NaN/0%', () => {
    expect(pct(5, 0)).toBeNull()
    expect(pct(0, 0)).toBeNull()
    expect(pct(10, -1)).toBeNull()
  })

  it('returns null when either side is missing', () => {
    expect(pct(null, 10)).toBeNull()
    expect(pct(3, null)).toBeNull()
  })
})

describe('normalizeFunnel', () => {
  const full = normalizeFunnel({
    visits30d: 1000,
    signupIntents30d: 200,
    registrations30d: 150,
    activated30d: 90,
    attributedSignups30d: 30,
    hasVisitorData: true,
    daily: [
      { date: '2026-10-01', visits: 40, signupIntents: 8, registrations: 6, activated: 3 },
      { date: '2026-10-02', visits: null, registrations: null },
    ],
    topSources: [
      { source: 'google', count: 10 },
      { source: 'twitter', count: 30 },
    ],
  })

  it('computes each conversion rate with its documented denominator', () => {
    expect(full.conversion.visitToIntentPct).toBe(20) // 200 ÷ 1000
    expect(full.conversion.intentToRegistrationPct).toBe(75) // 150 ÷ 200
    expect(full.conversion.registrationToActivationPct).toBe(60) // 90 ÷ 150
    expect(full.conversion.visitToRegistrationPct).toBe(15) // 150 ÷ 1000
    expect(full.attributionCoveragePct).toBe(20) // 30 ÷ 150
  })

  it('keeps a day with no data as null, never as zero', () => {
    expect(full.daily[1]).toEqual({
      date: '2026-10-02',
      visits: null,
      signupIntents: null,
      registrations: null,
      activated: null,
    })
  })

  it('sorts acquisition sources by count descending', () => {
    expect(full.topSources.map((s) => s.source)).toEqual(['twitter', 'google'])
  })

  it('reports visitor metrics as null until the beacon exists', () => {
    const noVisitors = normalizeFunnel({
      hasVisitorData: false,
      signupIntents30d: 12,
      registrations30d: 8,
      activated30d: 3,
    })
    expect(noVisitors.hasVisitorData).toBe(false)
    expect(noVisitors.visits30d).toBeNull()
    // Visitor-dependent rates are unknown, not 0%.
    expect(noVisitors.conversion.visitToIntentPct).toBeNull()
    expect(noVisitors.conversion.visitToRegistrationPct).toBeNull()
    // Non-visitor rates still compute.
    expect(noVisitors.conversion.intentToRegistrationPct).toBe(66.7)
  })

  it('treats a genuine zero denominator as not computable', () => {
    const empty = normalizeFunnel({
      hasVisitorData: true,
      visits30d: 0,
      signupIntents30d: 0,
      registrations30d: 0,
      activated30d: 0,
    })
    expect(empty.visits30d).toBe(0) // Rayern really reported zero
    expect(empty.conversion.visitToIntentPct).toBeNull() // …but 0 ÷ 0 is not a rate
    expect(empty.conversion.registrationToActivationPct).toBeNull()
  })
})

describe('normalizeClientErrors', () => {
  it('parses the four reported categories and endpoint templates', () => {
    const dto = normalizeClientErrors({
      total: 17,
      byKind: [
        { kind: 'api_error', count: 9 },
        { kind: 'network_error', count: 4 },
        { kind: 'unexpected_response', count: 3 },
        { kind: 'config_error', count: 1 },
      ],
      topEndpoints: [
        { endpoint: '/api/v1/clients', count: 5 },
        { endpoint: '/api/v1/tasks/:id', count: 8 },
      ],
      lastOccurredAt: '2026-10-28T09:15:00.000Z',
    })
    expect(dto.total).toBe(17)
    expect(dto.byKind.map((k) => k.kind)).toEqual([
      'api_error',
      'network_error',
      'unexpected_response',
      'config_error',
    ])
    expect(dto.topEndpoints[0]).toEqual({ endpoint: '/api/v1/tasks/:id', count: 8 })
    expect(dto.lastOccurredAt).toBe('2026-10-28T09:15:00.000Z')
  })

  it('never invents a total from a partial breakdown', () => {
    const dto = normalizeClientErrors({ byKind: [{ kind: 'api_error', count: 4 }] })
    expect(dto.total).toBeNull()
  })
})

describe('normalizeEndpointHealth', () => {
  it('preserves the upstream unavailability reason and reports no routes', () => {
    const inactive = normalizeEndpointHealth({ available: false, reason: 'telemetry_inactive' })
    expect(inactive.available).toBe(false)
    expect(inactive.reason).toBe('telemetry_inactive')
    expect(inactive.routes).toEqual([])

    const thin = normalizeEndpointHealth({ available: false, reason: 'insufficient_samples' })
    expect(thin.available).toBe(false)
    expect(thin.reason).toBe('insufficient_samples')
  })

  it('keeps method/route identity, status classes and latency samples', () => {
    const dto = normalizeEndpointHealth({
      available: true,
      windowMinutes: 1440,
      routes: [
        {
          key: 'GET /users/:id',
          requests: 40,
          byStatus: { '200': 38, '404': 2 },
          p50: 12,
          p95: 80,
          samples: 40,
        },
        { key: 'POST /clients', requests: 6, status5xx: 1, p50: null, p95: null, samples: 0 },
        { key: 'UNMATCHED', requests: 5 },
      ],
    })

    expect(dto.available).toBe(true)
    expect(dto.reason).toBeNull()
    expect(dto.windowMinutes).toBe(1440)

    const users = dto.routes[0]
    expect(users.method).toBe('GET')
    expect(users.route).toBe('/users/:id')
    expect(users.ok2xx).toBe(38)
    expect(users.err4xx).toBe(2)
    expect(users.err5xx).toBe(0)
    expect(users.p50Ms).toBe(12)
    expect(users.p95Ms).toBe(80)

    // No latency samples → nulls, never a fake 0ms.
    expect(dto.routes[1].p50Ms).toBeNull()
    expect(dto.routes[1].p95Ms).toBeNull()
    expect(dto.routes[1].err5xx).toBe(1)

    // Unmatched paths stay visible for diagnostics.
    expect(dto.routes[2].unmatched).toBe(true)
    expect(dto.routes[0].unmatched).toBe(false)
  })

  it('reports an empty route set as unavailable rather than healthy', () => {
    const dto = normalizeEndpointHealth({ routes: [] })
    expect(dto.available).toBe(false)
    expect(dto.reason).toBe('not_reported')
  })
})

describe('normalizeDependencyConfig', () => {
  it('reads presence booleans only, with adjacent non-secret detail', () => {
    const dto = normalizeDependencyConfig({
      email: { resend: true, emailjs: false },
      billing: { paystack: true, currency: 'NGN' },
      storage: { cloudinary: false, mode: 'unsigned' },
      telemetry: { enabled: true, active: false },
    })

    expect(dto.available).toBe(true)
    const find = (label: string) => dto.items.find((i) => i.label === label)
    expect(find('Resend configured')?.configured).toBe(true)
    expect(find('EmailJS configured')?.configured).toBe(false)
    expect(find('Paystack configured')?.detail).toBe('NGN')
    expect(find('Cloudinary configured')?.detail).toBe('unsigned')
    expect(find('Telemetry active')?.configured).toBe(false)
  })

  it('distinguishes an unreported flag from a false one', () => {
    const dto = normalizeDependencyConfig({ email: { resend: true } })
    const waitlist = dto.items.find((i) => i.label === 'Waitlist proxy configured')
    expect(waitlist?.configured).toBeNull() // unknown, NOT "not configured"
    expect(dto.available).toBe(true)
  })

  it('reports an all-null block as unavailable', () => {
    const dto = normalizeDependencyConfig({})
    expect(dto.available).toBe(false)
    expect(dto.items.every((i) => i.configured === null)).toBe(true)
  })
})

describe('normalizeSynthetic', () => {
  it('treats "no checks run" as unavailable, never as healthy', () => {
    const dto = normalizeSynthetic({ available: false, reason: 'no_checks_run', checks: [] })
    expect(dto.available).toBe(false)
    expect(dto.reason).toBe('no_checks_run')
    expect(dto.checks).toEqual([])
  })

  it('exposes per-check status, latency and recovery information', () => {
    const dto = normalizeSynthetic({
      checks: [
        {
          name: 'api_health',
          status: 'up',
          httpStatus: 200,
          latencyMs: 90,
          consecutiveFailures: 0,
          lastSuccessAt: '2026-10-28T06:00:00.000Z',
        },
        {
          name: 'internal_metrics_fails_closed',
          status: 'down',
          httpStatus: 500,
          reason: 'unexpected_status',
          consecutiveFailures: 3,
          lastRecoveredAt: '2026-10-27T11:00:00.000Z',
        },
      ],
      lastCheckedAt: '2026-10-28T06:00:00.000Z',
      lastSuccessfulCheckAt: '2026-10-28T06:00:00.000Z',
    })

    expect(dto.available).toBe(true)
    expect(dto.reason).toBeNull()
    expect(dto.checks).toHaveLength(2)
    expect(dto.checks[1]).toMatchObject({
      status: 'down',
      consecutiveFailures: 3,
      reason: 'unexpected_status',
      lastRecoveredAt: '2026-10-27T11:00:00.000Z',
    })
    expect(dto.lastCheckedAt).toBe('2026-10-28T06:00:00.000Z')
  })
})

describe('normalizeProductAdoption', () => {
  it('preserves null completion for entities without a completion concept', () => {
    const dto = normalizeProductAdoption({
      clients: { total: 12, created30d: 3 },
      projects: { total: 9, created30d: 1, completed: 4 },
    })

    expect(dto.available).toBe(true)
    const clients = dto.modules.find((m) => m.module === 'clients')
    const projects = dto.modules.find((m) => m.module === 'projects')
    expect(clients).toMatchObject({ total: 12, created30d: 3, completed: null, completionReported: false })
    expect(projects).toMatchObject({ completed: 4, completionReported: true })
  })

  it('keeps a reported-but-null completion as null, not zero', () => {
    const dto = normalizeProductAdoption({
      modules: [{ module: 'tasks', total: 40, created30d: 7, completed: null }],
    })
    const tasks = dto.modules[0]
    expect(tasks.completed).toBeNull()
    expect(tasks.completionReported).toBe(true)
  })

  it('reports an empty adoption payload as unavailable', () => {
    expect(normalizeProductAdoption({}).available).toBe(false)
  })
})

describe('normalizeMarketingConsent', () => {
  it('accepts figures that reconcile and computes the opt-in share', () => {
    const dto = normalizeMarketingConsent({ totalRegisteredUsers: 10, optedIn: 6, optedOut: 4 })
    expect(dto.reconciles).toBe(true)
    expect(dto.optedInPct).toBe(60)
  })

  it('flags inconsistent figures without correcting them', () => {
    const dto = normalizeMarketingConsent({ totalRegisteredUsers: 10, optedIn: 6, optedOut: 3 })
    expect(dto.reconciles).toBe(false)
    // The reported numbers are passed through untouched.
    expect(dto.optedIn).toBe(6)
    expect(dto.optedOut).toBe(3)
    expect(dto.totalRegisteredUsers).toBe(10)
  })

  it('leaves the opt-in share null on an empty base', () => {
    const dto = normalizeMarketingConsent({ totalRegisteredUsers: 0, optedIn: 0, optedOut: 0 })
    expect(dto.reconciles).toBe(true)
    expect(dto.optedInPct).toBeNull()
  })
})

describe('normalizeEngagement', () => {
  it('reports "no activity data yet" instead of zero actives', () => {
    const dto = normalizeEngagement({ reason: 'no_activity_data_yet' })
    expect(dto.available).toBe(false)
    expect(dto.reason).toBe('no_activity_data_yet')
    expect(dto.dau).toBeNull()
    expect(dto.wau).toBeNull()
    expect(dto.mau).toBeNull()
  })

  it('keeps immature cohorts immature rather than 0% retained', () => {
    const dto = normalizeEngagement({
      dau: 5,
      wau: 20,
      mau: 60,
      dailyActiveUsers: [
        { date: '2026-10-27', count: 5 },
        { date: '2026-10-28', count: null },
      ],
      cohorts: [
        { weekStart: '2026-10-19', size: 10, retainedNextWeek: 4, retentionPct: 40 },
        { weekStart: '2026-10-26', size: 6, retainedNextWeek: null, retentionPct: null },
      ],
    })

    expect(dto.available).toBe(true)
    expect(dto.reason).toBeNull()
    expect(dto.dau).toBe(5)
    expect(dto.mau).toBe(60)
    expect(dto.dailyActiveUsers[1].count).toBeNull() // no gap day drawn as zero

    expect(dto.cohorts[0].mature).toBe(true)
    expect(dto.cohorts[1]).toMatchObject({ retainedNextWeek: null, retentionPct: null, mature: false })
  })
})

describe('normalizeInstrumentation', () => {
  it('maps an older payload with no instrumentation blocks to all-null blocks', () => {
    const dto = normalizeInstrumentation({})
    expect(dto).toEqual({
      funnel: null,
      clientErrors: null,
      endpointHealth: null,
      dependencyConfig: null,
      syntheticMonitoring: null,
      productAdoption: null,
      marketingConsent: null,
      engagement: null,
    })
  })

  it('treats an explicit upstream null (failed aggregation guard) as null', () => {
    const dto = normalizeInstrumentation({ funnel: null, engagement: null })
    expect(dto.funnel).toBeNull()
    expect(dto.engagement).toBeNull()
  })

  it('normalizes whichever blocks are present', () => {
    const dto = normalizeInstrumentation({
      funnel: { visits30d: 10, signupIntents30d: 2, registrations30d: 1, hasVisitorData: true },
      marketingConsent: { totalRegisteredUsers: 4, optedIn: 3, optedOut: 1 },
    })
    expect(dto.funnel?.visits30d).toBe(10)
    expect(dto.marketingConsent?.reconciles).toBe(true)
    expect(dto.clientErrors).toBeNull()
    expect(dto.productAdoption).toBeNull()
  })
})
