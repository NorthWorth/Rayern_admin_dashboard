import { describe, expect, it } from 'vitest'
import { backoffMs, classifyFetchError, classifyResponse, isEdgeChallenge, reachedApplication } from '../classify.js'

function headers(map: Record<string, string>): Headers {
  return new Headers(map)
}

describe('edge challenge detection', () => {
  it('recognises a Render/Cloudflare human-verification HTML page', () => {
    expect(
      isEdgeChallenge({
        status: 403,
        contentType: 'text/html; charset=utf-8',
        bodyExcerpt: '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
        headers: headers({ server: 'cloudflare' }),
      }),
    ).toBe(true)
  })

  it('does not treat a JSON API error mentioning "challenge" as a challenge', () => {
    expect(
      isEdgeChallenge({
        status: 400,
        contentType: 'application/json',
        bodyExcerpt: '{"error":"invalid challenge token"}',
        headers: headers({ 'x-powered-by': 'Express' }),
      }),
    ).toBe(false)
  })

  it('recognises the cf-mitigated header even without body markers', () => {
    expect(
      isEdgeChallenge({
        status: 403,
        contentType: null,
        bodyExcerpt: null,
        headers: headers({ 'cf-mitigated': 'challenge' }),
      }),
    ).toBe(true)
  })
})

describe('classifyResponse', () => {
  it('marks a 2xx JSON answer as success and not retryable', () => {
    const c = classifyResponse({
      status: 202,
      contentType: 'application/json',
      bodyExcerpt: '{"success":true}',
      headers: headers({ 'x-powered-by': 'Express' }),
    })
    expect(c.outcome).toBe('success')
    expect(c.retryable).toBe(false)
    expect(c.reachedApplication).toBe(true)
  })

  it('classifies 429 as transient with Retry-After', () => {
    const c = classifyResponse({
      status: 429,
      contentType: 'application/json',
      bodyExcerpt: '{"error":"slow down"}',
      headers: headers({ 'retry-after': '120', 'x-powered-by': 'Express' }),
    })
    expect(c.category).toBe('rate_limited')
    expect(c.retryable).toBe(true)
    expect(c.retryAfterSec).toBe(120)
  })

  it('never retries authentication failures', () => {
    const c = classifyResponse({
      status: 401,
      contentType: 'application/json',
      bodyExcerpt: '{"error":"unauthorized"}',
      headers: headers({ 'x-powered-by': 'Express' }),
    })
    expect(c.category).toBe('auth')
    expect(c.retryable).toBe(false)
  })

  it('classifies an edge challenge as challenge_blocked and non-retryable', () => {
    const c = classifyResponse({
      status: 403,
      contentType: 'text/html',
      bodyExcerpt: '<html><body>Verify you are human</body></html>',
      headers: headers({ server: 'cloudflare' }),
    })
    expect(c.outcome).toBe('edge_challenge')
    expect(c.retryable).toBe(false)
    expect(c.reachedApplication).toBe(false)
  })
})

describe('fetch error classification', () => {
  it('treats a timeout as retryable', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const c = classifyFetchError(err, 5000)
    expect(c.outcome).toBe('timeout')
    expect(c.retryable).toBe(true)
    expect(c.message).toContain('5000ms')
  })
})

describe('reachedApplication', () => {
  it('is unknown when there was no response', () => {
    expect(reachedApplication(null)).toBeNull()
  })
  it('detects an Express response', () => {
    expect(reachedApplication(headers({ 'x-powered-by': 'Express' }))).toBe(true)
  })
})

describe('backoff', () => {
  it('grows exponentially and is capped with jitter', () => {
    const flat = () => 0.5 // no jitter contribution
    expect(backoffMs(1, 1000, 60000, flat)).toBe(1000)
    expect(backoffMs(3, 1000, 60000, flat)).toBe(4000)
    expect(backoffMs(20, 1000, 60000, flat)).toBe(60000)
  })

  it('stays within ±20% of the exponential value', () => {
    for (const r of [0, 0.25, 0.75, 1]) {
      const value = backoffMs(2, 1000, 60000, () => r)
      expect(value).toBeGreaterThanOrEqual(1600)
      expect(value).toBeLessThanOrEqual(2400)
    }
  })
})
