/**
 * Response classification for the wake request.
 *
 * The critical distinction this module exists for: a Render edge challenge is
 * NOT a successful wake and NOT an ordinary application error. It is a
 * browser-oriented human-verification page served *in front of* Rayern. A
 * server-to-server worker cannot complete it, so it must be reported as an
 * explicit `challenge_blocked` state — never retried in a loop.
 *
 * Nothing here attempts to solve, evade or bypass a challenge.
 */

export type FailureCategory =
  | 'none'
  | 'edge_challenge'
  | 'auth'
  | 'validation'
  | 'rate_limited'
  | 'upstream_5xx'
  | 'upstream_4xx'
  | 'timeout'
  | 'network'

export interface AttemptClassification {
  /** `success` only when the application answered with a 2xx JSON response. */
  outcome: 'success' | 'http_error' | 'edge_challenge' | 'timeout' | 'network_error'
  category: FailureCategory
  httpStatus: number | null
  /** Transient failures may be retried with backoff; permanent ones may not. */
  retryable: boolean
  /** Whether the response looks like it came from the Rayern app itself. */
  reachedApplication: boolean | null
  retryAfterSec: number | null
  /** Bounded, sanitized explanation — never a token or header dump. */
  message: string
}

const CHALLENGE_MARKERS = [
  'challenge',
  'captcha',
  'cf-chl',
  'just a moment',
  'human verification',
  'verify you are human',
  'checking your browser',
  'attention required',
  'ray id',
]

/** Content types that mean "this is a rendered page", not an API answer. */
function isHtml(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('text/html')
}

/**
 * Detects an edge/human-verification challenge from the parts of a response a
 * worker is allowed to inspect. Deliberately conservative: an HTML body with a
 * challenge marker, or a challenge-specific header, counts.
 */
export function isEdgeChallenge(input: {
  status: number | null
  contentType: string | null
  bodyExcerpt: string | null
  headers?: Headers | null
}): boolean {
  const header = (name: string): string => (input.headers?.get(name) ?? '').toLowerCase()
  if (header('cf-mitigated')) return true
  if (header('x-render-challenge')) return true

  const body = (input.bodyExcerpt ?? '').toLowerCase()
  const marker = CHALLENGE_MARKERS.some((m) => body.includes(m))
  if (!marker) return false
  // A JSON API error that merely mentions "challenge" is not a challenge page.
  return isHtml(input.contentType) || body.includes('<html') || body.includes('<!doctype html')
}

/**
 * Whether the response came from the Rayern Express application.
 * `null` = no response at all, so reachability is unknown.
 */
export function reachedApplication(headers: Headers | null | undefined): boolean | null {
  if (!headers) return null
  const poweredBy = (headers.get('x-powered-by') ?? '').toLowerCase()
  if (poweredBy.includes('express')) return true
  const server = (headers.get('server') ?? '').toLowerCase()
  if (server.includes('express')) return true
  const requestId = headers.get('x-request-id')
  if (requestId && !/(render|cloudflare|nginx|envoy|fastly|akamai)/i.test(server)) return true
  return false
}

/** Parses `Retry-After` (delta seconds or HTTP date). */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const secs = Number(header)
  if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs)
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.ceil((dateMs - now) / 1000))
  return null
}

/** Classifies a completed HTTP response. */
export function classifyResponse(input: {
  status: number
  contentType: string | null
  bodyExcerpt: string | null
  headers: Headers | null
}): AttemptClassification {
  const reached = reachedApplication(input.headers)
  const retryAfterSec = parseRetryAfter(input.headers?.get('retry-after') ?? null)

  if (isEdgeChallenge(input)) {
    return {
      outcome: 'edge_challenge',
      category: 'edge_challenge',
      httpStatus: input.status,
      // NEVER retry: retrying a human-verification page just hammers the edge.
      retryable: false,
      reachedApplication: false,
      retryAfterSec,
      message:
        'Blocked by a browser human-verification challenge in front of Rayern. The wake request did not reach the application.',
    }
  }

  if (input.status >= 200 && input.status < 300) {
    return {
      outcome: 'success',
      category: 'none',
      httpStatus: input.status,
      retryable: false,
      reachedApplication: reached,
      retryAfterSec,
      message: `Rayern accepted the wake request (HTTP ${input.status}).`,
    }
  }

  const category: FailureCategory =
    input.status === 429
      ? 'rate_limited'
      : input.status === 401 || input.status === 403
        ? 'auth'
        : input.status >= 500
          ? 'upstream_5xx'
          : 'upstream_4xx'

  return {
    outcome: 'http_error',
    category,
    httpStatus: input.status,
    // 429 and 5xx are transient; auth/validation are not.
    retryable: category === 'rate_limited' || category === 'upstream_5xx',
    reachedApplication: reached,
    retryAfterSec,
    message: `Rayern answered HTTP ${input.status}${reached === false ? ' (edge/proxy response, application not reached)' : ''}.`,
  }
}

/** Classifies a thrown fetch error (network down, DNS, timeout abort). */
export function classifyFetchError(err: unknown, timeoutMs: number): AttemptClassification {
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      outcome: 'timeout',
      category: 'timeout',
      httpStatus: null,
      retryable: true,
      reachedApplication: null,
      retryAfterSec: null,
      message: `Rayern did not respond within ${timeoutMs}ms.`,
    }
  }
  return {
    outcome: 'network_error',
    category: 'network',
    httpStatus: null,
    retryable: true,
    reachedApplication: null,
    retryAfterSec: null,
    message: 'Could not reach the Rayern endpoint (network error).',
  }
}

/** Exponential backoff with jitter, capped. Attempts start at 1. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs)
  // ±20% jitter so multiple instances never retry in lockstep.
  const jitter = exponential * 0.2 * (random() * 2 - 1)
  return Math.max(0, Math.round(exponential + jitter))
}
