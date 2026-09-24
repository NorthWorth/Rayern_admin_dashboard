/**
 * Errors routes — operational debugging info for dashboard/platform services.
 * Contains service/endpoint/status/message/trace — never customer content.
 */
import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'

const router = Router()

const ListQuery = z.object({
  search: z.string().max(200).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical', 'all']).optional(),
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
        `(service ILIKE $${p} ESCAPE '\\' OR endpoint ILIKE $${p} ESCAPE '\\' OR message ILIKE $${p} ESCAPE '\\' OR trace_id ILIKE $${p} ESCAPE '\\')`,
      )
    }
    if (q.severity && q.severity !== 'all') {
      params.push(q.severity)
      conditions.push(`severity = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await query<{
      id: string
      severity: string
      service: string
      endpoint: string
      method: string
      status_code: number
      message: string
      trace_id: string | null
      count: number
      first_seen_at: Date
      last_seen_at: Date
    }>(
      `SELECT id, severity, service, endpoint, method, status_code, message, trace_id, count, first_seen_at, last_seen_at
       FROM errors ${where} ORDER BY last_seen_at DESC LIMIT 500`,
      params,
    )

    res.json(
      rows.map((r) => ({
        id: r.id,
        severity: r.severity,
        service: r.service,
        endpoint: r.endpoint,
        method: r.method,
        statusCode: r.status_code,
        // Bounded status class (2xx/3xx/4xx/5xx) for grouping — derived from
        // the status code only, never from user-controlled content.
        statusClass: r.status_code >= 100 && r.status_code < 600 ? `${Math.floor(r.status_code / 100)}xx` : 'n/a',
        message: r.message,
        traceId: r.trace_id ?? null,
        count: r.count,
        firstSeenAt: r.first_seen_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
      })),
    )
  } catch (err) {
    next(err)
  }
})

export default router
