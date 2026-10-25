import { z } from 'zod'
import type { AdminMetricPayload } from './types'

/**
 * Approved aggregate contract for the Rayern pull-sync.
 *
 * IMPORTANT: this schema is the privacy contract with Rayern. Zod strips
 * every field that is not explicitly listed, so unexpected or private fields
 * never reach storage. Unknown top-level keys are still dropped.
 */
const untrackedInt = z.preprocess(
  (v) => (v === null || v === undefined ? 0 : v),
  z.number().int().min(0),
)

const untrackedNum = z.preprocess(
  (v) => (v === null || v === undefined ? 0 : v),
  z.number().min(0),
)

const untrackedPct = z.preprocess(
  (v) => (v === null || v === undefined ? 100 : v),
  z.number().min(0).max(100),
)

const untrackedList = <S extends z.ZodTypeAny>(inner: S, max: number) =>
  z.preprocess(
    (v) => (v === null || v === undefined ? [] : v),
    z.array(inner).max(max),
  )

const AccountPlanBreakdownEntry = z.object({
  plan: z.string().min(1).max(50),
  count: untrackedInt,
})

const MrrByPlanEntry = z.object({
  plan: z.string().min(1).max(50),
  subscriberCount: untrackedInt,
  mrrMinor: z.number().int().min(0),
})

const PlanBreakdownEntry = z.object({
  plan: z.string().min(1).max(50),
  userCount: z.number().int().min(0),
  subscriptionCount: z.number().int().min(0),
  isPaid: z.boolean(),
})

export const SyncPayload = z.object({
  accounts: z
    .object({
      totalAccounts: z.number().int().min(0),
      newAccounts30d: untrackedInt,
      verifiedAccounts: untrackedInt,
      unverifiedAccounts: untrackedInt,
      deletedAccounts30d: z.number().int().min(0).nullable(),
      deletionRequestsPending: z.number().int().min(0).nullable(),
      registrationsTrend: untrackedList(
        z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: untrackedInt }),
        400,
      ),
      planBreakdown: untrackedList(AccountPlanBreakdownEntry, 20),
    })
    .nullable()
    .optional(),
  workspaces: z
    .object({
      totalWorkspaces: z.number().int().min(0),
      newWorkspaces30d: untrackedInt,
      avgMembersPerWorkspace: untrackedNum,
      planBreakdown: untrackedList(AccountPlanBreakdownEntry, 20),
    })
    .nullable()
    .optional(),
  billing: z
    .object({
      currency: z.literal('USD'),
      amountUnit: z.literal('minor_units'),
      generatedAt: z.string().datetime(),
      activePaidSubscribers: z.number().int().min(0),
      freeUsers: z.number().int().min(0),
      totalAccounts: z.number().int().min(0),
      mrr: z.object({
        amountMinor: z.number().int().min(0),
        amountMajor: z.number(),
        byPlan: untrackedList(MrrByPlanEntry, 20),
      }),
      arr: z.object({
        amountMinor: z.number().int().min(0),
        amountMajor: z.number(),
        definition: z.string(),
      }),
      planBreakdown: untrackedList(PlanBreakdownEntry, 20),
      definitions: z.record(z.unknown()),
    })
    .nullable()
    .optional(),
  services: z
    .array(
      z.object({
        service: z.string().min(1).max(100),
        kind: z.enum(['api', 'database', 'cache', 'queue', 'email', 'storage']),
        status: z.enum(['healthy', 'degraded', 'failing']),
        uptimePct30d: untrackedPct.nullable(),
        latencyMsP50: untrackedNum.nullable(),
        latencyMsP95: untrackedNum.nullable(),
        lastIncidentAt: z.string().datetime().nullable().default(null),
      }),
    )
    .max(20)
    .nullable()
    .optional(),
  telemetry: z.record(z.unknown()).nullable().optional(),
})

export type SyncPayloadData = z.infer<typeof SyncPayload>

/**
 * Unwrap the Rayern envelope. Rayern wraps successful responses as:
 *
 *   { success: true, data: <payload> }
 *
 * and error responses as:
 *
 *   { success: false, error: { code, message } }
 *
 * Unknown shapes are returned unchanged so a future direct payload still works,
 * but an explicit failure stops the sync without storing anything.
 */
export function unwrapRayernEnvelope(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: true, value: raw }
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj.success === 'boolean') {
    if (!obj.success) {
      const message =
        typeof obj.error === 'object' &&
        obj.error !== null &&
        'message' in obj.error
          ? String((obj.error as { message?: unknown }).message)
          : 'Rayern reported failure without a message'
      return { ok: false, error: `Rayern metrics request reported success=false: ${message.slice(0, 200)}` }
    }

    return { ok: true, value: obj.data ?? {} }
  }

  return { ok: true, value: raw }
}

/**
 * Persist the validated payload so the dashboard API can serve it later.
 *
 * Storage uses the same `rayern_sync_state` table as the existing sync.
 * Billing is stored under its own key so it can be refreshed independently
 * without disturbing accounts/workspaces.
 */
export async function storePayload(data: SyncPayloadData): Promise<string[]> {
  const sections: string[] = []

  const upsertState = async (key: string, value: unknown): Promise<void> => {
    await query(
      `INSERT INTO rayern_sync_state (key, payload, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [key, JSON.stringify(value)],
    )
  }

  if (data.accounts !== undefined && data.accounts !== null) {
    await upsertState('accounts', data.accounts)
    sections.push('accounts')
  }

  if (data.workspaces !== undefined && data.workspaces !== null) {
    await upsertState('workspaces', data.workspaces)
    sections.push('workspaces')
  }

  if (data.billing !== undefined && data.billing !== null) {
    await upsertState('billing', data.billing)
    sections.push('billing')
  }

  if (data.services !== undefined && data.services !== null && data.services.length > 0) {
    for (const s of data.services) {
      await query(
        `INSERT INTO service_health (service, kind, status, uptime_pct_30d, latency_p50, latency_p95, last_incident_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (service, kind) DO UPDATE SET
           status = EXCLUDED.status,
           uptime_pct_30d = EXCLUDED.uptime_pct_30d,
           latency_p50 = EXCLUDED.latency_p50,
           latency_p95 = EXCLUDED.latency_p95,
           last_incident_at = EXCLUDED.last_incident_at`,
        [
          s.service,
          s.kind,
          s.status,
          s.uptimePct30d,
          s.latencyMsP50,
          s.latencyMsP95,
          s.lastIncidentAt,
        ],
      )
    }
    await upsertState('services', data.services)
    sections.push('services')
  }

  if (data.telemetry !== undefined && data.telemetry !== null) {
    await upsertState('telemetry', data.telemetry)
    sections.push('telemetry')
  }

  return sections
}

/**
 * Read the latest synchronized aggregates from `rayern_sync_state`.
 *
 * Returns whichever sections have been persisted, with a shared
 * `syncedAt` timestamp taken from the most recent write.
 */
export async function readSyncedAggregates(): Promise<{
  accounts: SyncPayloadData['accounts']
  workspaces: SyncPayloadData['workspaces']
  billing: SyncPayloadData['billing']
  services: SyncPayloadData['services']
  telemetry: SyncPayloadData['telemetry']
  syncedAt: string | null
}> {
  const rows = await query<{ key: string; payload: unknown; updated_at: Date }>(
    `SELECT key, payload, updated_at
     FROM rayern_sync_state
     WHERE key IN ('accounts', 'workspaces', 'billing', 'services', 'telemetry')`,
  )

  let accounts: SyncPayloadData['accounts'] = undefined as unknown as SyncPayloadData['accounts']
  let workspaces: SyncPayloadData['workspaces'] = undefined as unknown as SyncPayloadData['workspaces']
  let billing: SyncPayloadData['billing'] = undefined as unknown as SyncPayloadData['billing']
  let services: SyncPayloadData['services'] = undefined as unknown as SyncPayloadData['services']
  let telemetry: SyncPayloadData['telemetry'] = undefined as unknown as SyncPayloadData['telemetry']
  let latest: Date | null = null

  for (const row of rows) {
    if (latest === null || row.updated_at > latest) {
      latest = row.updated_at
    }
    switch (row.key) {
      case 'accounts':
        accounts = row.payload as SyncPayloadData['accounts']
        break
      case 'workspaces':
        workspaces = row.payload as SyncPayloadData['workspaces']
        break
      case 'billing':
        billing = row.payload as SyncPayloadData['billing']
        break
      case 'services':
        services = row.payload as SyncPayloadData['services']
        break
      case 'telemetry':
        telemetry = row.payload as SyncPayloadData['telemetry']
        break
    }
  }

  return {
    accounts,
    workspaces,
    billing,
    services,
    telemetry,
    syncedAt: latest ? latest.toISOString() : null,
  }
}

// Re-export query because this module already owns the persistence helpers.
import { query } from './db'
