/**
 * Sanitization + classification for outbound Rayern diagnostics.
 *
 * These records are read back through an authenticated endpoint, so anything
 * that reaches storage must already be free of credentials. The tests below pin
 * down redaction (tokens, JWTs, emails, query strings), the response-header
 * allow-list, body-excerpt bounds and fetch-error classification.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyFetchError,
  pickDiagnosticHeaders,
  readBodyExcerpt,
  sanitizeDiagnosticText,
  MAX_SYNC_DIAGNOSTICS,
} from '../syncDiagnostics'

describe('sanitizeDiagnosticText', () => {
  it('redacts bearer tokens and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const out = sanitizeDiagnosticText(`Authorization: Bearer abc123def456 not-a-jwt ${jwt}`)
    expect(out).not.toContain('abc123def456')
    expect(out).not.toContain(jwt)
    expect(out).toContain('Bearer [redacted]')
    expect(out).toContain('[redacted-jwt]')
  })

  it('redacts credential pairs in JSON and in query strings', () => {
    const out = sanitizeDiagnosticText('{"password":"hunter2","apiKey":"sk_live_123"} token=abc123&password=zzz')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('sk_live_123')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('zzz')
    expect(out).toContain('[redacted]')
  })

  it('drops query strings from echoed URLs but keeps the path', () => {
    const out = sanitizeDiagnosticText('GET https://api.rayern.test/internal/logs?token=secret&x=1 failed')
    expect(out).toContain('https://api.rayern.test/internal/logs')
    expect(out).not.toContain('secret')
    expect(out).toContain('[redacted-query]')
  })

  it('redacts emails and long hex identifiers', () => {
    const out = sanitizeDiagnosticText('user ada@example.com rejected, trace 0123456789abcdef0123456789abcdef')
    expect(out).not.toContain('ada@example.com')
    expect(out).not.toContain('0123456789abcdef0123456789abcdef')
    expect(out).toContain('[redacted-email]')
    expect(out).toContain('[redacted-id]')
  })

  it('collapses whitespace and truncates at the limit', () => {
    const long = 'x'.repeat(900)
    const out = sanitizeDiagnosticText('line one\n\n   line two', 400)
    expect(out).toBe('line one line two')

    const truncated = sanitizeDiagnosticText(long, 100)
    expect(truncated.length).toBeLessThanOrEqual(101) // 100 chars + ellipsis
    expect(truncated.endsWith('…')).toBe(true)
  })
})

describe('pickDiagnosticHeaders', () => {
  it('keeps the diagnostic headers and drops credential-shaped ones', () => {
    const headers = new Headers({
      'Retry-After': '45',
      Server: 'rayern-edge',
      'X-Request-Id': 'req_abc123',
      'X-Edge-Node': 'fra1',
      'X-Api-Key': 'should-not-be-stored',
      'X-Auth-Token': 'should-not-be-stored',
      Authorization: 'Bearer should-not-be-stored',
      Cookie: 'session=should-not-be-stored',
      'Content-Length': '123',
    })

    const picked = pickDiagnosticHeaders(headers)
    expect(picked['retry-after']).toBe('45')
    expect(picked['server']).toBe('rayern-edge')
    expect(picked['x-request-id']).toBe('req_abc123')
    expect(picked['x-edge-node']).toBe('fra1')
    // Non-sensitive headers are now captured (not just an allow-list).
    expect(picked['content-length']).toBe('123')
    // Credential-shaped headers are absent even when they carry an X- prefix.
    expect(picked['x-api-key']).toBeUndefined()
    expect(picked['x-auth-token']).toBeUndefined()
    expect(picked['authorization']).toBeUndefined()
    expect(picked['cookie']).toBeUndefined()

    expect(JSON.stringify(picked)).not.toContain('should-not-be-stored')
  })

  it('returns an empty object when there are no headers', () => {
    expect(pickDiagnosticHeaders(null)).toEqual({})
  })
})

describe('readBodyExcerpt', () => {
  it('returns the body, truncated to the excerpt bound', async () => {
    const small = await readBodyExcerpt({ text: async () => 'upstream failed' })
    expect(small).toBe('upstream failed')

    const large = await readBodyExcerpt({ text: async () => 'a'.repeat(5000) })
    expect(large).not.toBeNull()
    expect(large!.length).toBe(1200)
  })

  it('returns null for an empty or unreadable body', async () => {
    expect(await readBodyExcerpt({ text: async () => '' })).toBeNull()
    expect(
      await readBodyExcerpt({
        text: async () => {
          throw new Error('stream already consumed')
        },
      }),
    ).toBeNull()
  })
})

describe('classifyFetchError', () => {
  it('classifies an abort as a timeout', () => {
    const err = new Error('This operation was aborted')
    err.name = 'AbortError'
    const info = classifyFetchError(err, 15_000)
    expect(info.outcome).toBe('timeout')
    expect(info.code).toBe('RAYERN_TIMEOUT')
    expect(info.message).toContain('15000ms')
  })

  it('classifies other rejections as network failures with a sanitized message', () => {
    const info = classifyFetchError(new TypeError('fetch failed: connect ECONNREFUSED ada@example.com'), 15_000)
    expect(info.outcome).toBe('network_error')
    expect(info.code).toBe('RAYERN_UNREACHABLE')
    expect(info.message).not.toContain('ada@example.com')
    expect(info.message).toContain('ECONNREFUSED')
  })
})

describe('retention bound', () => {
  it('keeps a bounded store', () => {
    expect(MAX_SYNC_DIAGNOSTICS).toBe(200)
  })
})
