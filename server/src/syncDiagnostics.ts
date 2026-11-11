/**
 * Rayern server-to-server diagnostics.
 *
 * The pull-sync and the on-demand internal proxies run on this backend, so the
 * only place where a Rayern failure can be seen *as it happened* is the
 * outbound HTTP call. This module records exactly that:
 *
 *   - HTTP error responses (status, duration, sanitized body, selected headers)
 *   - network failures (fetch rejected)
 *   - timeouts (aborted by the configured timeout)
 *   - upstream responses that arrived but could not be used (invalid envelope,
 *     schema rejection)
 *
 * Design rules, matching the rest of the dashboard:
 *
 *  1. **Never throw.** A diagnostics write is best-effort; a storage problem
 *     must never change sync behaviour or fail a request.
 *  2. **Bounded.** At most `MAX_SYNC_DIAGNOSTICS` rows are retained; older
 *     rows are pruned on write. Message and body excerpts are truncated.
 *  3. **Sanitized before storage.** Bearer tokens, JWTs, emails, password/token
 *     pairs and long hex ids are redacted *before* the value is written, so a
 *     secret can never be read back out through the API. Response headers are
 *     restricted to an allow-list (`Retry-After`, `Server`, `X-*` minus
 *     anything credential-shaped).
 *  4. **Endpoint paths only.** Only the configured endpoint's pathname is
 *     stored — never its query string, and never the monitoring token.
 *
 * This is deliberately separate from Rayern's own `/internal/logs` store: that
 * holds Rayern's *server* errors, while these records describe this
 * dashboard's *outbound* attempts against Rayern.
 */
import { query } from './db'

/** Retained rows. Old rows are pruned on write; nothing is aggregated away. */
export const MAX_SYNC_DIAGNOSTICS = 200
/** Inclusive lower bound allowed on the read API. */
export const MIN_SYNC_DIAGNOSTICS_LIMIT = 1
export const MAX_SYNC_DIAGNOSTICS_LIMIT = MAX_SYNC_DIAGNOSTICS

/**
 * What went wrong. Distinct from the HTTP status: a 500 is `http_error`, a
 * refused connection is `network_error`, and an abort is `timeout`.
 */
export type SyncDiagnosticOutcome =
  | 'http_error'
  | 'network_error'
  | 'timeout'
  | 'invalid_response'

/** Which outbound call produced the record. */
export type SyncDiagnosticSource = 'sync' | 'internal'

export interface SyncDiagnosticInput {
  source: SyncDiagnosticSource
  /** Pathname of the Rayern endpoint (never the query string). */
  endpoint: string
  /** Rayern host only — no scheme, no credentials. */
  host: string
  method: string
  outcome: SyncDiagnosticOutcome
  /** HTTP status when a response was received, otherwise null. */
  status: number | null
  durationMs: number
  /** Short, machine-readable code (`RAYERN_TIMEOUT`, `UPSTREAM_4XX`, …). */
  errorCode: string | null
  /** Already-safe message; it is sanitized again here. */
  message: string
  /** Raw response body text, if any — sanitized and truncated here. */
  responseBody?: string | null
  /** Raw upstream response headers, if any — filtered by allow-list here. */
  responseHeaders?: Headers | null
  requestId?: string | null
}

export interface SyncDiagnostic {
  id: string
  occurredAt: string
  source: SyncDiagnosticSource
  endpoint: string
  host: string
  method: string
  outcome: SyncDiagnosticOutcome
  status: number | null
  durationMs: number
  errorCode: string | null
  message: string
  /** Sanitized response excerpt, or null when no body was returned. */
  responseBody: string | null
  /** Allow-listed response headers only. */
  headers: Record<string, string>
  requestId: string | null
}

/* ------------------------------ sanitizing ------------------------------- */

const MESSAGE_LIMIT = 400
const BODY_LIMIT = 1200
const HEADER_VALUE_LIMIT = 160

/** Header names whose value must never be stored, whatever their prefix. */
const CREDENTIAL_HEADER = /(token|secret|key|auth|cookie|session|password|credential)/i
/** Headers that are safe and genuinely useful when diagnosing an upstream. */
const ALLOWED_EXACT_HEADERS = new Set(['retry-after', 'server', 'date', 'content-type'])

/**
 * Redacts credential-shaped content from arbitrary text.
 *
 * Applied to messages and response bodies before they are persisted. It is
 * intentionally conservative about what it keeps and aggressive about what it
 * removes: an over-redacted diagnostic is recoverable by retrying, a leaked
 * token is not.
 */
export function sanitizeDiagnosticText(input: string, limit = MESSAGE_LIMIT): string {
  let out = input
  // Authorization header echoed in a body or message.
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [redacted]')
  // JWT-shaped values (three base64url segments).
  out = out.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, '[redacted-jwt]')
  // JSON credential pairs: {"password":"…"}, {"apiToken": "…"}
  out = out.replace(
    /("(?:password|passwd|token|accessToken|refreshToken|apiKey|api_key|secret|authorization|monitoringToken)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"',
  )
  // Query/form credential pairs: password=…&token=…
  out = out.replace(
    /\b(password|passwd|token|access_token|refresh_token|api_key|apikey|secret|authorization)=([^&\s"']+)/gi,
    '$1=[redacted]',
  )
  // Query strings in echoed URLs: keep the path, drop the parameters.
  out = out.replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/gi, '$1?[redacted-query]')
  // Email addresses.
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]')
  // Mongo-style / UUID / long hex identifiers.
  out = out.replace(/\b[0-9a-f]{16,}\b/gi, '[redacted-id]')
  // Collapse whitespace so a body excerpt stays on one readable line.
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > limit ? `${out.slice(0, limit)}…` : out
}

/**
 * Keeps only the headers that help explain an upstream failure. `Retry-After`
 * is what tells the UI when another attempt is reasonable; `Server` and `X-*`
 * identify the edge/proxy that answered. Anything credential-shaped is dropped
 * even when it carries an `X-` prefix.
 */
export function pickDiagnosticHeaders(headers: Headers | null | undefined): Record<string, string> {
  if (!headers) return {}
  const picked: Record<string, string> = {}
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (CREDENTIAL_HEADER.test(lower)) return
    if (!ALLOWED_EXACT_HEADERS.has(lower) && !lower.startsWith('x-')) return
    const safe = sanitizeDiagnosticText(String(value), HEADER_VALUE_LIMIT)
    if (safe) picked[lower] = safe
  })
  return picked
}

/**
 * Reads at most `BODY_LIMIT` characters of a response body for diagnostics.
 * Never throws and never consumes the body more than once.
 */
export async function readBodyExcerpt(res: { text(): Promise<string> }): Promise<string | null> {
  try {
    const text = await res.text()
    if (!text) return null
    return text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) : text
  } catch {
    return null
  }
}

/** Classifies a thrown fetch error without leaking its text. */
export function classifyFetchError(err: unknown, timeoutMs: number): {
  outcome: SyncDiagnosticOutcome
  code: string
  message: string
} {
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      outcome: 'timeout',
      code: 'RAYERN_TIMEOUT',
      message: `Rayern did not respond within ${timeoutMs}ms.`,
    }
  }
  // The raw message can contain the URL (with a token if one were ever in a
  // query string) or DNS internals, so only a bounded, sanitized copy is kept.
  const detail = err instanceof Error ? err.message : String(err ?? 'unknown error')
  return {
    outcome: 'network_error',
    code: 'RAYERN_UNREACHABLE',
    message: sanitizeDiagnosticText(detail) || 'Could not reach the Rayern API.',
  }
}

/* ------------------------------- storage --------------------------------- */

interface DiagnosticRow {
  id: string
  occurred_at: Date
  source: string
  endpoint: string
  host: string
  method: string
  outcome: string
  status: number | null
  duration_ms: number | string
  error_code: string | null
  message: string
  response_body: string | null
  headers: unknown
  request_id: string | null
}

function toDiagnostic(row: DiagnosticRow): SyncDiagnostic {
  const headers: Record<string, string> = {}
  if (row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)) {
    for (const [key, value] of Object.entries(row.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  return {
    id: row.id,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    source: row.source === 'internal' ? 'internal' : 'sync',
    endpoint: row.endpoint,
    host: row.host,
    method: row.method,
    outcome: (['http_error', 'network_error', 'timeout', 'invalid_response'] as const).includes(
      row.outcome as SyncDiagnosticOutcome,
    )
      ? (row.outcome as SyncDiagnosticOutcome)
      : 'http_error',
    status: row.status === null ? null : Number(row.status),
    durationMs: Math.max(0, Math.round(Number(row.duration_ms) || 0)),
    errorCode: row.error_code,
    message: row.message,
    responseBody: row.response_body,
    headers,
    requestId: row.request_id,
  }
}

/**
 * Persists one diagnostic record. Never throws: diagnostics are an operational
 * convenience, and failing to record one must not turn into a sync failure.
 */
export async function recordSyncDiagnostic(input: SyncDiagnosticInput): Promise<void> {
  try {
    const headers = pickDiagnosticHeaders(input.responseHeaders)
    await query(
      `INSERT INTO rayern_sync_diagnostics
         (occurred_at, source, endpoint, host, method, outcome, status, duration_ms, error_code, message, response_body, headers, request_id)
       VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.source,
        sanitizeDiagnosticText(input.endpoint, 200),
        sanitizeDiagnosticText(input.host, 200),
        sanitizeDiagnosticText(input.method, 12).toUpperCase(),
        input.outcome,
        input.status,
        Math.max(0, Math.round(input.durationMs)),
        input.errorCode ? sanitizeDiagnosticText(input.errorCode, 60) : null,
        sanitizeDiagnosticText(input.message),
        input.responseBody ? sanitizeDiagnosticText(input.responseBody, BODY_LIMIT) : null,
        JSON.stringify(headers),
        input.requestId ? sanitizeDiagnosticText(input.requestId, 128) : null,
      ],
    )
    // Bounded store: keep the newest MAX_SYNC_DIAGNOSTICS rows only.
    await query(
      `DELETE FROM rayern_sync_diagnostics
       WHERE id NOT IN (
         SELECT id FROM rayern_sync_diagnostics
         ORDER BY occurred_at DESC, id DESC
         LIMIT $1
       )`,
      [MAX_SYNC_DIAGNOSTICS],
    )
  } catch (err) {
    // Safe line only: the error text is not echoed verbatim.
    console.error(
      '[dashboard-sync] could not record a sync diagnostic:',
      err instanceof Error ? err.name : 'unknown error',
    )
  }
}

/** Newest-first diagnostics for the authenticated diagnostics endpoint. */
export async function listSyncDiagnostics(
  limit = 50,
): Promise<{ diagnostics: SyncDiagnostic[]; maxEntries: number }> {
  const bounded = Math.min(
    MAX_SYNC_DIAGNOSTICS_LIMIT,
    Math.max(MIN_SYNC_DIAGNOSTICS_LIMIT, Math.trunc(Number.isFinite(limit) ? limit : 50)),
  )
  const rows = await query<DiagnosticRow>(
    `SELECT id, occurred_at, source, endpoint, host, method, outcome, status,
            duration_ms, error_code, message, response_body, headers, request_id
     FROM rayern_sync_diagnostics
     ORDER BY occurred_at DESC, id DESC
     LIMIT $1`,
    [bounded],
  )
  return { diagnostics: rows.map(toDiagnostic), maxEntries: MAX_SYNC_DIAGNOSTICS }
}
