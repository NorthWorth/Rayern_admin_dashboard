/**
 * The Feedback page must read Rayern's admin feedback API through the
 * dashboard proxy — same endpoint, filters and envelope as the upstream
 * contract — and must surface failures instead of showing an empty queue.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, USE_DEMO_DATA: false, apiRequest: vi.fn() }
})

import { apiRequest } from '../lib/api'
import { feedbackService } from '../services/feedback'

const RECORD = {
  id: '5f1d7c9a2b8e4f0c9d3a6b71',
  category: 'Bug report',
  message: 'Export button does nothing on Safari.',
  status: 'open' as const,
  source: 'app',
  createdAt: '2026-11-18T09:00:00.000Z',
  updatedAt: '2026-11-18T09:00:00.000Z',
  reviewedAt: null,
  workspaceId: 'w1',
  user: { id: 'u1', email: 'ada@example.com' },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('feedbackService.list', () => {
  test('calls the proxy with pagination, filters and sort, then flattens `feedback`', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      success: true,
      data: {
        pagination: { page: 2, limit: 25, totalResults: 51, totalPages: 3, hasNextPage: true },
        filters: { category: 'Bug report', status: 'open', sort: 'createdAt:desc' },
        feedback: [RECORD],
      },
    })

    const page = await feedbackService.list({
      page: 2,
      limit: 25,
      category: 'Bug report',
      status: 'open',
      sort: 'createdAt:desc',
    })

    expect(apiRequest).toHaveBeenCalledWith(
      '/api/v1/admin/feedback?page=2&limit=25&category=Bug+report&status=open&sort=createdAt%3Adesc',
    )
    expect(page.items).toHaveLength(1)
    expect(page.items[0].message).toBe('Export button does nothing on Safari.')
    expect(page.pagination.totalResults).toBe(51)
    expect(page.pagination.hasNextPage).toBe(true)
  })

  test('omits unset filters instead of sending empty values', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      success: true,
      data: { pagination: { page: 1, limit: 50, totalResults: 0, totalPages: 1, hasNextPage: false }, filters: {}, feedback: [] },
    })

    // sort is omitted when unset: Rayern already defaults to createdAt:desc.
    await feedbackService.list()
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/admin/feedback?page=1&limit=50')
  })

  test('throws on an error envelope rather than presenting an empty queue', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      success: false,
      error: { code: 'RAYERN_ADMIN_API_UNAVAILABLE', message: 'Rayern admin API is not configured' },
    })
    await expect(feedbackService.list()).rejects.toThrow(/not configured/)
  })
})

describe('feedbackService.summary', () => {
  test('unwraps aggregate counts and keeps real zeros', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      success: true,
      data: { total: 0, byStatus: { open: 0, reviewed: 0, resolved: 0 }, byCategory: {}, lastSubmittedAt: null },
    })

    const summary = await feedbackService.summary()
    expect(summary.total).toBe(0)
    expect(summary.byStatus.open).toBe(0)
    expect(summary.lastSubmittedAt).toBeNull()
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/admin/feedback/summary')
  })
})

describe('feedbackService.updateStatus', () => {
  test('sends the supported status transition to the record endpoint', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      success: true,
      data: { feedback: { ...RECORD, status: 'resolved', reviewedAt: '2026-11-20T09:00:00.000Z' } },
    })

    const updated = await feedbackService.updateStatus(RECORD.id, 'resolved')

    expect(apiRequest).toHaveBeenCalledWith(`/api/v1/admin/feedback/${RECORD.id}`, {
      method: 'PATCH',
      body: { status: 'resolved' },
    })
    expect(updated.status).toBe('resolved')
    expect(updated.reviewedAt).toBe('2026-11-20T09:00:00.000Z')
  })

  test('propagates an upstream rejection (e.g. missing record)', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      success: false,
      error: { code: 'FEEDBACK_NOT_FOUND', message: 'Feedback not found.' },
    })
    await expect(feedbackService.updateStatus(RECORD.id, 'reviewed')).rejects.toThrow(/Feedback not found/)
  })
})
