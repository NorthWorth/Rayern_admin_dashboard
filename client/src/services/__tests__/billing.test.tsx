import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { billingState, type BillingViewState } from '../../services/billing'
import type { AdminMetricBilling, AdminMetricResponse } from '../../lib/types'
import BillingPage from '../../pages/BillingPage'

vi.mock('../../lib/api', () => ({
  adminMetrics: vi.fn(),
  API_BASE: '',
}))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const POPULATED_BILLING: AdminMetricBilling = {
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
}

const POPULATED_PAYLOAD: AdminMetricResponse = {
  success: true,
  data: {
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
    workspaces: { totalWorkspaces: 120, newWorkspaces30d: 11, avgMembersPerWorkspace: 1.2 },
    billing: POPULATED_BILLING,
    services: [{ service: 'Rayern API', kind: 'api', status: 'healthy', uptimePct30d: null, latencyMsP50: 41, latencyMsP95: 120, lastIncidentAt: null }],
    telemetry: {},
  },
}

describe('billingState contract states', () => {
  test('returns the populated billing block from the admin-metrics endpoint', async () => {
    const { adminMetrics } = await import('../../lib/api')
    vi.mocked(adminMetrics).mockResolvedValue(POPULATED_PAYLOAD)

    const state = await billingState()
    expect(state).toEqual({ kind: 'populated', billing: POPULATED_BILLING })
  })

  test('returns unavailable when the response has no billing block', async () => {
    const { adminMetrics } = await import('../../lib/api')
    vi.mocked(adminMetrics).mockResolvedValue({
      success: true,
      data: {
        accounts: { totalAccounts: 123, newAccounts30d: 12, verifiedAccounts: 100, unverifiedAccounts: 23, deletedAccounts30d: null, deletionRequestsPending: null, registrationsTrend: [], planBreakdown: [] },
        workspaces: { totalWorkspaces: 120, newWorkspaces30d: 11, avgMembersPerWorkspace: 1.2 },
        billing: null,
        services: [],
        telemetry: {},
      },
    } as AdminMetricResponse)

    expect(await billingState()).toEqual({ kind: 'unavailable' })
  })

  test('returns error when the response reports failure', async () => {
    const { adminMetrics } = await import('../../lib/api')
    vi.mocked(adminMetrics).mockResolvedValue({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    } as AdminMetricResponse)

    expect(await billingState()).toEqual({ kind: 'error', message: 'Authentication required' })
  })

  test('returns error when the request throws', async () => {
    const { adminMetrics } = await import('../../lib/api')
    vi.mocked(adminMetrics).mockRejectedValue(new Error('network error'))

    expect(await billingState()).toEqual({ kind: 'error', message: 'network error' })
  })
})

describe('BillingPage renders contract states', () => {
  test('shows the loading state', async () => {
    render(<BillingPage />)
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.getByText(/Subscribed revenue/i)).toBeInTheDocument()
  })

  test('shows the error state with a retry control', async () => {
    const { adminMetrics } = await import('../../lib/api')
    vi.mocked(adminMetrics).mockResolvedValue({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    } as AdminMetricResponse)

    render(<BillingPage />)
    await waitFor(() => expect(screen.getByText(/Authentication required/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
  })

  test('shows the populated contract billing block', async () => {
    const { adminMetrics } = await import('../../lib/api')
    vi.mocked(adminMetrics).mockResolvedValue(POPULATED_PAYLOAD)

    render(<BillingPage />)
    await waitFor(() => expect(screen.getByText(/Active paid subscribers/i)).toBeInTheDocument())
    expect(screen.getByText('14')).toBeInTheDocument()
    expect(screen.getByText('USD')).toBeInTheDocument()
    expect(screen.getByText('mrr_x_12')).toBeInTheDocument()
    expect(screen.getByText('413.20')).toBeInTheDocument()
    expect(screen.getByText('4,958.40')).toBeInTheDocument()
  })
})
