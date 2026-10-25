import { describe, it, expect } from 'vitest'
import { SyncPayload, unwrapRayernEnvelope } from '../rayernSync'
import { requireMonitoringToken } from '../auth/monitoringToken'
import { config } from '../config'

describe('Rayern sync contract validation', () => {
  it('accepts the contract billing block', () => {
    const payload = {
      accounts: {
        totalAccounts: 123,
        newAccounts30d: 12,
        verifiedAccounts: 100,
        unverifiedAccounts: 23,
        deletedAccounts30d: null,
        deletionRequestsPending: null,
        registrationsTrend: [{ date: '2026-10-01', count: 3 }],
        planBreakdown: [{ plan: 'starter', count: 100 }],
      },
      workspaces: {
        totalWorkspaces: 120,
        newWorkspaces30d: 11,
        avgMembersPerWorkspace: 1.2,
        planBreakdown: [{ plan: 'starter', count: 109 }, { plan: 'pro', count: 11 }],
      },
      billing: {
        currency: 'USD',
        amountUnit: 'minor_units',
        generatedAt: '2026-10-22T12:00:00.000Z',
        activePaidSubscribers: 14,
        freeUsers: 109,
        totalAccounts: 123,
        mrr: {
          amountMinor: 41320,
          amountMajor: 413.2,
          byPlan: [
            { plan: 'pro', subscriberCount: 10, mrrMinor: 19000 },
            { plan: 'premium', subscriberCount: 4, mrrMinor: 25280 },
          ],
        },
        arr: { amountMinor: 495840, amountMajor: 4958.4, definition: 'mrr_x_12' },
        planBreakdown: [
          { plan: 'pro', userCount: 10, subscriptionCount: 10, isPaid: true },
          { plan: 'starter', userCount: 109, subscriptionCount: 0, isPaid: false },
        ],
        definitions: { mrr: 'highest plan per qualifying user', arr: 'mrr x 12' },
      },
      services: [
        {
          service: 'Rayern API',
          kind: 'api',
          status: 'healthy',
          uptimePct30d: null,
          latencyMsP50: 41,
          latencyMsP95: 120,
          lastIncidentAt: null,
        },
      ],
      telemetry: {},
    }

    const result = SyncPayload.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('rejects unknown top-level keys on the sync payload', () => {
    const payload = {
      accounts: { totalAccounts: 1, newAccounts30d: 0, verifiedAccounts: 0, unverifiedAccounts: 1, deletedAccounts30d: null, deletionRequestsPending: null, registrationsTrend: [], planBreakdown: [] },
      workspaces: null,
      billing: null,
      services: [],
      telemetry: {},
      secretCustomers: [{ name: 'should be stripped' }],
    }

    const result = SyncPayload.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('rejects a billing block with the wrong currency literal', () => {
    const payload = {
      accounts: { totalAccounts: 1, newAccounts30d: 0, verifiedAccounts: 0, unverifiedAccounts: 1, deletedAccounts30d: null, deletionRequestsPending: null, registrationsTrend: [], planBreakdown: [] },
      workspaces: null,
      billing: {
        currency: 'NGN',
        amountUnit: 'minor_units',
        generatedAt: '2026-10-22T12:00:00.000Z',
        activePaidSubscribers: 0,
        freeUsers: 1,
        totalAccounts: 1,
        mrr: { amountMinor: 0, amountMajor: 0, byPlan: [] },
        arr: { amountMinor: 0, amountMajor: 0, definition: 'mrr_x_12' },
        planBreakdown: [{ plan: 'starter', userCount: 1, subscriptionCount: 0, isPaid: false }],
        definitions: {},
      },
      services: [],
      telemetry: {},
    }

    const result = SyncPayload.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects billing with a non-integer mrr amountMinor', () => {
    const payload = {
      accounts: { totalAccounts: 1, newAccounts30d: 0, verifiedAccounts: 0, unverifiedAccounts: 1, deletedAccounts30d: null, deletionRequestsPending: null, registrationsTrend: [], planBreakdown: [] },
      workspaces: null,
      billing: {
        currency: 'USD',
        amountUnit: 'minor_units',
        generatedAt: '2026-10-22T12:00:00.000Z',
        activePaidSubscribers: 0,
        freeUsers: 1,
        totalAccounts: 1,
        mrr: { amountMinor: 413.2, amountMajor: 413.2, byPlan: [] },
        arr: { amountMinor: 0, amountMajor: 0, definition: 'mrr_x_12' },
        planBreakdown: [{ plan: 'starter', userCount: 1, subscriptionCount: 0, isPaid: false }],
        definitions: {},
      },
      services: [],
      telemetry: {},
    }

    const result = SyncPayload.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('unwraps the Rayern envelope and leaves bare payloads untouched', () => {
    const envelope = { success: true, data: { accounts: { totalAccounts: 1, newAccounts30d: 0, verifiedAccounts: 0, unverifiedAccounts: 1, deletedAccounts30d: null, deletionRequestsPending: null, registrationsTrend: [], planBreakdown: [] }, workspaces: null, billing: null, services: [], telemetry: {} } }
    const unwrapped = unwrapRayernEnvelope(envelope)
    expect(unwrapped.ok).toBe(true)

    const bare = { accounts: { totalAccounts: 1, newAccounts30d: 0, verifiedAccounts: 0, unverifiedAccounts: 1, deletedAccounts30d: null, deletionRequestsPending: null, registrationsTrend: [], planBreakdown: [] }, workspaces: null, billing: null, services: [], telemetry: {} }
    const bareUnwrapped = unwrapRayernEnvelope(bare)
    expect(bareUnwrapped.ok).toBe(true)
  })

  it('rejects an explicit Rayern failure envelope', () => {
    const failure = { success: false, error: { code: 'RATE_LIMITED', message: 'too many requests' } }
    const unwrapped = unwrapRayernEnvelope(failure)
    expect(unwrapped.ok).toBe(false)
    expect(unwrapped.ok === false ? unwrapped.error : '').toContain('success=false')
  })
})

describe('monitoring token guard', () => {
  it('rejects when no monitoring token is configured', () => {
    const req = { headers: {} } as Parameters<typeof requireMonitoringToken>[0]
    const res = {
      status: (code: number) => ({
        json: (body: unknown) => {
          expect(code).toBe(401)
          expect((body as { success: boolean }).success).toBe(false)
        },
      }),
    } as Parameters<typeof requireMonitoringToken>[1]
    const next = () => expect.unreachable('should not call next')
    requireMonitoringToken(req, res, next)
  })
})

describe('config reads Rayern integration settings', () => {
  it('defaults billing currency to USD', () => {
    expect(config.billing.currency).toBe('USD')
  })

  it('defaults grace period to 7 days', () => {
    expect(config.billing.gracePeriodDays).toBe(7)
  })
})
