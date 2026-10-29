/**
 * Rayern instrumentation routes (dashboard side, admin-only).
 *
 *   GET /rayern/blocks               — the 8 synced metric blocks (from pull-sync)
 *   GET /rayern/logs                 — server→server proxy to /internal/logs
 *   GET /rayern/synthetic-monitoring — server→server proxy to /internal/synthetic-monitoring
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
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: 504,
      code: aborted ? 'RAYERN_TIMEOUT' : 'RAYERN_UNREACHABLE',
      message: aborted
        ? `Rayern did not respond within ${config.rayern.timeoutMs}ms.`
        : 'Could not reach the Rayern API.',
      requestId: null,
    }
  } finally {
    clearTimeout(timer)
  }

  const requestId = res.headers.get('x-request-id')
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
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
    return { ok: false, status: 502, code: 'RAYERN_REPORTED_FAILURE', message: unwrapped.error, requestId }
  }
  return { ok: true, value: unwrapped.value, requestId }
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

export default rayernInternalRouter
