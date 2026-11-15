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

// The composer reads recipients from the locally synchronized audience only.
// Keep the real record->AdminUserRecord mapper (so the test exercises it) and
// replace just the network call.
vi.mock('../services/audience', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/audience')>()
  return {
    ...actual,
    audienceService: { ...actual.audienceService, list: vi.fn() },
  }
})

import { campaignsService } from '../services/campaigns'
import { audienceService, type SyncedAudienceRecord } from '../services/audience'
import { emailsService } from '../services/emails'
import { CampaignComposer } from '../components/CampaignComposer'
import { ToastProvider } from '../components/ui/Toast'
import type { CampaignPreviewResponse, CampaignSendResponse } from '../lib/types'

const ADA: SyncedAudienceRecord = {
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  status: 'active',
  emailVerified: true,
  workspacePlan: 'pro',
  subscriptionPlan: 'pro',
  subscriptionStatus: 'active',
  hasPaidAccess: true,
  consentOptedIn: true,
  consentedAt: '2026-11-01T00:00:00.000Z',
  consentSource: 'settings',
  syncedAt: '2026-11-15T00:00:00.000Z',
}
const GRACE: SyncedAudienceRecord = {
  email: 'grace@example.com',
  firstName: 'Grace',
  lastName: 'Hopper',
  status: 'active',
  emailVerified: true,
  workspacePlan: 'premium',
  subscriptionPlan: 'premium',
  subscriptionStatus: 'active',
  hasPaidAccess: true,
  consentOptedIn: true,
  consentedAt: '2026-11-02T00:00:00.000Z',
  consentSource: 'settings',
  syncedAt: '2026-11-15T00:00:00.000Z',
}
const ALAN: SyncedAudienceRecord = {
  email: 'alan@example.com',
  firstName: 'Alan',
  lastName: 'Turing',
  status: 'active',
  emailVerified: true,
  workspacePlan: 'pro',
  subscriptionPlan: 'pro',
  subscriptionStatus: 'canceled',
  hasPaidAccess: false,
  consentOptedIn: false,
  consentedAt: null,
  consentSource: 'settings',
  syncedAt: '2026-11-15T00:00:00.000Z',
}

function audienceFor(items: SyncedAudienceRecord[] = [ADA, GRACE, ALAN]) {
  return {
    items,
    counts: {
      total: items.length,
      eligible: items.filter((r) => r.consentOptedIn && r.status === 'active' && r.emailVerified).length,
      optedIn: items.filter((r) => r.consentOptedIn).length,
      optedOut: items.filter((r) => !r.consentOptedIn).length,
      suspended: items.filter((r) => r.status !== 'active').length,
      unverified: items.filter((r) => !r.emailVerified).length,
    },
    lastSyncedAt: '2026-11-15T00:00:00.000Z',
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
  vi.mocked(audienceService.list).mockResolvedValue(audienceFor())
})

describe('recipient selection and marketing consent', () => {
  test('promotional sends list only opted-in users from the synchronized audience', async () => {
    renderComposer()

    await screen.findByText('ada@example.com')
    expect(audienceService.list).toHaveBeenCalledTimes(1)
    expect(screen.getByText('grace@example.com')).toBeInTheDocument()
    // The opted-out account is filtered out of the promotional picker entirely.
    expect(screen.queryByText('alan@example.com')).not.toBeInTheDocument()
  })

  test('an opted-out recipient is never offered for a promotional campaign', async () => {
    renderComposer()

    await screen.findByText('ada@example.com')
    expect(screen.queryByLabelText('Select alan@example.com')).not.toBeInTheDocument()
  })

  test('non-promotional category allows choosing users who did not opt in', async () => {
    renderComposer()

    await screen.findByText('ada@example.com')

    fireEvent.change(screen.getByLabelText('Email category'), { target: { value: 'service_notice' } })
    fireEvent.change(screen.getByLabelText('Filter by marketing consent'), { target: { value: 'opted_out' } })

    await screen.findByText('alan@example.com')
    expect(screen.getByLabelText('Select alan@example.com')).toBeEnabled()
  })

  test('plan and subscription filters use the synchronized values', async () => {
    renderComposer()

    await screen.findByText('ada@example.com')

    fireEvent.change(screen.getByLabelText('Filter by plan'), { target: { value: 'pro' } })
    fireEvent.change(screen.getByLabelText('Filter by subscription status'), { target: { value: 'active' } })

    await waitFor(() => expect(screen.queryByText('grace@example.com')).not.toBeInTheDocument())
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    // Eligibility is explained for excluded synchronized recipients.
    expect(screen.queryByText('alan@example.com')).not.toBeInTheDocument()
  })

  test('auto-selects only verified, active, opted-in recipients in manual mode', async () => {
    const suspended: SyncedAudienceRecord = {
      ...GRACE,
      email: 'margaret@example.com',
      status: 'suspended',
    }
    const unverified: SyncedAudienceRecord = {
      ...GRACE,
      email: 'unverified@example.com',
      emailVerified: false,
    }
    vi.mocked(audienceService.list).mockResolvedValue(audienceFor([ADA, suspended, unverified]))
    vi.mocked(campaignsService.send).mockResolvedValue({
      duplicate: false,
      campaign: {
        id: 'c-auto',
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

    await waitFor(() => expect(screen.getByLabelText('Select ada@example.com')).toBeChecked())
    await composeAndSend('Hello', 'Hi', /send campaign/i)

    await waitFor(() => expect(campaignsService.send).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(campaignsService.send).mock.calls[0][0]
    expect(payload.audience).toEqual({ type: 'manual_emails', emails: ['ada@example.com'] })
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
    await waitFor(() => expect(screen.getByLabelText('Select grace@example.com')).toBeChecked())
    fireEvent.click(screen.getByLabelText('Select grace@example.com'))
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

    const alan = screen.getByLabelText('Select alan@example.com') as HTMLInputElement
    if (!alan.checked) fireEvent.click(alan)
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
