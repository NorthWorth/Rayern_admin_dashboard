import { describe, expect, test, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, USE_DEMO_DATA: false }
})

vi.mock('../services/campaigns', () => ({
  campaignsService: {
    listUsers: vi.fn(),
    preview: vi.fn(),
    send: vi.fn(),
  },
}))

vi.mock('../services/emails', () => ({
  emailsService: {
    send: vi.fn(),
  },
}))

import { campaignsService } from '../services/campaigns'
import { emailsService } from '../services/emails'
import { CampaignComposer } from '../components/CampaignComposer'
import { ToastProvider } from '../components/ui/Toast'
import type { AdminUserFilters, AdminUsersPage, CampaignPreviewResponse, CampaignSendResponse } from '../lib/types'

const ADA = {
  id: 'u1',
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  accountStatus: 'active',
  marketingConsent: { optedIn: true, source: 'settings' },
  subscription: { plan: 'pro', status: 'active', billingInterval: 'monthly', hasPaidAccess: true },
}
const GRACE = {
  id: 'u2',
  email: 'grace@example.com',
  firstName: 'Grace',
  lastName: 'Hopper',
  accountStatus: 'active',
  marketingConsent: { optedIn: true, source: 'settings' },
  subscription: { plan: 'premium', status: 'active', billingInterval: 'annual', hasPaidAccess: true },
}
const ALAN = {
  id: 'u3',
  email: 'alan@example.com',
  firstName: 'Alan',
  lastName: 'Turing',
  accountStatus: 'active',
  marketingConsent: { optedIn: false, source: 'settings' },
  subscription: { plan: 'pro', status: 'canceled', billingInterval: 'monthly', hasPaidAccess: false },
}

/** Mirrors the server: the consent filter decides which rows are returned. */
function pageFor(filters: AdminUserFilters): AdminUsersPage {
  const all = [ADA, GRACE, ALAN]
  const users =
    filters.consent === 'opted_in'
      ? all.filter((u) => u.marketingConsent.optedIn)
      : filters.consent === 'opted_out'
        ? all.filter((u) => !u.marketingConsent.optedIn)
        : all
  return {
    pagination: { page: filters.page ?? 1, limit: filters.limit ?? 50, totalResults: users.length, totalPages: 1 },
    filters: { plan: null, subscriptionStatus: null, consent: filters.consent ?? null },
    currency: 'USD',
    users,
  }
}

function renderComposer() {
  return render(
    <ToastProvider>
      <CampaignComposer open onClose={() => {}} />
    </ToastProvider>,
  )
}

async function composeAndSend(subject: string, message: string, button: RegExp): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: subject } })
  fireEvent.change(screen.getByPlaceholderText('<p>Hello, …</p>'), { target: { value: message } })
  fireEvent.click(screen.getByRole('button', { name: button }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(campaignsService.listUsers).mockImplementation(async (filters) => pageFor(filters ?? {}))
})

describe('recipient selection and marketing consent', () => {
  test('promotional sends list only opted-in users (consent filter forced server-side)', async () => {
    renderComposer()

    await screen.findByText('ada@example.com')
    expect(campaignsService.listUsers).toHaveBeenCalledWith(expect.objectContaining({ consent: 'opted_in' }))
    expect(screen.getByText('grace@example.com')).toBeInTheDocument()
    // The opted-out account is filtered out of the promotional picker entirely.
    expect(screen.queryByText('alan@example.com')).not.toBeInTheDocument()
  })

  test('an opted-out user is never selectable for a promotional campaign', async () => {
    // Even if a row with revoked consent somehow appears, its checkbox is disabled.
    vi.mocked(campaignsService.listUsers).mockResolvedValue(pageFor({ consent: 'all' }))
    renderComposer()

    await screen.findByText('alan@example.com')
    fireEvent.click(screen.getByLabelText('Choose individuals'))
    expect(screen.getByLabelText('Select ada@example.com')).toBeEnabled()
    expect(screen.getByLabelText('Select alan@example.com')).toBeDisabled()
  })

  test('non-promotional category allows choosing users who did not opt in', async () => {
    renderComposer()

    await screen.findByText('ada@example.com')

    fireEvent.change(screen.getByLabelText('Email category'), { target: { value: 'service_notice' } })
    fireEvent.change(screen.getByLabelText('Filter by marketing consent'), { target: { value: 'opted_out' } })

    await screen.findByText('alan@example.com')
    expect(campaignsService.listUsers).toHaveBeenCalledWith(expect.objectContaining({ consent: 'opted_out' }))
    expect(screen.getByLabelText('Select alan@example.com')).toBeEnabled()
  })

  test('plan and subscription-status filters are forwarded to the users API', async () => {
    renderComposer()

    await screen.findByText('ada@example.com')

    fireEvent.change(screen.getByLabelText('Filter by plan'), { target: { value: 'pro' } })
    fireEvent.change(screen.getByLabelText('Filter by subscription status'), { target: { value: 'active' } })

    await waitFor(() =>
      expect(campaignsService.listUsers).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'pro', subscriptionStatus: 'active', consent: 'opted_in' }),
      ),
    )
  })
})

describe('campaign send', () => {
  test('choosing individuals sends the manual_emails audience with an idempotency key', async () => {
    vi.mocked(campaignsService.send).mockResolvedValue({
      duplicate: false,
      campaign: {
        id: 'c1',
        status: 'completed',
        subject: 'Hello',
        audience: { type: 'manual_emails', emails: ['ada@example.com'] },
        totals: { resolved: 1, accepted: 1, failed: 0, skipped: 0 },
        accepted: [{ email: 'ada@example.com' }],
        failed: [],
        skipped: [],
      },
    } as CampaignSendResponse)

    renderComposer()
    await screen.findByText('ada@example.com')

    fireEvent.click(screen.getByLabelText('Choose individuals'))
    fireEvent.click(screen.getByLabelText('Select ada@example.com'))
    await composeAndSend('Hello', '<p>Hi there</p>', /send campaign/i)

    await waitFor(() => expect(campaignsService.send).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(campaignsService.send).mock.calls[0][0]
    expect(payload.audience).toEqual({ type: 'manual_emails', emails: ['ada@example.com'] })
    expect(payload.subject).toBe('Hello')
    expect(payload.bodyHtml).toBe('<p>Hi there</p>')
    expect(payload.idempotencyKey).toMatch(/.+/)
  })

  test('filtered segment mode sends the contract filters selector (no invented fields)', async () => {
    vi.mocked(campaignsService.send).mockResolvedValue({
      duplicate: false,
      campaign: {
        id: 'c2',
        status: 'completed',
        subject: 'Upgrade',
        audience: { type: 'filters', plan: 'pro' },
        totals: { resolved: 1, accepted: 1, failed: 0, skipped: 0 },
        accepted: [{ email: 'ada@example.com' }],
        failed: [],
        skipped: [],
      },
    } as CampaignSendResponse)

    renderComposer()
    await screen.findByText('ada@example.com')

    fireEvent.click(screen.getByLabelText('Filtered segment (plan / subscription status)'))
    fireEvent.change(screen.getByLabelText('Filter by plan'), { target: { value: 'pro' } })
    await composeAndSend('Upgrade', 'Big things coming', /send campaign/i)

    await waitFor(() => expect(campaignsService.send).toHaveBeenCalledTimes(1))
    expect(vi.mocked(campaignsService.send).mock.calls[0][0].audience).toEqual({ type: 'filters', plan: 'pro' })
  })

  test('shows the send result with accepted and skipped recipient outcomes', async () => {
    vi.mocked(campaignsService.send).mockResolvedValue({
      duplicate: false,
      campaign: {
        id: 'c3',
        status: 'completed_with_failures',
        subject: 'Hello',
        audience: { type: 'all_eligible' },
        totals: { resolved: 2, accepted: 1, failed: 0, skipped: 1 },
        accepted: [{ email: 'ada@example.com' }],
        failed: [],
        skipped: [{ email: 'alan@example.com', reason: 'not_opted_in' }],
      },
    } as CampaignSendResponse)

    renderComposer()
    await screen.findByText('ada@example.com')
    await composeAndSend('Hello', 'Hi', /send campaign/i)

    // Server-side rejection of an ineligible recipient is surfaced honestly.
    await screen.findByText(/completed with failures/)
    expect(screen.getByText('alan@example.com')).toBeInTheDocument()
    expect(screen.getByText('No marketing opt-in')).toBeInTheDocument()
    expect(screen.getByText(/accepted by the email provider, not a delivery confirmation/i)).toBeInTheDocument()
  })

  test('a failed campaign request shows the error and never claims success', async () => {
    vi.mocked(campaignsService.send).mockRejectedValue(new Error('Rayern admin API is not configured'))

    renderComposer()
    await screen.findByText('ada@example.com')
    await composeAndSend('Hello', 'Hi', /send campaign/i)

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Rayern admin API is not configured'),
    )
    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/accepted/i)).not.toBeInTheDocument()
  })

  test('a non-promotional notice goes through the existing email pipeline', async () => {
    vi.mocked(emailsService.send).mockResolvedValue({ id: 'e1' } as never)

    renderComposer()
    await screen.findByText('ada@example.com')

    fireEvent.change(screen.getByLabelText('Email category'), { target: { value: 'service_notice' } })
    fireEvent.change(screen.getByLabelText('Filter by marketing consent'), { target: { value: 'opted_out' } })
    await screen.findByText('alan@example.com')

    fireEvent.click(screen.getByLabelText('Select alan@example.com'))
    await composeAndSend('Scheduled maintenance', 'We will be down Sunday.', /send notice/i)

    await waitFor(() => expect(emailsService.send).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(emailsService.send).mock.calls[0][0]
    expect(payload.bcc).toEqual(['alan@example.com'])
    expect(payload.type).toBe('notice')
    expect(campaignsService.send).not.toHaveBeenCalled()
  })
})

describe('audience preview', () => {
  const PREVIEW: CampaignPreviewResponse = {
    audience: { type: 'all_eligible' },
    eligibleCount: 2,
    skippedCount: 2,
    sizeCap: 2000,
    capped: false,
    preview: [{ email: 'ada@example.com' }, { email: 'grace@example.com' }],
    previewTruncated: false,
    skipped: [
      { email: 'alan@example.com', reason: 'not_opted_in' },
      { email: 'x@external.test', reason: 'unknown_address' },
    ],
  }

  test('previews the audience with eligibility counts and skip reasons', async () => {
    vi.mocked(campaignsService.preview).mockResolvedValue(PREVIEW)

    renderComposer()
    await screen.findByText('ada@example.com')

    fireEvent.click(screen.getByRole('button', { name: /preview audience/i }))

    await waitFor(() => expect(campaignsService.preview).toHaveBeenCalledWith({ type: 'all_eligible' }))
    await screen.findByText('Will receive')
    expect(screen.getByText('Skipped by the server')).toBeInTheDocument()
    expect(screen.getByText('No marketing opt-in')).toBeInTheDocument()
    expect(screen.getByText('Not a known Rayern account')).toBeInTheDocument()
    expect(screen.getAllByText('ada@example.com').length).toBeGreaterThan(0)
    expect(screen.getAllByText('grace@example.com').length).toBeGreaterThan(0)
  })

  test('a failed preview request is shown with a retry, without blocking the form', async () => {
    vi.mocked(campaignsService.preview).mockRejectedValue(new Error('preview exploded'))

    renderComposer()
    await screen.findByText('ada@example.com')
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Hello' } })
    fireEvent.change(screen.getByPlaceholderText('<p>Hello, …</p>'), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByRole('button', { name: /preview audience/i }))

    await waitFor(() => expect(screen.getByText('preview exploded')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /send campaign/i })).toBeEnabled()
  })
})
