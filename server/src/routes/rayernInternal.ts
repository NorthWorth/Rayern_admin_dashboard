/**
 * Rayern instrumentation routes (dashboard side, admin-only).
 *
 *   GET /rayern/blocks                — the 8 synced metric blocks (from pull-sync)
 *   GET /rayern/logs                  — server→server proxy to /internal/logs
 *   GET /rayern/synthetic-monitoring  — server→server proxy to /internal/synthetic-monitoring
 *   GET /rayern/sync-diagnostics      — this backend's own failed outbound calls
 *
 * Security model:
 *  - Mounted behind `requireAdmin`; a browser session JWT is the only thing the
 *    browser presents.
 *  - The Rayern monitoring token never leaves this process: it is attached to
 *    the outbound request and is never echoed, logged or serialized.
 *  - There is no wildcard proxy. Each upstream path is a hard-coded literal, so
 *    this cannot be used to reach arbitrary Rayern internals.
 *  - Query parameters are validated and bounded before they are forwarded, and
 *    responses are rebuilt from an allow-list of fields rather than passed
 *    through wholesale.
 *  - Neither logs nor check results are persisted here: both upstream stores are
 *    small and short-lived (500 entries / 7 days; 30 history samples), so they
 *    are fetched on demand instead of being duplicated into the database.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { config, rayernInternalOrigin } from '../config'
import { readInstrumentationBlocks, unwrapRayernEnvelope } from '../rayernSync'
import { normalizeInstrumentation, normalizeSynthetic, type SyntheticMonitoringDto } from '../instrumentation'
import {
  classifyFetchError,
  listSyncDiagnostics,
  MAX_SYNC_DIAGNOSTICS,
  recordSyncDiagnostic,
  type SyncDiagnosticOutcome,
} from '../syncDiagnostics'

export const rayernInternalRouter = Router()

/* ----------------------------- upstream call ----------------------------- */

type UpstreamResult =
  | { ok: true; value: unknown; requestId: string | null }
  | {
      ok: false
      status: number
      code: string
      message: string
      retryAfterSec?: number
      requestId: string | null
    }

/**
 * Bounded GET against a fixed Rayern internal path with the service token.
 * Never throws; every failure becomes a typed result the route can render.
 */
async function callRayernInternal(pathname: string, params: URLSearchParams): Promise<UpstreamResult> {
  const origin = rayernInternalOrigin()
  const token = config.rayern.monitoringToken

  if (!origin) {
    return {
      ok: false,
      status: 503,
      code: 'RAYERN_NOT_CONFIGURED',
      message: 'Rayern API base URL is not configured on the dashboard backend.',
      requestId: null,
    }
  }
  if (!token) {
    // Fail-closed, mirroring Rayern's own monitoring-token gate.
    return {
      ok: false,
      status: 503,
      code: 'RAYERN_MONITORING_TOKEN_NOT_CONFIGURED',
      message: 'The Rayern monitoring token is not configured on the dashboard backend.',
      requestId: null,
    }
  }

  const url = new URL(pathname, origin)
  for (const [key, value] of params) url.searchParams.set(key, value)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.rayern.timeoutMs)
  const startedAt = Date.now()
  // `Response` in this scope is Express's; fetch's response is named explicitly.
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // Server-side only. Never forwarded to the browser.
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
  } catch (err) {
    const info = classifyFetchError(err, config.rayern.timeoutMs)
    await recordInternalFailure(pathname, {
      outcome: info.outcome,
      status: null,
      durationMs: Date.now() - startedAt,
      code: info.code,
      message: info.message,
    })
    return {
      ok: false,
      status: 504,
      code: info.code,
      message:
        info.outcome === 'timeout'
          ? `Rayern did not respond within ${config.rayern.timeoutMs}ms.`
          : 'Could not reach the Rayern API.',
      requestId: null,
    }
  } finally {
    clearTimeout(timer)
  }

  const durationMs = Date.now() - startedAt
  const requestId = res.headers.get('x-request-id')
  // Read the body as text first: an error response still has a body worth
  // recording (sanitized) even when it is not JSON.
  let bodyText: string | null = null
  let body: unknown = null
  try {
    bodyText = await res.text()
    body = bodyText ? JSON.parse(bodyText) : null
  } catch {
    body = null
  }

  if (!res.ok) {
    await recordInternalFailure(pathname, {
      outcome: 'http_error',
      status: res.status,
      durationMs,
      code: res.status === 429 ? 'RAYERN_RATE_LIMITED' : `UPSTREAM_${res.status}`,
      message: `Rayern responded with HTTP ${res.status} ${res.statusText || ''}`.trim(),
      responseBody: bodyText,
      responseHeaders: res.headers,
      requestId,
    })
  } else if (body === null) {
    await recordInternalFailure(pathname, {
      outcome: 'invalid_response',
      status: res.status,
      durationMs,
      code: 'UPSTREAM_INVALID_JSON',
      message: 'Rayern returned a body that could not be parsed as JSON.',
      responseBody: bodyText,
      responseHeaders: res.headers,
      requestId,
    })
  }

  if (!res.ok) {
    const upstreamMessage = readUpstreamErrorMessage(body) ?? 'Rayern rejected the request.'

    // A Rayern rate limit is forwarded as a 429 with its Retry-After intact so
    // the dashboard can say when a retry is reasonable — clearly labelled as
    // RAYERN_RATE_LIMITED so it is never mistaken for the dashboard's own
    // limiter. Everything else becomes 502 (upstream failure).
    if (res.status === 429) {
      const raw = res.headers.get('retry-after')
      const secs = raw !== null ? Number(raw) : Number.NaN
      return {
        ok: false,
        status: 429,
        code: 'RAYERN_RATE_LIMITED',
        message: upstreamMessage,
        retryAfterSec: Number.isFinite(secs) && secs >= 0 ? Math.ceil(secs) : undefined,
        requestId,
      }
    }

    return {
      ok: false,
      status: 502,
      code: res.status === 401 ? 'RAYERN_UNAUTHORIZED' : 'RAYERN_UPSTREAM_ERROR',
      message: upstreamMessage,
      requestId,
    }
  }

  const unwrapped = unwrapRayernEnvelope(body)
  if (!unwrapped.ok) {
    await recordInternalFailure(pathname, {
      outcome: 'invalid_response',
      status: res.status,
      durationMs,
      code: 'RAYERN_REPORTED_FAILURE',
      message: unwrapped.error,
      responseHeaders: res.headers,
      requestId,
    })
    return { ok: false, status: 502, code: 'RAYERN_REPORTED_FAILURE', message: unwrapped.error, requestId }
  }
  return { ok: true, value: unwrapped.value, requestId }
}

/**
 * Records one failed on-demand internal call (logs / synthetic monitoring).
 * Same guarantees as the pull-sync recorder: best-effort, sanitized, bounded,
 * and it never alters the response the route returns.
 */
async function recordInternalFailure(
  pathname: string,
  input: {
    outcome: SyncDiagnosticOutcome
    status: number | null
    durationMs: number
    code: string
    message: string
    responseBody?: string | null
    responseHeaders?: Headers | null
    requestId?: string | null
  },
): Promise<void> {
  let host = 'rayern'
  try {
    host = new URL(rayernInternalOrigin()).host
  } catch {
    // Keep the placeholder — never guess a host.
  }
  await recordSyncDiagnostic({
    source: 'internal',
    endpoint: pathname,
    host,
    method: 'GET',
    outcome: input.outcome,
    status: input.status,
    durationMs: input.durationMs,
    errorCode: input.code,
    message: input.message,
    responseBody: input.responseBody ?? null,
    responseHeaders: input.responseHeaders ?? null,
    requestId: input.requestId ?? null,
  })
}

/** Reads Rayern's `{ success:false, error:{ code, message } }` envelope, if present. */
function readUpstreamErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const error = (body as { error?: unknown }).error
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message.slice(0, 500)
  }
  const message = (body as { message?: unknown }).message
  if (typeof message === 'string' && message) return message.slice(0, 500)
  return null
}

function sendUpstreamError(res: Response, result: Extract<UpstreamResult, { ok: false }>): void {
  const payload: Record<string, unknown> = {
    success: false,
    error: { code: result.code, message: result.message },
    requestId: result.requestId,
  }
  if (result.retryAfterSec !== undefined) {
    res.setHeader('Retry-After', String(result.retryAfterSec))
    ;(payload.error as Record<string, unknown>).retryAfterSec = result.retryAfterSec
  }
  res.status(result.status).json(payload)
}

/* ------------------------------ GET /blocks ------------------------------ */

/**
 * The instrumentation blocks the pull-sync persisted, already normalized into
 * the dashboard's DTOs. Returns `null` per block when Rayern has not (or could
 * not) supply it — missing is never rendered as zero.
 */
rayernInternalRouter.get('/blocks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { blocks, syncedAt } = await readInstrumentationBlocks()
    res.json({
      blocks: normalizeInstrumentation(blocks),
      syncedAt,
      /** Which keys were actually synchronized (absent = never received). */
      received: Object.keys(blocks).sort(),
    })
  } catch (err) {
    next(err)
  }
})

/* ------------------------------- GET /logs ------------------------------- */

/** Match Rayern's documented retention exactly (7 days, 500 entries). */
const LOG_STORE_MAX_ENTRIES = 500
const LOG_RETENTION_DAYS = 7

const LogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LOG_STORE_MAX_ENTRIES).default(100),
  // A bounded token rather than an invented level taxonomy: Rayern owns the
  // vocabulary, so an unknown-but-well-formed value is forwarded as-is.
  level: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/, 'level must be a short alphanumeric token')
    .optional(),
  since: z
    .string()
    .max(40)
    .optional()
    .refine((v) => v === undefined || v === '' || !Number.isNaN(Date.parse(v)), 'since must be an ISO date')
    .refine(
      (v) =>
        v === undefined || v === '' || Date.parse(v) >= Date.now() - LOG_RETENTION_DAYS * 86_400_000,
      `since cannot be older than the ${LOG_RETENTION_DAYS}-day log retention window`,
    ),
})

/** Only these fields cross back to the browser — never a raw upstream object. */
const LOG_ENTRY_FIELDS = ['at', 'level', 'code', 'message', 'status', 'method', 'route', 'requestId'] as const
type LogEntry = Record<string, string | number | null>

function sanitizeLogEntry(raw: unknown): LogEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const src = raw as Record<string, unknown>
  const entry: LogEntry = {}
  for (const field of LOG_ENTRY_FIELDS) {
    const value = src[field]
    if (typeof value === 'string') {
      entry[field] = value.slice(0, 1000)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      entry[field] = value
    } else if (value === null || value === undefined) {
      entry[field] = null
    } else {
      // Objects/arrays are never forwarded (no headers, no bodies, no tokens).
      entry[field] = String(value).slice(0, 200)
    }
  }
  return entry
}

rayernInternalRouter.get('/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = LogsQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_LOG_QUERY',
          message: parsed.error.issues[0]?.message ?? 'Invalid log query',
        },
      })
      return
    }
    const { limit, level } = parsed.data
    const since = parsed.data.since ? parsed.data.since : undefined

    const params = new URLSearchParams()
    params.set('limit', String(limit))
    if (level !== undefined) params.set('level', level)
    if (since !== undefined) params.set('since', since)

    const upstream = await callRayernInternal('/internal/logs', params)
    if (!upstream.ok) {
      sendUpstreamError(res, upstream)
      return
    }

    const value = upstream.value
    const rawEntries = Array.isArray(value)
      ? value
      : Array.isArray((value as { logs?: unknown })?.logs)
        ? ((value as { logs: unknown[] }).logs)
        : Array.isArray((value as { entries?: unknown })?.entries)
          ? ((value as { entries: unknown[] }).entries)
          : []

    const entries = rawEntries.map(sanitizeLogEntry).filter((e): e is LogEntry => e !== null)

    res.json({
      entries,
      meta: {
        source: '/internal/logs',
        requestId: upstream.requestId,
        fetchedAt: new Date().toISOString(),
        level: level ?? null,
        since: since ?? null,
        limit,
        /** The upstream store is bounded and non-durable — never an archive. */
        retentionDays: LOG_RETENTION_DAYS,
        maxEntries: LOG_STORE_MAX_ENTRIES,
        durable: false,
        note: `In-process store: at most ${LOG_STORE_MAX_ENTRIES} entries over the last ${LOG_RETENTION_DAYS} days. Older log lines are not retrievable.`,
      },
    })
  } catch (err) {
    next(err)
  }
})

/* --------------------- GET /synthetic-monitoring ------------------------- */

function extractSyntheticValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

rayernInternalRouter.get('/synthetic-monitoring', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const upstream = await callRayernInternal('/internal/synthetic-monitoring', new URLSearchParams())
    if (!upstream.ok) {
      sendUpstreamError(res, upstream)
      return
    }

    const raw = extractSyntheticValue(upstream.value)
    if (!raw) {
      res.status(502).json({
        success: false,
        error: { code: 'RAYERN_UNRECOGNISED_SHAPE', message: 'Unexpected response shape from Rayern.' },
        requestId: upstream.requestId,
      })
      return
    }

    const dto: SyntheticMonitoringDto = normalizeSynthetic(raw)
    res.json({
      synthetic: dto,
      meta: {
        source: '/internal/synthetic-monitoring',
        requestId: upstream.requestId,
        fetchedAt: new Date().toISOString(),
        durable: false,
        note: 'Produced by an external scheduler running scripts/synthetic-monitor.mjs. The dashboard only displays results.',
      },
    })
  } catch (err) {
    next(err)
  }
})

/* ----------------------- GET /sync-diagnostics ---------------------------- */

const DiagnosticsQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SYNC_DIAGNOSTICS)
    .default(50),
})

/**
 * This backend's own failed outbound Rayern calls.
 *
 * These are captured at the HTTP layer of the pull-sync and the internal
 * proxies, so they describe attempts that never reached (or were rejected by)
 * Rayern — information the browser-side error surfaces cannot show. Records are
 * already sanitized before storage; nothing credential-shaped is returned.
 */
rayernInternalRouter.get('/sync-diagnostics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = DiagnosticsQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUERY', message: 'limit must be an integer between 1 and 200.' },
      })
      return
    }

    const { diagnostics, maxEntries } = await listSyncDiagnostics(parsed.data.limit)
    res.json({
      diagnostics,
      meta: {
        maxEntries,
        retention: 'newest-first bounded store; older failures are discarded',
        fetchedAt: new Date().toISOString(),
        /** Server-to-server only: the monitoring token is never included. */
        note: 'Captured on the dashboard backend for outbound Rayern requests. Never contains credentials or request headers.',
      },
    })
  } catch (err) {
    next(err)
  }
})

export default rayernInternalRouter
