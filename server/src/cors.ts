import type { CorsOptions } from 'cors'

/**
 * Request headers the dashboard frontend actually sends.
 *
 * `x-correlation-id` is set by `client/src/lib/api.ts` on every API request
 * (introduced for Update-flow tracing). It must be listed here or browsers
 * reject the request at preflight, before it ever reaches a route.
 */
export const CORS_ALLOWED_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'x-correlation-id',
]

/**
 * Builds the shared CORS policy. `origins` is the explicit allow-list from
 * config (production) or an empty list in dev/preview, where same-origin,
 * curl and local previews are permitted.
 *
 * Never uses `'*'`: the browser calls this API with `credentials: 'include'`,
 * so a wildcard origin is both invalid and unsafe.
 */
export function buildCorsOptions(origins: string[]): CorsOptions {
  return {
    origin(origin, callback) {
      // Same-origin / curl / health checks
      if (!origin) return callback(null, true)
      // Explicit allow-list wins when configured (production). Never '*': the
      // browser calls this API with credentials: 'include', so a wildcard
      // origin is invalid and would be rejected by browsers anyway.
      if (origins.length > 0 && origins.includes(origin)) {
        return callback(null, true)
      }
      // Dev / preview mode: when no explicit allow-list is configured, allow all origins.
      // Safe because the API uses bearer tokens (not cookies) — CORS is defense-in-depth only.
      if (origins.length === 0) return callback(null, true)
      return callback(new Error('Not allowed by CORS'))
    },
    // The dashboard frontend sends credentials: 'include', so credentialed
    // CORS must be enabled and paired with the explicit origin allow-list.
    credentials: true,
    // Only what the dashboard API actually uses (see client/src/lib/api.ts).
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    // Make the rate-limiter's Retry-After readable from the browser so the
    // dashboard can show when a 429'd request may be retried (cross-origin
    // headers are otherwise opaque to JavaScript).
    exposedHeaders: ['Retry-After'],
    maxAge: 86_400,
  }
}
