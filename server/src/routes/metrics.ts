import { Router, type Request, type Response, type NextFunction } from 'express'
import { requireAuth } from '../auth'
import { requireAdmin } from '../auth'
import { requireMonitoringToken } from '../auth/monitoringToken'
import { readSyncedAggregates } from '../rayernSync'
import type { AdminMetricAccounts, AdminMetricWorkspaces, AdminMetricBilling, AdminMetricService, AdminMetricPayload } from '../types'

export const metricsRouter = Router()

/**
 * GET /api/v1/admin/metrics
 *
 * Session-admin-only mirror of the internal dashboard-metrics handler.
 * Auth: `requireAuth` + `requireAdmin`. Never public.
 * Rate limited: NO — exempt from every application limiter (exact-path skip in
 * the general limiter; query strings are stripped before comparison so
 * similarly-named paths are NOT exempt).
 * Refresh freely.
 */
metricsRouter.get('/api/v1/admin/metrics', requireAuth, requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = await buildAdminMetricPayload()
    res.json({ success: true, data: payload })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /internal/dashboard-metrics
 *
 * Service-token-gated endpoint for automated dashboard sync/refresh from a
 * trusted backend component. Auth: `requireMonitoringToken` (fail-closed while
 * `RAYERN_MONITORING_TOKEN` is unset).
 * Same handler and same response as `/api/v1/admin/metrics`.
 */
metricsRouter.get('/internal/dashboard-metrics', requireMonitoringToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = await buildAdminMetricPayload()
    res.json({ success: true, data: payload })
  } catch (err) {
    next(err)
  }
})

async function buildAdminMetricPayload(): Promise<AdminMetricPayload> {
  const synced = await readSyncedAggregates()

  const accounts = synced.accounts ?? await readLocalAccountsAggregate()
  const workspaces = synced.workspaces ?? await readLocalWorkspacesAggregate()
  const billing: AdminMetricBilling | null = synced.billing ?? null
  const services: AdminMetricService[] = synced.services ?? []
  const telemetry: Record<string, unknown> = {}

  return { accounts, workspaces, billing, services, telemetry }
}

async function readLocalAccountsAggregate(): Promise<AdminMetricAccounts> {
  const rows = await query<{ total: string; new30d: string; verified: string; unverified: string; deleted30d: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE status <> 'closed')::text AS total,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status <> 'closed')::text AS new30d,
      COUNT(*) FILTER (WHERE verification = 'verified' AND status <> 'closed')::text AS verified,
      COUNT(*) FILTER (WHERE verification <> 'verified' AND status <> 'closed')::text AS unverified,
      COUNT(*) FILTER (WHERE status = 'closed' AND created_at >= now() - interval '30 days')::text AS deleted30d
    FROM accounts
  `)
  const r = rows[0]
  const total = Number(r?.total ?? '0')
  return {
    totalAccounts: total,
    newAccounts30d: Number(r?.new30d ?? '0'),
    verifiedAccounts: Number(r?.verified ?? '0'),
    unverifiedAccounts: Number(r?.unverified ?? '0'),
    deletedAccounts30d: total === 0 ? null : Number(r?.deleted30d ?? '0'),
    deletionRequestsPending: null,
    registrationsTrend: [],
    planBreakdown: [],
  }
}

async function readLocalWorkspacesAggregate(): Promise<AdminMetricWorkspaces> {
  const rows = await query<{ total: string; new30d: string; avgMembers: string }>(`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::text AS new30d,
      ROUND(AVG(member_count)::numeric, 2)::text AS avgMembers
    FROM workspaces
  `)
  const r = rows[0]
  return {
    totalWorkspaces: Number(r?.total ?? '0'),
    newWorkspaces30d: Number(r?.new30d ?? '0'),
    avgMembersPerWorkspace: Number(r?.avgMembers ?? '0'),
  }
}

import { query } from '../db'
export { requireAuth } from '../auth'
