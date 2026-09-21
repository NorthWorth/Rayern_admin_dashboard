/**
 * Platform Metrics routes — aggregate-only statistics.
 *
 * Every value here is a COUNT or grouped count over privacy-safe tables.
 * There are no per-user, per-workspace, or behavioral series — no DAU/WAU/MAU,
 * no activation funnels, no per-workspace usage analytics.
 *
 * Data source precedence:
 *  1. The latest aggregates synchronized from the Rayern API by the dashboard
 *     pull-sync worker (rayern_sync_state) — the intended production source.
 *  2. The dashboard's own local registry (accounts/workspaces tables), used
 *     when Rayern synchronization has not produced data yet (fresh installs,
 *     dev, or sync not configured).
 */
import { Router } from 'express'
import { query } from '../db'
import { config } from '../config'

const router = Router()

interface AccountsAggregate {
  totalAccounts: number
  newAccounts30d: number
  verifiedAccounts: number
  unverifiedAccounts: number
  deletedAccounts30d: number
  deletionRequestsPending: number
  registrationsTrend: Array<{ date: string; count: number }>
  planBreakdown: Array<{ plan: string; count: number }>
}

interface WorkspacesAggregate {
  totalWorkspaces: number
  newWorkspaces30d: number
  avgMembersPerWorkspace: number
  planBreakdown: Array<{ plan: string; count: number }>
}

interface SyncedStateRow {
  key: string
  payload: unknown
  updated_at: Date
}

/** Reads the latest synchronized aggregates, if the pull-sync has stored any. */
async function readSyncedAggregates(): Promise<{
  accounts: AccountsAggregate | null
  workspaces: WorkspacesAggregate | null
  syncedAt: string | null
}> {
  const rows = await query<SyncedStateRow>(
    `SELECT key, payload, updated_at FROM rayern_sync_state WHERE key IN ('accounts', 'workspaces')`,
  )
  let accounts: AccountsAggregate | null = null
  let workspaces: WorkspacesAggregate | null = null
  let latest: Date | null = null
  for (const row of rows) {
    if (latest === null || row.updated_at > latest) latest = row.updated_at
    if (row.key === 'accounts') accounts = row.payload as AccountsAggregate
    if (row.key === 'workspaces') workspaces = row.payload as WorkspacesAggregate
  }
  return { accounts, workspaces, syncedAt: latest ? latest.toISOString() : null }
}

function accountCountsFromLocal(rows: Array<Record<string, string>>): {
  total: number
  new30d: number
  verified: number
  unverified: number
  deleted30d: number
} {
  const r = rows[0]
  return {
    total: Number(r?.total ?? 0),
    new30d: Number(r?.new30d ?? 0),
    verified: Number(r?.verified ?? 0),
    unverified: Number(r?.unverified ?? 0),
    deleted30d: Number(r?.deleted30d ?? 0),
  }
}

router.get('/overview', async (_req, res, next) => {
  try {
    const synced = await readSyncedAggregates()

    /* ------------------- Preferred source: synced aggregates ------------------ */
    if (synced.accounts) {
      const a = synced.accounts
      const w = synced.workspaces
      const planOrder = ['free', 'pro', 'team'] as const
      const localPlanRows = w
        ? []
        : await query<{ plan: string; count: string }>(`SELECT plan, COUNT(*)::text AS count FROM workspaces GROUP BY plan`)
      const planMap = new Map((w?.planBreakdown ?? localPlanRows.map((r) => ({ plan: r.plan, count: Number(r.count) }))).map((p) => [p.plan, p.count]))

      res.json({
        registeredAccounts: a.totalAccounts,
        newAccounts30d: a.newAccounts30d,
        verifiedAccounts: a.verifiedAccounts,
        unverifiedAccounts: a.unverifiedAccounts,
        deletedAccounts30d: a.deletedAccounts30d,
        deletionRequestsPending: a.deletionRequestsPending,
        totalWorkspaces: w?.totalWorkspaces ?? 0,
        registrationsTrend: a.registrationsTrend,
        planBreakdown: planOrder.map((plan) => ({ plan, count: planMap.get(plan) ?? 0 })),
        dataSource: 'rayern-sync' as const,
        syncedAt: synced.syncedAt,
      })
      return
    }

    /* --------------- Fallback source: local dashboard registry ---------------- */
    const accountRows = await query<{
      total: string
      new30d: string
      verified: string
      unverified: string
      deleted30d: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status <> 'closed')::text AS total,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::text AS new30d,
         COUNT(*) FILTER (WHERE verification = 'verified' AND status <> 'closed')::text AS verified,
         COUNT(*) FILTER (WHERE verification <> 'verified' AND status <> 'closed')::text AS unverified,
         COUNT(*) FILTER (WHERE status = 'closed' AND created_at >= now() - interval '30 days')::text AS deleted30d
       FROM accounts`,
    )
    const a = accountCountsFromLocal(accountRows)

    const pendingRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM accounts WHERE status = 'closed'`,
    )

    const workspaceRows = await query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM workspaces`,
    )

    const trendDays = Math.min(Math.max(config.registrationTrendDays, 7), 365)
    const trendRows = await query<{ day: string; count: string }>(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(a.id)::text AS count
       FROM generate_series(
         (now() - make_interval(days => $1 - 1))::date,
         now()::date,
         interval '1 day'
       ) AS d(day)
       LEFT JOIN accounts a
         ON a.created_at::date = d.day AND a.status <> 'closed'
       GROUP BY d.day
       ORDER BY d.day`,
      [trendDays],
    )

    const planRows = await query<{ plan: string; count: string }>(
      `SELECT plan, COUNT(*)::text AS count FROM workspaces GROUP BY plan`,
    )

    const planOrder = ['free', 'pro', 'team'] as const
    const planMap = new Map(planRows.map((r) => [r.plan, Number(r.count)]))

    res.json({
      registeredAccounts: a.total,
      newAccounts30d: a.new30d,
      verifiedAccounts: a.verified,
      unverifiedAccounts: a.unverified,
      deletedAccounts30d: a.deleted30d,
      deletionRequestsPending: Number(pendingRows[0]?.count ?? 0),
      totalWorkspaces: Number(workspaceRows[0]?.total ?? 0),
      registrationsTrend: trendRows.map((r) => ({ date: r.day, count: Number(r.count) })),
      planBreakdown: planOrder.map((plan) => ({ plan, count: planMap.get(plan) ?? 0 })),
      dataSource: 'local-registry' as const,
      syncedAt: null,
    })
  } catch (err) {
    next(err)
  }
})

export default router
