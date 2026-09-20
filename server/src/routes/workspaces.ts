/**
 * Workspaces routes — registration metadata only.
 *
 * The workspaces table deliberately has no owner, content, or activity
 * columns. These endpoints therefore cannot expose customer workspace data,
 * and no join to accounts exists by design.
 */
import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { toWorkspace, type WorkspaceRow } from '../format'

const router = Router()

const ListQuery = z.object({
  search: z.string().max(200).optional(),
  plan: z.enum(['free', 'pro', 'team', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
})

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
      conditions.push(`name ILIKE $${params.length} ESCAPE '\\'`)
    }
    if (q.plan && q.plan !== 'all') {
      params.push(q.plan)
      conditions.push(`plan = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const pageSize = q.pageSize ?? 25
    const page = q.page ?? 1
    const offset = (page - 1) * pageSize

    const totalRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workspaces ${where}`,
      params,
    )
    const rows = await query<WorkspaceRow>(
      `SELECT id, name, member_count, plan, created_at
       FROM workspaces ${where}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    )

    res.json({
      items: rows.map(toWorkspace),
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
    const rows = await query<{
      total: string
      new30d: string
      pro: string
      team: string
      avg_members: string
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::text AS new30d,
         COUNT(*) FILTER (WHERE plan = 'pro')::text AS pro,
         COUNT(*) FILTER (WHERE plan = 'team')::text AS team,
         COALESCE(ROUND(AVG(member_count)), 0)::text AS avg_members
       FROM workspaces`,
    )
    const r = rows[0]
    const total = Number(r?.total ?? 0)
    res.json({
      total,
      newWorkspaces30d: Number(r?.new30d ?? 0),
      avgMembersPerWorkspace: total > 0 ? Number(r?.avg_members ?? 0) : 0,
      proWorkspaces: Number(r?.pro ?? 0),
      teamWorkspaces: Number(r?.team ?? 0),
    })
  } catch (err) {
    next(err)
  }
})

export default router
