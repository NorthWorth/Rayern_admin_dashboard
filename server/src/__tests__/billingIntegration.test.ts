import { describe, it, expect, vi } from 'vitest'
import { billingService } from '../billingService'
import { readSyncedAggregates } from '../rayernSync'

vi.mock('../rayernSync', () => ({
  readSyncedAggregates: vi.fn(),
}))

import { readSyncedAggregates } from '../rayernSync'

describe('billingService consumes Rayern sync data', () => {
  it('returns null when no billing block has been synchronized', async () => {
    vi.mocked(readSyncedAggregates).mockResolvedValue({
      accounts: {
        totalAccounts: 123,
        newAccounts30d: 12,
        verifiedAccounts: 100,
        unverifiedAccounts: 23,
        deletedAccounts30d: null,
        deletionRequestsPending: null,
        registrationsTrend: [],
        planBreakdown: [],
      },
      workspaces: null,
      billing: null,
      services: [],
      telemetry: {},
      syncedAt: null,
    })

    expect(await billingService.hasBillingData()).toBe(false)
    expect(await billingService.current()).toBeNull()
  })

  it('returns the billing block when it has been synchronized', async () => {
    vi.mocked(readSyncedAggregates).mockResolvedValue({
      accounts: {
        totalAccounts: 123,
        newAccounts30d: 12,
        verifiedAccounts: 100,
        unverifiedAccounts: 23,
        deletedAccounts30d: null,
        deletionRequestsPending: null,
        registrationsTrend: [],
        planBreakdown: [],
      },
      workspaces: null,
      billing: {
        currency: 'USD',
        amountUnit: 'minor_units',
        generatedAt: '2026-10-22T12:00:00.000Z',
        activePaidSubscribers: 14,
        freeUsers: 109,
        totalAccounts: 123,
        mrr: { amountMinor: 41320, amountMajor: 413.2, byPlan: [] },
        arr: { amountMinor: 495840, amountMajor: 4958.4, definition: 'mrr_x_12' },
        planBreakdown: [
          { plan: 'pro', userCount: 10, subscriptionCount: 10, isPaid: true },
          { plan: 'starter', userCount: 109, subscriptionCount: 0, isPaid: false },
        ],
        definitions: { mrr: 'highest plan per qualifying user', arr: 'mrr x 12' },
      },
      services: [],
      telemetry: {},
      syncedAt: '2026-10-22T12:00:00.000Z',
    })

    expect(await billingService.hasBillingData()).toBe(true)
    const current = await billingService.current()
    expect(current).not.toBeNull()
    expect(current!.currency).toBe('USD')
    expect(current!.activePaidSubscribers).toBe(14)
    expect(current!.mrr.amountMajor).toBe(413.2)
    expect(current!.arr.definition).toBe('mrr_x_12')
  })
})
