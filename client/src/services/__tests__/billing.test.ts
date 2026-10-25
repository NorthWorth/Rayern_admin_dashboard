import { expect, test, vi, afterEach } from 'vitest'
import { billingService } from '../billing'
import { render, screen, waitFor } from '@testing-library/react'

afterEach(() => {
  vi.restoreAllMocks()
})

test('shows the loading state while billing data is fresh', () => {
  vi.spyOn(billingService, 'fetchBillingState').mockResolvedValue({
    status: 'loading' as const,
    lastSynced: null,
    generation: 0,
  })
  render(<BillingPage />)
  expect(screen.getByText(/refreshing billing data/i)).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
})

test('shows the empty state when no billing data is available', async () => {
  vi.spyOn(billingService, 'fetchBillingState').mockResolvedValue({
    status: 'empty' as const,
    lastSynced: null,
    generation: 0,
    cur: null,
  })
  render(<BillingPage />)
  await waitFor(() =>
    expect(screen.getByText(/no billing data/i)).toBeInTheDocument(),
  )
})

test('renders the populated billing shell', async () => {
  vi.spyOn(billingService, 'fetchBillingState').mockResolvedValue({
    status: 'ok' as const,
    lastSynced: '2026-10-22T12:00:00.000Z',
    generation: 1,
    cur: {
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
    },
  })
  render(<BillingPage />)
  await waitFor(() =>
    expect(screen.getByText(/active paid subscribers/i)).toBeInTheDocument(),
  )
  expect(screen.getByText('14')).toBeInTheDocument()
  expect(screen.getByText('USD')).toBeInTheDocument()
})
