/**
 * Platform Metrics routes — aggregate-only statistics.
 *
 * Every value here is a COUNT or grouped count over privacy-safe tables.
 * There are no per-user, per-workspace, or behavioral series — no DAU/WAU/MAU,
 * no activation funnels, no per-workspace usage analytics.
 */
import { Router } from 'express'
import { query } from '../db'
import { config } from '../config'

const router = Router()

router.get('/overview', async (_req, res, next) => {
  try {
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

    const a = accountRows[0]
    const planOrder = ['free', 'pro', 'team'] as const
    const planMap = new Map(planRows.map((r) => [r.plan, Number(r.count)]))

    res.json({
      registeredAccounts: Number(a?.total ?? 0),
      newAccounts30d: Number(a?.new30d ?? 0),
      verifiedAccounts: Number(a?.verified ?? 0),
      unverifiedAccounts: Number(a?.unverified ?? 0),
      deletedAccounts30d: Number(a?.deleted30d ?? 0),
      deletionRequestsPending: Number(pendingRows[0]?.count ?? 0),
      totalWorkspaces: Number(workspaceRows[0]?.total ?? 0),
      registrationsTrend: trendRows.map((r) => ({ date: r.day, count: Number(r.count) })),
      planBreakdown: planOrder.map((plan) => ({ plan, count: planMap.get(plan) ?? 0 })),
    })
  } catch (err) {
    next(err)
  }
})

export default router
