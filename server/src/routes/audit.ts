/**
 * Audit route — administrative/system events performed through the dashboard.
 * Not a window into customer activity; only dashboard-originated events exist.
 */
import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { toAuditEvent, type AuditRow } from '../format'

const router = Router()

const ListQuery = z.object({
  search: z.string().max(200).optional(),
  actorKind: z.enum(['admin', 'system', 'all']).optional(),
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
      const p = params.length
      conditions.push(
        `(actor ILIKE $${p} ESCAPE '\\' OR action ILIKE $${p} ESCAPE '\\' OR target ILIKE $${p} ESCAPE '\\' OR metadata::text ILIKE $${p} ESCAPE '\\')`,
      )
    }
    if (q.actorKind && q.actorKind !== 'all') {
      params.push(q.actorKind)
      conditions.push(`actor_kind = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await query<AuditRow>(
      `SELECT id, actor, actor_kind, action, target, metadata, timestamp
       FROM audit_events ${where} ORDER BY timestamp DESC LIMIT 500`,
      params,
    )
    res.json(rows.map(toAuditEvent))
  } catch (err) {
    next(err)
  }
})

export default router
