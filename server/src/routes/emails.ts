/**
 * Emails routes — admin-initiated sending only.
 *
 * Flow: dashboard frontend → dashboard API → Resend → recipients.
 * The Resend API key never leaves the server. Verification/password-reset
 * emails are NOT handled here (they belong to Rayern's own flow).
 */
import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { recordAudit, adminActor } from '../audit'
import { sendEmail } from '../emailer'
import { toEmailMessage, type EmailRow, type EmailStatus, type EmailType } from '../format'
import type { Request, Response, NextFunction } from 'express'

const router = Router()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Validates and normalizes a recipient list (1..50 unique addresses). */
function recipientsSchema({ min = 0 }: { min?: number } = {}) {
  return z
    .array(z.string().trim().max(254))
    .min(min)
    .max(50)
    .transform((arr) => Array.from(new Set(arr)))
    .refine((arr) => arr.every((a) => EMAIL_RE.test(a)), { message: 'Invalid email address in list' })
}

const SendBody = z.object({
  from: z.string().max(320).optional(),
  to: recipientsSchema({ min: 1 }),
  cc: recipientsSchema().default([]),
  bcc: recipientsSchema().default([]),
  subject: z.string().trim().min(1).max(300),
  message: z.string().min(1).max(100_000),
})

/** Escapes HTML in plain-text messages so the HTML part mirrors the text. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textToHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px 0">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('')
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f8f9;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dee1e6;border-radius:8px;padding:28px;
font-family:Inter,Segoe UI,system-ui,sans-serif;font-size:14px;line-height:1.6;color:#1b1f25;">
${paragraphs}
<p style="margin:20px 0 0 0;padding-top:14px;border-top:1px solid #eef0f2;font-size:12px;color:#717a89;">
Sent via the Rayern admin dashboard.</p>
</div></body></html>`
}

router.get('/', async (_req, res, next) => {
  try {
    const rows = await query<EmailRow>(
      `SELECT id, resend_id, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, type, status, sent_at
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

router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = SendBody.safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      res.status(400).json({ error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid request' })
      return
    }
    const body = parsed.data

    if (!body.from || body.from.trim() === '') {
      res.status(400).json({ error: 'from: sender identity is required' })
      return
    }

    const result = await sendEmail({
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      html: textToHtml(body.message),
      text: body.message,
    })

    const rows = await query<{ id: string; sent_at: Date }>(
      `INSERT INTO emails (resend_id, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, sent_at`,
      [
        result.resendId,
        'Rayern <support@rayern.com.ng>',
        body.to,
        body.cc,
        body.bcc,
        body.subject,
        'update' satisfies EmailType,
        'sent' satisfies EmailStatus,
      ],
    )
    const inserted = rows[0]

    await recordAudit(adminActor(req.admin!), 'admin', 'email.sent', body.subject, {
      to: body.to.join(', '),
      cc: body.cc.join(', '),
      bcc: body.bcc.join(', '),
      resendId: result.resendId ?? '',
    })

    res.status(201).json({
      id: inserted.id,
      resendId: result.resendId ?? '',
      from: 'Rayern <support@rayern.com.ng>',
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      type: 'update',
      status: 'sent',
      sentAt: inserted.sent_at.toISOString(),
    })
  } catch (err) {
    next(err)
  }
})

export default router
