import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// Force the real-backend path (demo mode off) while keeping every other
// lib/api export intact.
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, USE_DEMO_DATA: false, adminMetrics: vi.fn() }
})

import { adminMetrics } from '../lib/api'
import { revenueService } from '../services/revenue'
import { RevenuePage } from '../pages/Revenue'
import type { AdminMetricBilling, AdminMetricResponse } from '../lib/types'

const BILLING: AdminMetricBilling = {
  currency: 'USD',
  amountUnit: 'minor_units',
  generatedAt: '2026-10-22T12:00:00.000Z',
  activePaidSubscribers: 14,
  freeUsers: 109,
  totalAccounts: 123,
  // amountMajor is deliberately NOT amountMinor / 100: the page must render
  // Rayern's reported major value and never recalculate it from minor units.
  mrr: {
    amountMinor: 999,
    amountMajor: 12.34,
    byPlan: [
      { plan: 'pro', subscriberCount: 10, mrrMinor: 19000 },
      { plan: 'premium', subscriberCount: 4, mrrMinor: 25280 },
    ],
  },
  arr: { amountMinor: 14808, amountMajor: 148.08, definition: 'mrr_x_12' },
  planBreakdown: [
    { plan: 'pro', userCount: 10, subscriptionCount: 10, isPaid: true },
    { plan: 'starter', userCount: 109, subscriptionCount: 0, isPaid: false },
  ],
  definitions: { mrr: 'highest plan per qualifying user', arr: 'mrr x 12' },
}

function metricsPayload(billing: AdminMetricBilling | null): AdminMetricResponse {
  return {
    success: true,
    data: {
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
      workspaces: { totalWorkspaces: 120, newWorkspaces30d: 11, avgMembersPerWorkspace: 1.2 },
      billing,
      services: [],
      telemetry: {},
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('revenueService — Rayern billing contract states', () => {
  test('returns the billing block exactly as reported by Rayern', async () => {
    vi.mocked(adminMetrics).mockResolvedValue(metricsPayload(BILLING))

    const state = await revenueService.state()
    expect(state).toEqual({ kind: 'populated', billing: BILLING, syncedAt: null })
  })

  test('reports unavailable when no billing block has been synchronized', async () => {
    vi.mocked(adminMetrics).mockResolvedValue(metricsPayload(null))

    expect(await revenueService.state()).toEqual({ kind: 'unavailable' })
  })

  test('reports an error when the metrics envelope fails', async () => {
    vi.mocked(adminMetrics).mockResolvedValue({
      success: false,
      error: { code: 'ADMIN_ACCESS_REQUIRED', message: 'Admin access required' },
    } as AdminMetricResponse)

    expect(await revenueService.state()).toEqual({ kind: 'error', message: 'Admin access required' })
  })

  test('reports an error when the request fails', async () => {
    vi.mocked(adminMetrics).mockRejectedValue(new Error('network down'))

    expect(await revenueService.state()).toEqual({ kind: 'error', message: 'network down' })
  })
})

describe('RevenuePage rendering', () => {
  test('shows the loading state until data arrives', async () => {
    vi.mocked(adminMetrics).mockReturnValue(new Promise(() => {}))

    render(<RevenuePage />)
    expect(screen.queryByText('MRR')).not.toBeInTheDocument()
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument()
  })

  test('renders MRR, ARR, subscribers, free users and plan breakdown from API data', async () => {
    vi.mocked(adminMetrics).mockResolvedValue(metricsPayload(BILLING))

    render(<RevenuePage />)

    await waitFor(() => expect(screen.getByText('USD12.34')).toBeInTheDocument())
    expect(screen.getByText('USD148.08')).toBeInTheDocument()
    expect(screen.getByText('14')).toBeInTheDocument()
    expect(screen.getByText('109')).toBeInTheDocument()
    // Currency and freshness come straight from the payload.
    expect(screen.getByText('USD')).toBeInTheDocument()
    expect(screen.getAllByText(/Oct 22/).length).toBeGreaterThan(0)
    // MRR-by-plan rows (plan badges appear in both breakdowns)
    expect(screen.getAllByText('pro').length).toBeGreaterThan(0)
    expect(screen.getByText('10 subscribers')).toBeInTheDocument()
    expect(screen.getByText('premium')).toBeInTheDocument()
    // Plan breakdown shows users and subscription documents
    expect(screen.getByText('10 users')).toBeInTheDocument()
    expect(screen.getByText('10 subscriptions')).toBeInTheDocument()
    expect(screen.getByText('0 subscriptions')).toBeInTheDocument()
  })

  test('never recalculates MRR/ARR from minor units', async () => {
    vi.mocked(adminMetrics).mockResolvedValue(metricsPayload(BILLING))

    render(<RevenuePage />)

    await waitFor(() => expect(screen.getByText('USD12.34')).toBeInTheDocument())
    // 999 minor units would display as USD9.99 if the client recalculated.
    expect(screen.queryByText('USD9.99')).not.toBeInTheDocument()
    // Minor units are shown as data, not used for arithmetic.
    expect(screen.getByText('999')).toBeInTheDocument()
    expect(screen.getByText('14,808')).toBeInTheDocument()
  })

  test('shows the unavailable state when the sync has no billing block', async () => {
    vi.mocked(adminMetrics).mockResolvedValue(metricsPayload(null))

    render(<RevenuePage />)

    await waitFor(() => expect(screen.getByText('Revenue metrics unavailable')).toBeInTheDocument())
    expect(screen.getByText(/No billing data has been synchronized from Rayern yet/)).toBeInTheDocument()
    expect(screen.queryByText('USD0.00')).not.toBeInTheDocument()
  })

  test('shows the error state with a retry control', async () => {
    vi.mocked(adminMetrics).mockResolvedValue({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    } as AdminMetricResponse)

    render(<RevenuePage />)

    await waitFor(() => expect(screen.getByText('Authentication required')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})
