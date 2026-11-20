/**
 * Regression tests: user-selected filters must reach the backend.
 *
 * The audit found that the Errors and Audit services ignored their filter
 * arguments against the real API (only the demo branch filtered), so the UI
 * silently displayed unfiltered results.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, USE_DEMO_DATA: false, apiRequest: vi.fn() }
})

import { apiRequest } from '../lib/api'
import { errorsService } from '../services/errors'
import { auditService } from '../services/audit'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(apiRequest).mockResolvedValue([])
})

describe('errorsService.list', () => {
  test('passes search and severity to GET /errors', async () => {
    await errorsService.list({ search: ' database ', severity: 'high' })
    expect(apiRequest).toHaveBeenCalledWith('/errors?search=database&severity=high')
  })

  test('omits the "all" severity instead of sending it', async () => {
    await errorsService.list({ severity: 'all' })
    expect(apiRequest).toHaveBeenCalledWith('/errors')
  })
})

describe('auditService.list', () => {
  test('passes search and actor kind to GET /audit', async () => {
    await auditService.list({ search: 'login', actorKind: 'admin' })
    expect(apiRequest).toHaveBeenCalledWith('/audit?search=login&actorKind=admin')
  })

  test('omits the "all" actor filter', async () => {
    await auditService.list({ actorKind: 'all' })
    expect(apiRequest).toHaveBeenCalledWith('/audit')
  })
})
