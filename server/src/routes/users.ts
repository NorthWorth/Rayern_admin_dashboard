/**
 * Users routes — administrative account data only.
 *
 * Privacy guarantees (server-enforced):
 *  - No per-user detail endpoint exists. There is nothing to drill into.
 *  - No workspace linkage columns exist in the accounts table, so no query
 *    could join accounts to workspace content even accidentally.
 *  - Filters are server-validated to the allowed enum values.
 */
import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { toUser, type AccountRow } from '../format'
import { readSyncedAggregates } from '../rayernSync'

const router = Router()

/** Sum of daily registration counts over the trailing N days (inclusive). */
function registrationsInLastDays(trend: Array<{ date: string; count: number }>, days: number): number {
  if (trend.length === 0) return 0
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (days - 1))
  let sum = 0
  for (const t of trend) {
    const d = new Date(`${t.date}T00:00:00Z`)
    if (!Number.isNaN(d.getTime()) && d.getTime() >= cutoff.getTime()) sum += t.count
  }
  return sum
}

const ListQuery = z.object({
  search: z.string().max(200).optional(),
  verification: z.enum(['verified', 'unverified', 'pending', 'all']).optional(),
  status: z.enum(['active', 'suspended', 'closed', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
})

/** Escapes LIKE metacharacters for safe ILIKE usage. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

router.get('/', async (req, res, next) => {
  try {
    const q = ListQuery.parse(req.query)
    const conditions: string[] = []
    const params: string[] = []

    if (q.search) {
      params.push(`%${escapeLike(q.search)}%`)
      conditions.push(`(name ILIKE $${params.length} ESCAPE '\\' OR email ILIKE $${params.length} ESCAPE '\\')`)
    }
    if (q.verification && q.verification !== 'all') {
      params.push(q.verification)
      conditions.push(`verification = $${params.length}`)
    }
    if (q.status && q.status !== 'all') {
      params.push(q.status)
      conditions.push(`status = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const pageSize = q.pageSize ?? 25
    const page = q.page ?? 1
    const offset = (page - 1) * pageSize

    const totalRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM accounts ${where}`,
      params,
    )
    const rows = await query<AccountRow>(
      `SELECT id, name, email, verification, status, created_at
       FROM accounts ${where}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    )

    res.json({
      items: rows.map(toUser),
      total: Number(totalRows[0]?.count ?? 0),
      page,
      pageSize,
    })
  } catch (err) {
    next(err)
  }
})

router.get('/stats', async (_req, res, next) => {
  try {
    // Preferred source: aggregates synchronized from Rayern. The local accounts
    // table only holds the admin operator (privacy design), so without this
    // precedence the endpoint would always report zeros in production.
    const synced = await readSyncedAggregates()
    if (synced.accounts) {
      const a = synced.accounts
      res.json({
        totalUsers: a.totalAccounts,
        newUsers7d: registrationsInLastDays(a.registrationsTrend, 7),
        verified: a.verifiedAccounts,
        unverified: a.unverifiedAccounts,
        deleted30d: a.deletedAccounts30d,
      })
      return
    }

    const rows = await query<{
      total: string
      new7d: string
      verified: string
      unverified: string
      deleted30d: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status <> 'closed')::text AS total,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::text AS new7d,
         COUNT(*) FILTER (WHERE verification = 'verified' AND status <> 'closed')::text AS verified,
         COUNT(*) FILTER (WHERE verification <> 'verified' AND status <> 'closed')::text AS unverified,
         COUNT(*) FILTER (WHERE status = 'closed' AND created_at >= now() - interval '30 days')::text AS deleted30d
       FROM accounts`,
    )
    const r = rows[0]
    res.json({
      totalUsers: Number(r?.total ?? 0),
      newUsers7d: Number(r?.new7d ?? 0),
      verified: Number(r?.verified ?? 0),
      unverified: Number(r?.unverified ?? 0),
      deleted30d: Number(r?.deleted30d ?? 0),
    })
  } catch (err) {
    next(err)
  }
})

export default router
