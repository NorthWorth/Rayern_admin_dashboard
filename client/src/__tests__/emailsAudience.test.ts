/**
 * The email composer's bulk recipient scope follows the email type: marketing
 * consent gates promotional mail only, while operational/service mail must keep
 * reaching opted-out and unverified accounts.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, USE_DEMO_DATA: false, apiRequest: vi.fn() }
})

import { apiRequest } from '../lib/api'
import { AUDIENCE_SCOPE_RULE, audienceScopeFor, emailsService } from '../services/emails'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('audienceScopeFor', () => {
  test('promotional mail uses the consent-gated scope', () => {
    expect(audienceScopeFor('promotion')).toBe('promotional')
  })

  test('operational types keep the broader scope', () => {
    for (const type of ['update', 'announcement', 'notice'] as const) {
      expect(audienceScopeFor(type)).toBe('operational')
    }
  })
})

describe('AUDIENCE_SCOPE_RULE', () => {
  test('states the eligibility rule for each scope', () => {
    expect(AUDIENCE_SCOPE_RULE.promotional).toMatch(/opted in, active and email verified/)
    expect(AUDIENCE_SCOPE_RULE.operational).toMatch(/including opted-out and unverified/)
  })
})

describe('emailsService.audience', () => {
  test('requests the scope it was given and returns the server-reported scope', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      count: 3,
      recipients: ['a@example.com'],
      lastSyncedAt: '2026-11-20T00:00:00.000Z',
      scope: 'operational',
    })

    const result = await emailsService.audience('operational')

    expect(apiRequest).toHaveBeenCalledWith('/emails/audience?scope=operational')
    expect(result.scope).toBe('operational')
    expect(result.count).toBe(3)
    expect(result.lastSyncedAt).toBe('2026-11-20T00:00:00.000Z')
  })
})
