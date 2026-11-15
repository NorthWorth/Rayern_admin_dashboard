import { z } from 'zod'
import { query } from './db'
import {
  SyncPayload,
  storePayload,
  storeInstrumentation,
  extractInstrumentation,
  unwrapRayernEnvelope,
  writeCachedRayernLogs,
  markPushSyncSuccess,
  type SyncPayloadData,
} from './rayernSync'

export interface IngestionStatus {
  enabled: boolean
  lastSnapshotId: string | null
  lastReceivedAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  consecutiveFailures: number
}

export interface IngestionResult {
  ok: boolean
  idempotent?: boolean
  snapshotId?: string
  sections?: string[]
  error?: string
  status?: number
}

const SnapshotPayload = SyncPayload.extend({
  snapshotId: z.string().min(1).max(128),
  generatedAt: z.string().datetime().optional(),
  version: z.string().max(64).optional(),
})

export type SnapshotPayloadData = z.infer<typeof SnapshotPayload>

async function readIngestionStatusRow(): Promise<{
  last_snapshot_id: string | null
  last_received_at: Date | null
  last_success_at: Date | null
  last_failure_at: Date | null
  last_error: string | null
  consecutive_failures: number
  enabled: boolean
} | null> {
  try {
    const rows = await query<{
      last_snapshot_id: string | null
      last_received_at: Date | null
      last_success_at: Date | null
      last_failure_at: Date | null
      last_error: string | null
      consecutive_failures: number
      enabled: boolean
    }>(`SELECT last_snapshot_id, last_received_at, last_success_at, last_failure_at, last_error, consecutive_failures, enabled FROM rayern_ingestion_status WHERE id = 1`)
    return rows[0] ?? null
  } catch {
    return null
  }
}

async function markIngestionSuccess(snapshotId: string): Promise<void> {
  await query(
    `INSERT INTO rayern_ingestion_status (id, last_snapshot_id, last_received_at, last_success_at, last_failure_at, last_error, consecutive_failures, enabled, updated_at)
     VALUES (1, $1, now(), now(), NULL, NULL, 0, true, now())
     ON CONFLICT (id) DO UPDATE SET
       last_snapshot_id = EXCLUDED.last_snapshot_id,
       last_received_at = now(),
       last_success_at = now(),
       last_failure_at = NULL,
       last_error = NULL,
       consecutive_failures = 0,
       enabled = true,
       updated_at = now()`,
    [snapshotId],
  )
  // Push delivery moves the canonical "last successful sync" metadata too.
  await markPushSyncSuccess()
}

async function markIngestionFailure(error: string): Promise<void> {
  await query(
    `INSERT INTO rayern_ingestion_status (id, last_snapshot_id, last_received_at, last_success_at, last_failure_at, last_error, consecutive_failures, enabled, updated_at)
     VALUES (1, NULL, now(), NULL, now(), $1, 1, true, now())
     ON CONFLICT (id) DO UPDATE SET
       last_received_at = now(),
       last_failure_at = now(),
       last_error = $1,
       consecutive_failures = rayern_ingestion_status.consecutive_failures + 1,
       updated_at = now()`,
    [error.slice(0, 500)],
  )
}

async function snapshotExists(snapshotId: string): Promise<boolean> {
  const rows = await query<{ snapshot_id: string }>(
    `SELECT snapshot_id FROM rayern_snapshots WHERE snapshot_id = $1`,
    [snapshotId],
  )
  return rows.length > 0
}

async function recordSnapshot(snapshotId: string, payload: unknown, status: 'success' | 'failed', error?: string, generatedAt?: string): Promise<void> {
  await query(
    `INSERT INTO rayern_snapshots (snapshot_id, received_at, payload, status, error, generated_at)
     VALUES ($1, now(), $2, $3, $4, $5)
     ON CONFLICT (snapshot_id) DO UPDATE SET
       received_at = now(),
       payload = EXCLUDED.payload,
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       generated_at = EXCLUDED.generated_at`,
    [snapshotId, JSON.stringify(payload), status, error ?? null, generatedAt ?? null],
  )
}

/**
 * Ingest one Rayern snapshot. Returns a result the route can render.
 * Never throws: storage problems are recorded as failures.
 */
export async function ingestRayernSnapshot(raw: unknown): Promise<IngestionResult> {
  const unwrapped = unwrapRayernEnvelope(raw)
  if (!unwrapped.ok) {
    const msg = unwrapped.error
    try {
      await markIngestionFailure(msg)
    } catch {
      // ignore
    }
    return { ok: false, status: 400, error: msg }
  }

  const parsed = SnapshotPayload.safeParse(unwrapped.value)
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 12).map((i) => i.path.join('.') || 'root')
    const msg = `Snapshot failed validation (${parsed.error.issues.length} issue(s); paths: ${paths.join(',') || 'root'})`
    try {
      await markIngestionFailure(msg)
    } catch {
      // ignore
    }
    return { ok: false, status: 400, error: msg }
  }

  const data = parsed.data
  const snapshotId = data.snapshotId

  // Idempotency: a repeat delivery of the same snapshot id is a success, but
  // it must NOT advance the canonical success timestamp — a redelivery of an
  // old snapshot would otherwise make the sync look fresher than it is.
  try {
    if (await snapshotExists(snapshotId)) {
      return { ok: true, idempotent: true, snapshotId, sections: [] }
    }
  } catch {
    // fall through
  }

  // Out-of-order protection: a snapshot generated before the newest successful
  // one cannot overwrite newer sync metadata. It is accepted as a benign
  // duplicate and ignored.
  if (data.generatedAt) {
    try {
      const latest = await query<{ generated_at: string | null }>(
        `SELECT generated_at FROM rayern_snapshots
         WHERE status = 'success' AND generated_at IS NOT NULL
         ORDER BY generated_at DESC LIMIT 1`,
      )
      const newest = latest[0]?.generated_at ?? null
      if (newest !== null && data.generatedAt < newest) {
        return { ok: true, idempotent: true, snapshotId, sections: [] }
      }
    } catch {
      // fall through
    }
  }

  try {
    const sections = await storePayload(data as unknown as SyncPayloadData)
    const { blocks, present, rejected } = extractInstrumentation(unwrapped.value)
    if (rejected.length > 0) {
      console.log(`[rayern-ingestion] instrumentation block(s) dropped: ${rejected.join(',')}`)
    }
    let instrumentationSections: string[] = []
    if (present.length > 0) {
      try {
        instrumentationSections = await storeInstrumentation(blocks)
      } catch (storeErr) {
        console.error('[rayern-ingestion] failed to persist instrumentation blocks:', storeErr)
      }
    }
    sections.push(...instrumentationSections)

    // Optional logs cache in snapshot payload (push-based). Ordinary dashboard
    // refresh reads cached logs from the local DB and never contacts Rayern.
    try {
      const raw = unwrapped.value as Record<string, unknown>
      const logsValue = raw.logs ?? raw.serverLogs ?? raw.logEntries
      const entries = Array.isArray(logsValue)
        ? logsValue
        : logsValue && typeof logsValue === 'object' && !Array.isArray(logsValue)
          ? (Array.isArray((logsValue as { entries?: unknown }).entries)
              ? ((logsValue as { entries: unknown[] }).entries)
              : Array.isArray((logsValue as { logs?: unknown }).logs)
                ? ((logsValue as { logs: unknown[] }).logs)
                : null)
          : null
      if (entries) {
        await writeCachedRayernLogs(entries, { fetchedAt: new Date().toISOString(), source: 'snapshot' })
        sections.push('logs')
      }
    } catch (logErr) {
      console.error('[rayern-ingestion] failed to cache logs from snapshot:', logErr)
    }

    await recordSnapshot(snapshotId, unwrapped.value, 'success', undefined, data.generatedAt)
    await markIngestionSuccess(snapshotId)

    console.log(`[rayern-ingestion] snapshot ${snapshotId} persisted: sections=${sections.join(',') || 'none'}`)
    return { ok: true, snapshotId, sections }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown ingestion error'
    try {
      await recordSnapshot(snapshotId, unwrapped.value, 'failed', msg, data.generatedAt)
      await markIngestionFailure(msg)
    } catch {
      // ignore
    }
    return { ok: false, status: 500, error: msg, snapshotId }
  }
}

export async function getIngestionStatus(): Promise<IngestionStatus> {
  const row = await readIngestionStatusRow()
  const enabled = Boolean(process.env.RAYERN_SNAPSHOT_TOKEN?.trim())
  if (!row) {
    return {
      enabled,
      lastSnapshotId: null,
      lastReceivedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      consecutiveFailures: 0,
    }
  }
  return {
    enabled,
    lastSnapshotId: row.last_snapshot_id,
    lastReceivedAt: row.last_received_at ? row.last_received_at.toISOString() : null,
    lastSuccessAt: row.last_success_at ? row.last_success_at.toISOString() : null,
    lastFailureAt: row.last_failure_at ? row.last_failure_at.toISOString() : null,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures ?? 0,
  }
}

