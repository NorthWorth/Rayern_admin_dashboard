/**
 * Audience snapshot guard rails.
 *
 * The audience push endpoint is the only source of mailable recipients. Two
 * failure modes must never be possible:
 *   1. an EMPTY payload wiping the stored audience (it cannot prove that no
 *      recipients exist — only that none were sent), and
 *   2. a partial/delta payload being treated as the whole consent table.
 * `complete: true` is the producer's explicit claim that it sent everything, and
 * only then are absent rows pruned. These tests exercise the validation that
 * enforces both without needing a database.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

let parseAudiencePayload: typeof import('../rayernAudienceIngestion').parseAudiencePayload

beforeAll(async () => {
  process.env.TELEMETRY_ENABLED = 'false'
  delete process.env.DATABASE_URL
  vi.resetModules()
  ;({ parseAudiencePayload } = await import('../rayernAudienceIngestion'))
})

const record = {
  email: 'Ada@Example.com',
  firstName: 'Ada',
  status: 'active',
  emailVerified: true,
  marketingConsent: { optedIn: true, consentedAt: '2026-11-01T10:00:00.000Z', source: 'settings' },
  updatedAt: '2026-11-18T10:00:00.000Z',
}

describe('parseAudiencePayload', () => {
  it('accepts a producer-shaped snapshot and preserves the complete flag', () => {
    const parsed = parseAudiencePayload({ syncId: 's1', generatedAt: '2026-11-20T00:00:00.000Z', complete: true, audience: [record] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.complete).toBe(true)
    expect(parsed.data.audience).toHaveLength(1)
    expect(parsed.data.audience[0].emailVerified).toBe(true)
    expect(parsed.data.audience[0].marketingConsent.optedIn).toBe(true)
  })

  it('rejects an empty audience instead of treating it as "nobody exists"', () => {
    const parsed = parseAudiencePayload({ audience: [] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.status).toBe(400)
    expect(parsed.error).toMatch(/Empty audience snapshot rejected/)
    // The message states the stored audience was left alone.
    expect(parsed.error).toMatch(/left untouched/)
  })

  it('rejects a payload with no audience field at all', () => {
    expect(parseAudiencePayload({}).ok).toBe(false)
    expect(parseAudiencePayload(null).ok).toBe(false)
    expect(parseAudiencePayload([]).ok).toBe(false)
  })

  it('rejects records that would store invalid identity or state', () => {
    for (const bad of [
      { ...record, email: 'not-an-email' },
      { ...record, status: 'deleted' },
      { ...record, emailVerified: 'yes' },
      { email: record.email },
    ]) {
      expect(parseAudiencePayload({ audience: [bad] }).ok).toBe(false)
    }
  })

  it('reports failing paths for a malformed record', () => {
    const parsed = parseAudiencePayload({ audience: [{ ...record, email: 'x' }] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/audience\.0\.email/)
  })

  it('defaults status/verification conservatively when the producer omits them', () => {
    const parsed = parseAudiencePayload({ audience: [{ email: 'bob@example.com', marketingConsent: {} }] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.audience[0].status).toBe('active')
    expect(parsed.data.audience[0].emailVerified).toBe(false)
    // No consent record means not opted in — never inferred as consent.
    expect(parsed.data.audience[0].marketingConsent.optedIn).toBe(false)
  })

  it('treats a delta payload (complete unset) as non-pruning', () => {
    const parsed = parseAudiencePayload({ audience: [record] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.complete).toBeUndefined()
  })
})
