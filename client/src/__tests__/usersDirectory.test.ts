/**
 * The Users page must read Rayern's admin-users directory, not the empty local
 * accounts table. It goes through the dashboard proxy path
 * (`/api/v1/admin/users`), with Rayern's documented server-side filters.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, USE_DEMO_DATA: false, apiRequest: vi.fn() }
})

import { apiRequest } from '../lib/api'
import { usersService } from '../services/users'

const PAGE = {
  pagination: { page: 2, limit: 25, totalResults: 80, totalPages: 4 },
  filters: { plan: 'pro', subscriptionStatus: null, consent: 'opted_in' },
  users: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(apiRequest).mockResolvedValue({ success: true, data: PAGE })
})

describe('usersService.directory', () => {
  test('queries the Rayern admin-users proxy with pagination and filters', async () => {
    const page = await usersService.directory({ page: 2, limit: 25, plan: 'pro', consent: 'opted_in' })

    expect(apiRequest).toHaveBeenCalledWith('/api/v1/admin/users?page=2&limit=25&plan=pro&consent=opted_in')
    expect(page.pagination.totalResults).toBe(80)
  })

  test('omits "all" filters instead of sending them upstream', async () => {
    await usersService.directory({ plan: 'all', subscriptionStatus: 'all', consent: 'all' })
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/admin/users?page=1&limit=50')
  })

  test('surfaces an unavailable proxy instead of returning an empty directory', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      success: false,
      error: { code: 'RAYERN_ADMIN_API_UNAVAILABLE', message: 'Rayern admin API is not configured' },
    })
    await expect(usersService.directory({})).rejects.toThrow(/not configured/)
  })
})
