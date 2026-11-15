/**
 * Rayern instrumentation routes (dashboard side, admin-only).
 *
 *   GET /rayern/blocks                — the 8 synced metric blocks (from pull-sync / snapshot ingestion)
 *   GET /rayern/logs                  — cached log entries from the local database (no outbound Rayern call)
 *   GET /rayern/synthetic-monitoring  — locally stored synthetic block from the last snapshot (no outbound Rayern call)
 *   GET /rayern/sync-diagnostics      — this backend's own failed outbound calls
 *   GET /rayern/snapshot-status       — snapshot ingestion status
 *
 * Security model:
 *  - Mounted behind `requireAdmin`; a browser session JWT is the only thing the
 *    browser presents.
 *  - Ordinary dashboard refresh/read paths must not initiate outbound Rayern
 *    requests. Logs and synthetic monitoring are served from locally persisted
 *    data populated by snapshot ingestion or scheduled background refresh.
 *  - The Rayern monitoring token never leaves this process and is never echoed,
 *    logged or serialized.
 *  - There is no wildcard proxy. Any outbound path used by scheduled/background
 *    refresh is a hard-coded literal.
 *  - Responses are rebuilt from an allow-list of fields rather than passed
 *    through wholesale.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { readInstrumentationBlocks, readCachedRayernLogs } from '../rayernSync'
import { getIngestionStatus } from '../rayernIngestion'
import { normalizeInstrumentation, normalizeSynthetic } from '../instrumentation'
import { listSyncDiagnostics, MAX_SYNC_DIAGNOSTICS } from '../syncDiagnostics'

export const rayernInternalRouter = Router()

/* ------------------------------ GET /blocks ------------------------------ */

/**
 * The instrumentation blocks persisted from the last Rayern snapshot/pull-sync,
 * normalized into the dashboard's DTOs. Ordinary dashboard refresh reads this
 * from the local database and never performs an outbound Rayern request.
 * Returns `null` per block when Rayern has not (or could not) supply it —
 * missing is never rendered as zero.
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

/* ------------------------------ GET /logs ------------------------------- */

/** Match Rayern's documented retention exactly (7 days, 500 entries). */
const LOG_STORE_MAX_ENTRIES = 500
const LOG_RETENTION_DAYS = 7

const LogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LOG_STORE_MAX_ENTRIES).default(100),
  // A bounded token rather than an invented level taxonomy.
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

function parseLogTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Locally cached Rayern log view.
 *
 * Ordinary dashboard refresh reads from the local database only. The cache is
 * populated by scheduled/background Rayern refresh (or snapshot ingestion paths
 * that include logs), never by this request.
 */
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
    const sinceMs = since ? Date.parse(since) : null

    const cached = await readCachedRayernLogs()
    let rawEntries = Array.isArray(cached.entries) ? cached.entries : []

    if (level) {
      const wanted = level.toLowerCase()
      rawEntries = rawEntries.filter((e) => {
        if (typeof e !== 'object' || e === null || Array.isArray(e)) return false
        const lv = (e as Record<string, unknown>).level
        return typeof lv === 'string' && lv.toLowerCase() === wanted
      })
    }
    if (sinceMs !== null) {
      rawEntries = rawEntries.filter((e) => {
        if (typeof e !== 'object' || e === null || Array.isArray(e)) return false
        const ts = parseLogTimestamp((e as Record<string, unknown>).at)
        // Entries without a parseable timestamp are kept (conservative).
        return ts === null || ts >= sinceMs
      })
    }

    const entries = rawEntries.slice(0, limit).map(sanitizeLogEntry).filter((e): e is LogEntry => e !== null)

    res.json({
      entries,
      meta: {
        source: 'local-cache',
        requestId: null,
        fetchedAt: cached.fetchedAt ?? cached.updatedAt ?? new Date().toISOString(),
        cachedAt: cached.updatedAt,
        level: level ?? null,
        since: since ?? null,
        limit,
        /** The upstream store is bounded and non-durable — never an archive. */
        retentionDays: LOG_RETENTION_DAYS,
        maxEntries: LOG_STORE_MAX_ENTRIES,
        durable: false,
        localOnly: true,
        note:
          cached.updatedAt === null
            ? `No cached Rayern logs are stored yet. Logs are refreshed by scheduled/background Rayern sync, not by ordinary dashboard Update. The upstream store keeps at most ${LOG_STORE_MAX_ENTRIES} entries over the last ${LOG_RETENTION_DAYS} days.`
            : `Cached locally from the last scheduled Rayern refresh (${cached.updatedAt}). Ordinary dashboard Update does not contact Rayern. The upstream store keeps at most ${LOG_STORE_MAX_ENTRIES} entries over the last ${LOG_RETENTION_DAYS} days.`,
      },
    })
  } catch (err) {
    next(err)
  }
})

/* --------------------- GET /synthetic-monitoring ------------------------- */

/**
 * Locally stored synthetic monitoring block.
 *
 * This is the `syntheticMonitoring` instrumentation block persisted from the
 * last Rayern snapshot/pull-sync in the local database. Ordinary dashboard
 * refresh reads it locally and never performs an outbound Rayern request.
 */
rayernInternalRouter.get('/synthetic-monitoring', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { blocks, syncedAt } = await readInstrumentationBlocks()
    const rawSynthetic = blocks.syntheticMonitoring ?? null

    const synthetic = rawSynthetic
      ? normalizeSynthetic(rawSynthetic)
      : normalizeSynthetic({ available: false, reason: 'not_reported', checks: [] })

    res.json({
      synthetic,
      meta: {
        source: 'local-snapshot',
        requestId: null,
        fetchedAt: new Date().toISOString(),
        snapshotSyncedAt: syncedAt,
        durable: true,
        localOnly: true,
        note:
          syncedAt === null
            ? 'No synthetic monitoring block has been stored locally yet. It arrives with Rayern snapshots/scheduled sync; ordinary dashboard Update does not contact Rayern.'
            : `Served from the locally stored Rayern snapshot (last synced ${syncedAt}). Ordinary dashboard Update does not contact Rayern. The probe script itself must still run on an external scheduler.`,
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

/* ----------------------- GET /snapshot-status ---------------------------- */

rayernInternalRouter.get('/snapshot-status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getIngestionStatus()
    res.json({ snapshotStatus: status, fetchedAt: new Date().toISOString() })
  } catch (err) {
    next(err)
  }
})

export default rayernInternalRouter
