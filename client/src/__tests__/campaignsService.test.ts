import { describe, expect, test, vi, beforeEach } from 'vitest'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, USE_DEMO_DATA: false, apiRequest: vi.fn() }
})

import { apiRequest } from '../lib/api'
import { campaignsService } from '../services/campaigns'
import type { AdminUsersPage, CampaignPreviewResponse, CampaignSendResponse } from '../lib/types'

const USERS_PAGE: AdminUsersPage = {
  pagination: { page: 1, limit: 50, totalResults: 1, totalPages: 1 },
  filters: { plan: null, subscriptionStatus: null, consent: 'opted_in' },
  currency: 'USD',
  users: [
    {
      id: 'u1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      accountStatus: 'active',
      marketingConsent: { optedIn: true, source: 'settings' },
      workspace: { name: 'Ada WS', plan: 'pro' },
      subscription: { plan: 'pro', status: 'active', billingInterval: 'monthly', hasPaidAccess: true },
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('campaignsService endpoints (contract §4/§5)', () => {
  test('listUsers queries GET /api/v1/admin/users with the documented filters', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ success: true, data: USERS_PAGE })

    const page = await campaignsService.listUsers({
      page: 2,
      limit: 50,
      plan: 'pro',
      subscriptionStatus: 'active',
      consent: 'opted_in',
    })

    expect(apiRequest).toHaveBeenCalledWith(
      '/api/v1/admin/users?page=2&limit=50&plan=pro&subscriptionStatus=active&consent=opted_in',
    )
    expect(page.users[0].email).toBe('ada@example.com')
  })

  test('listUsers omits filters that are not set or are "all"', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ success: true, data: USERS_PAGE })

    await campaignsService.listUsers({ plan: 'all', subscriptionStatus: 'all', consent: 'all' })

    expect(apiRequest).toHaveBeenCalledWith('/api/v1/admin/users?page=1&limit=50')
  })

  test('preview posts { audience } to /api/v1/admin/campaigns/preview', async () => {
    const preview: CampaignPreviewResponse = {
      audience: { type: 'filters', plan: 'pro', subscriptionStatus: 'active' },
      eligibleCount: 1,
      skippedCount: 0,
      sizeCap: 2000,
      capped: false,
      preview: [{ email: 'ada@example.com' }],
      previewTruncated: false,
      skipped: [],
    }
    vi.mocked(apiRequest).mockResolvedValue({ success: true, data: preview })

    const result = await campaignsService.preview({ type: 'filters', plan: 'pro', subscriptionStatus: 'active' })

    expect(apiRequest).toHaveBeenCalledWith('/api/v1/admin/campaigns/preview', {
      method: 'POST',
      body: { audience: { type: 'filters', plan: 'pro', subscriptionStatus: 'active' } },
    })
    expect(result.eligibleCount).toBe(1)
  })

  test('send posts the contract payload to /api/v1/admin/campaigns/send', async () => {
    const response: CampaignSendResponse = {
      duplicate: false,
      campaign: {
        id: 'c1',
        status: 'completed',
        subject: 'Hello',
        audience: { type: 'all_eligible' },
        totals: { resolved: 1, accepted: 1, failed: 0, skipped: 0 },
        accepted: [{ email: 'ada@example.com', providerMessageId: 'm1' }],
        failed: [],
        skipped: [],
      },
    }
    vi.mocked(apiRequest).mockResolvedValue({ success: true, data: response })

    await campaignsService.send({
      subject: 'Hello',
      bodyHtml: '<p>Hi</p>',
      audience: { type: 'all_eligible' },
      idempotencyKey: '2f6b0f6e-9f3b-4f3f-9f3b-2f6b0f6e9f3b',
    })

    expect(apiRequest).toHaveBeenCalledWith('/api/v1/admin/campaigns/send', {
      method: 'POST',
      body: {
        subject: 'Hello',
        bodyHtml: '<p>Hi</p>',
        audience: { type: 'all_eligible' },
        idempotencyKey: '2f6b0f6e-9f3b-4f3f-9f3b-2f6b0f6e9f3b',
      },
    })
  })

  test('a Rayern error envelope surfaces its message instead of silent data', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      success: false,
      error: { code: 'ADMIN_ACCESS_REQUIRED', message: 'Admin access required' },
    })

    await expect(campaignsService.preview({ type: 'all_eligible' })).rejects.toThrow('Admin access required')
  })

  test('an ineligible manual recipient comes back as a server-side skip, not a client decision', async () => {
    const response: CampaignSendResponse = {
      duplicate: false,
      campaign: {
        id: 'c2',
        status: 'completed_with_failures',
        subject: 'Hello',
        audience: { type: 'manual_emails', emails: ['alan@example.com'] },
        totals: { resolved: 1, accepted: 0, failed: 0, skipped: 1 },
        accepted: [],
        failed: [],
        skipped: [{ email: 'alan@example.com', reason: 'not_opted_in' }],
      },
    }
    vi.mocked(apiRequest).mockResolvedValue({ success: true, data: response })

    const result = await campaignsService.send({
      subject: 'Hello',
      bodyHtml: 'Hi',
      audience: { type: 'manual_emails', emails: ['alan@example.com'] },
    })

    expect(result.campaign.skipped).toEqual([{ email: 'alan@example.com', reason: 'not_opted_in' }])
    expect(result.campaign.totals.accepted).toBe(0)
  })
})
