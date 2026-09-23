/**
 * Emails routes — admin-initiated sending only.
 *
 * Flow: dashboard frontend → dashboard API → Resend → recipients.
 * The Resend API key never leaves the server. Verification/password-reset
 * emails are NOT handled here (they belong to Rayern's own flow).
 *
 * Recipients (spec 18): To/CC/BCC are independent lists. Every address is
 * validated + normalized; duplicates within a field and across fields are
 * removed (address wins in the earliest field: To > CC > BCC) so nobody
 * receives the email twice. The frontend must never be trusted for this —
 * dedup happens again here, server-side.
 *
 * Send rule: sending is allowed when To, CC OR BCC contains at least one
 * recipient; it is rejected only when all three are empty. A CC-only or
 * BCC-only send goes out exactly like that — no To address is ever invented.
 *
 * Body modes: `bodyType` ('text' | 'html') is explicit in the request and is
 * the single source of truth for how the message is sent. The mode is never
 * inferred from the content, and it is persisted with the history record so
 * "copy as new" can reopen the composer in the same mode.
 */
import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { recordAudit, adminActor } from '../audit'
import { sendEmail, senderIdentity, sanitizeEmailHtml, wrapHtmlFragment } from '../emailer'
import { toEmailMessage, type EmailRow, type EmailStatus, type EmailType } from '../format'
import type { Request, Response, NextFunction } from 'express'

const router = Router()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Validates and normalizes a recipient list (0..500 unique addresses). */
function recipientsSchema({ min = 0 }: { min?: number } = {}) {
  return z
    .array(z.string().trim().max(254))
    .min(min)
    .max(500)
    .transform((arr) => {
      // Case-insensitive dedup, keeping the first-seen casing of each address.
      const seen = new Set<string>()
      const out: string[] = []
      for (const addr of arr) {
        const key = addr.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(addr)
      }
      return out
    })
    .refine((arr) => arr.every((a) => EMAIL_RE.test(a)), { message: 'Invalid email address in list' })
}

const SendBody = z
  .object({
    from: z.string().max(320).optional(),
    // Any field may be empty on its own — the cross-field rule below is the
    // single validation for "at least one recipient somewhere".
    to: recipientsSchema().default([]),
    cc: recipientsSchema().default([]),
    bcc: recipientsSchema().default([]),
    subject: z.string().trim().min(1).max(300),
    message: z.string().min(1).max(100_000),
    /** Explicit composer mode: 'html' body → html field, 'text' body → text field. */
    bodyType: z.enum(['text', 'html']).default('text'),
    type: z.enum(['update', 'announcement', 'promotion', 'notice']).optional(),
  })
  .refine((b) => b.to.length + b.cc.length + b.bcc.length > 0, {
    message: 'at least one recipient is required (To, CC, or BCC)',
    path: ['to'],
  })

/**
 * Cross-field recipient hygiene, applied after per-field validation:
 * an address already used in an earlier field is dropped from later fields.
 */
function dedupeAcrossFields(to: string[], cc: string[], bcc: string[]): { to: string[]; cc: string[]; bcc: string[] } {
  const seen = new Set<string>(to.map((a) => a.toLowerCase()))
  const cc2: string[] = []
  for (const addr of cc) {
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    cc2.push(addr)
  }
  const bcc2: string[] = []
  for (const addr of bcc) {
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    bcc2.push(addr)
  }
  return { to, cc: cc2, bcc: bcc2 }
}

/* ------------------------------- History list ------------------------------ */

router.get('/', async (_req, res, next) => {
  try {
    const rows = await query<EmailRow>(
      `SELECT id, resend_id, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, body_type, type, status, sent_at
       FROM emails ORDER BY sent_at DESC LIMIT 500`,
    )
    res.json(rows.map(toEmailMessage))
  } catch (err) {
    next(err)
  }
})

router.get('/stats', async (_req, res, next) => {
  try {
    const totals = await query<{
      total: string
      delivered: string
      failed: string
      bounced: string
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status = 'delivered')::text AS delivered,
         COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
         COUNT(*) FILTER (WHERE status = 'bounced')::text AS bounced
       FROM emails
       WHERE sent_at >= now() - interval '30 days'`,
    )

    const byType = await query<{ type: string; count: string }>(
      `SELECT type, COUNT(*)::text AS count FROM emails
       WHERE sent_at >= now() - interval '30 days' GROUP BY type`,
    )

    const daily = await query<{ day: string; sent: string; failed: string }>(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COUNT(e.id) FILTER (WHERE e.status <> 'failed')::text AS sent,
              COUNT(e.id) FILTER (WHERE e.status = 'failed')::text AS failed
       FROM generate_series((now() - interval '29 days')::date, now()::date, interval '1 day') AS d(day)
       LEFT JOIN emails e ON e.sent_at::date = d.day
       GROUP BY d.day ORDER BY d.day`,
    )

    const t = totals[0]
    const typeOrder: EmailType[] = ['update', 'announcement', 'promotion', 'notice']
    const typeMap = new Map(byType.map((r) => [r.type, Number(r.count)]))

    res.json({
      totalSent: Number(t?.total ?? 0),
      delivered: Number(t?.delivered ?? 0),
      failed: Number(t?.failed ?? 0),
      bounced: Number(t?.bounced ?? 0),
      byType: typeOrder.map((type) => ({ type, count: typeMap.get(type) ?? 0 })),
      daily: daily.map((r) => ({ date: r.day, sent: Number(r.sent), failed: Number(r.failed) })),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /emails/audience — admin-selectable recipients for bulk "select all".
 * Returns account emails ONLY (never workspace content). Supports the same
 * filters as the Users page so the admin can target verified users, etc.
 */
router.get('/audience', async (req, res, next) => {
  try {
    const q = z
      .object({
        verification: z.enum(['verified', 'unverified', 'all']).default('all'),
        status: z.enum(['active', 'all']).default('active'),
        limit: z.coerce.number().int().min(1).max(500).default(500),
      })
      .parse(req.query)

    const conditions: string[] = []
    const params: unknown[] = []
    if (q.verification !== 'all') {
      params.push(q.verification)
      conditions.push(`verification = $${params.length}`)
    }
    if (q.status !== 'all') {
      params.push(q.status)
      conditions.push(`status = $${params.length}`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = await query<{ email: string; name: string }>(
      `SELECT email, name FROM accounts ${where} ORDER BY created_at DESC LIMIT ${q.limit}`,
      params,
    )
    res.json({ count: rows.length, recipients: rows.map((r) => r.email) })
  } catch (err) {
    next(err)
  }
})

/** GET /emails/:id/body — content for "copy as new email" (never auto-sends).
 *  Returns the stored bodyType so the composer reopens in the same mode. */
router.get('/:id/body', async (req, res, next) => {
  try {
    const rows = await query<{
      subject: string
      body: string
      body_type: string | null
      to_addrs: string[]
      cc_addrs: string[]
      bcc_addrs: string[]
    }>(
      `SELECT subject, body, body_type, to_addrs, cc_addrs, bcc_addrs FROM emails WHERE id = $1 LIMIT 1`,
      [req.params.id],
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ error: 'Email not found' })
      return
    }
    res.json({
      subject: row.subject,
      message: row.body,
      bodyType: row.body_type === 'html' ? 'html' : 'text',
      to: row.to_addrs,
      cc: row.cc_addrs,
      bcc: row.bcc_addrs,
    })
  } catch (err) {
    next(err)
  }
})

/* ---------------------------------- Send ----------------------------------- */

router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = SendBody.safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      res.status(400).json({ error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid request' })
      return
    }
    const body = parsed.data

    // The From identity is enforced server-side; the frontend value is ignored.
    const from = senderIdentity()

    const { to, cc, bcc } = dedupeAcrossFields(body.to, body.cc, body.bcc)
    // Backend enforcement of the send rule, independent of the frontend:
    // send when To, CC or BCC is non-empty; reject only when ALL are empty.
    if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
      res.status(400).json({ error: 'at least one recipient is required (To, CC, or BCC)' })
      return
    }

    // Mode is explicit — never inferred from content. HTML is sanitized ONCE,
    // up front: the sanitized form is both SENT (wrapped into a document so
    // fragments need no boilerplate) and STORED — script-capable HTML never
    // reaches the provider, the database, history, or copy-as-new.
    // Plain-text mode: body → text field only, never the html field.
    const isHtml = body.bodyType === 'html'
    const storedBody = isHtml ? sanitizeEmailHtml(body.message) : body.message
    const result = await sendEmail({
      to,
      cc,
      bcc,
      subject: body.subject,
      ...(isHtml ? { html: wrapHtmlFragment(storedBody) } : { text: body.message }),
    })

    const rows = await query<{ id: string; sent_at: Date }>(
      `INSERT INTO emails (resend_id, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, body, body_type, type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, sent_at`,
      [
        result.resendId,
        from,
        to,
        cc,
        bcc,
        body.subject,
        storedBody,
        body.bodyType,
        body.type ?? ('update' satisfies EmailType),
        'sent' satisfies EmailStatus,
      ],
    )
    const inserted = rows[0]

    // Audit metadata stays compact and aggregate-only: recipient COUNTS, never
    // the recipient lists themselves (the full lists live in the emails table
    // for audit purposes; the audit table must never grow a row proportional
    // to recipient count). No message body is ever recorded.
    await recordAudit(adminActor(req.admin!), 'admin', 'email.sent', body.subject, {
      toCount: String(to.length),
      ccCount: String(cc.length),
      bccCount: String(bcc.length),
      bodyType: body.bodyType,
      type: body.type ?? 'update',
      dryRun: String(result.dryRun),
      resendId: result.resendId ?? '',
    })

    res.status(201).json({
      id: inserted.id,
      resendId: result.resendId ?? '',
      from,
      to,
      cc,
      bcc,
      subject: body.subject,
      bodyType: body.bodyType,
      type: body.type ?? 'update',
      status: 'sent',
      sentAt: inserted.sent_at.toISOString(),
    })
  } catch (err) {
    next(err)
  }
})

export default router
