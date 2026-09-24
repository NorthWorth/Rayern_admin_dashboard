/**
 * Emails routes — admin-initiated sending only.
 *
 * Flow: dashboard frontend → dashboard API → Resend → recipients.
 * The Resend API key never leaves the server. Verification/password-reset
 * emails are NOT handled here (they belong to Rayern's own flow).
 *
 * Recipients: To/CC/BCC are independent lists. Every address is validated +
 * normalized; duplicates within a field and across fields are removed
 * (address wins in the earliest field: To > CC > BCC) so nobody receives the
 * email twice. The frontend is never trusted for this — dedup happens again
 * here, server-side.
 *
 * Send rule (unchanged): sending is allowed when To, CC OR BCC contains at
 * least one recipient; rejected only when all three are empty.
 *
 * BCC-ONLY ARCHITECTURE (spec §1–§2): Resend's normal email API requires a
 * `to` recipient, so a genuinely BCC-only payload cannot simply omit `to`.
 * Instead of a workaround, the backend EXPANDS the operation server-side
 * (emailDelivery.ts): one individual message per hidden recipient, each
 * addressed only to that recipient, carried through Resend's Batch API in
 * chunks of ≤100 with deterministic idempotency keys. No fake To, no shared
 * To list — BCC recipients can never see one another.
 *
 * QUOTA (spec §10): enforced HERE before any provider submission — the whole
 * operation must fit the monthly AND daily remaining quota (limits from
 * config, see emailUsage.ts). Rejections return 402 with counts, never
 * recipient data. The frontend is never authoritative for quota.
 *
 * IDEMPOTENCY (spec §11): the client may send `idempotencyKey`; when absent
 * one is generated. A completed operation with the same key replays its
 * original result — a double-click or retried request can never send twice
 * or double-count usage.
 *
 * Body modes: `bodyType` ('text' | 'html') is explicit and is the single
 * source of truth for how the message is sent. HTML is sanitized ONCE up
 * front: the sanitized form is both SENT (wrapped so fragments need no
 * boilerplate) and STORED — script-capable HTML never reaches the provider,
 * the database, history, or copy-as-new. Recipient expansion never touches
 * the body: every expanded message preserves subject, body and mode exactly.
 */
import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { query } from '../db'
import { recordAudit, adminActor } from '../audit'
import { senderIdentity, sanitizeEmailHtml, wrapHtmlFragment } from '../emailer'
import {
  deliverEmail,
  expansionMessageCount,
  findCompletedGroup,
  reconcileUncertainMessages,
} from '../emailDelivery'
import { checkQuota, getUsage, setLastReconciledAt } from '../emailUsage'
import { toEmailMessage, type EmailRow, type EmailType } from '../format'
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
    /** Optional client-side idempotency key (UUID). Retries reuse it. */
    idempotencyKey: z.string().uuid().optional(),
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

/** Columns needed for the grouped history view. */
const HISTORY_COLUMNS = `id, resend_id, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, body_type, type, status,
         send_group_id, message_count, batch_count, group_meta, sent_at`

interface GroupedEmailRow extends EmailRow {
  send_group_id: string | null
  message_count: number
  batch_count: number
  group_meta: { to?: string[]; cc?: string[]; bccCount?: number; mode?: string } | null
}

/**
 * Collapses expanded (per-recipient) groups back into ONE logical history
 * row per admin action (spec §14): the original composition from group_meta,
 * aggregate counts (provider messages, batches), the representative status
 * (failed if any definitively failed, uncertain if any pending, else sent),
 * and the earliest sent_at. Normal sends map through unchanged.
 */
function toGroupedMessage(row: GroupedEmailRow): ReturnType<typeof toEmailMessage> & {
  delivery?: { mode: string; providerMessages: number; batches: number }
} {
  const base = toEmailMessage(row)
  if (!row.send_group_id || row.message_count <= 1) return base
  return {
    ...base,
    // The LOGICAL composition (spec §14): the group_meta copy + aggregate
    // counts. bcc list stays empty here on purpose — the audience is
    // represented by the count, not a raw list.
    to: row.group_meta?.to ?? row.to_addrs,
    cc: row.group_meta?.cc ?? row.cc_addrs,
    status: row.status === 'uncertain' ? ('queued' as const) : base.status,
    delivery: {
      mode: 'expanded',
      providerMessages: row.message_count,
      batches: row.batch_count,
    },
  }
}

/* ------------------------------- History list ------------------------------ */

router.get('/', async (_req, res, next) => {
  try {
    // One logical row per send group: MIN(id) picks a representative row;
    // group_meta carries the original composition for expanded operations.
    const rows = await query<GroupedEmailRow>(
      `SELECT DISTINCT ON (COALESCE(send_group_id, id::text))
              ${HISTORY_COLUMNS}
       FROM emails
       ORDER BY COALESCE(send_group_id, id::text), sent_at ASC`,
    )
    const out = rows
      .sort((a, b) => b.sent_at.getTime() - a.sent_at.getTime())
      .slice(0, 500)
      .map(toGroupedMessage)
    res.json(out)
  } catch (err) {
    next(err)
  }
})

router.get('/stats', async (_req, res, next) => {
  try {
    // Stats count INDIVIDUAL provider messages (usage semantics, spec §6).
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
              COUNT(e.id) FILTER (WHERE e.status NOT IN ('failed','uncertain'))::text AS sent,
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
 * GET /emails/usage — persisted monthly/daily usage + remaining quota
 * (spec §8, §9, §13). Numbers are SQL aggregates over individual message
 * rows (never batch requests, never client state).
 */
router.get('/usage', async (_req, res, next) => {
  try {
    const usage = await getUsage(null)
    res.json(usage)
  } catch (err) {
    next(err)
  }
})

/**
 * POST /emails/usage/reconcile — admin-triggered reconciliation of uncertain
 * submissions (spec §12). Re-submits ONLY messages whose outcome was
 * unknown, with their original idempotency keys, so already-accepted
 * messages are never re-sent. Failure keeps last-known usage.
 */
router.post('/usage/reconcile', async (_req, res, next) => {
  try {
    const result = await reconcileUncertainMessages()
    const at = new Date().toISOString()
    await setLastReconciledAt(at)
    const usage = await getUsage(at)
    res.json({ reconciled: result, usage })
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
 *  Returns the stored bodyType so the composer reopens in the same mode.
 *  For an expanded (BCC/CC-only) operation, the ORIGINAL logical
 *  composition is reconstructed from group_meta + the group's rows. */
router.get('/:id/body', async (req, res, next) => {
  try {
    const rows = await query<{
      subject: string
      body: string
      body_type: string | null
      to_addrs: string[]
      cc_addrs: string[]
      send_group_id: string | null
      group_meta: { to?: string[]; cc?: string[]; mode?: string } | null
    }>(
      `SELECT subject, body, body_type, to_addrs, cc_addrs, send_group_id, group_meta
       FROM emails WHERE id = $1 LIMIT 1`,
      [req.params.id],
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ error: 'Email not found' })
      return
    }
    let to = row.group_meta?.to ?? row.to_addrs
    let cc = row.group_meta?.cc ?? row.cc_addrs
    let bcc: string[] = []
    if (row.send_group_id && row.group_meta?.mode === 'expanded') {
      // Rebuild the hidden audience from the group's individual rows.
      const group = await query<{ to_addrs: string[] }>(
        `SELECT to_addrs FROM emails WHERE send_group_id = $1 ORDER BY sent_at ASC`,
        [row.send_group_id],
      )
      const logicalTo = new Set(row.group_meta.to ?? [])
      bcc = group
        .map((g) => g.to_addrs[0])
        .filter((a): a is string => Boolean(a) && !logicalTo.has(a))
      // CC-only expansion: the "recipients" ARE the cc list — restore them
      // as CC, not BCC.
      if ((row.group_meta.to ?? []).length === 0 && (row.group_meta.cc ?? []).length > 0) {
        cc = row.group_meta.cc ?? []
        bcc = []
      }
      to = row.group_meta.to ?? []
    }
    res.json({
      subject: row.subject,
      message: row.body,
      bodyType: row.body_type === 'html' ? 'html' : 'text',
      to,
      cc,
      bcc,
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

    // Idempotency (spec §11): a completed operation with the same key replays
    // its original result — a retried/double-submitted request never re-sends
    // and never double-counts usage.
    const sendGroupId = body.idempotencyKey ?? randomUUID()
    const existing = await findCompletedGroup(sendGroupId)
    if (existing) {
      const repRow = await query<GroupedEmailRow>(
        `SELECT ${HISTORY_COLUMNS} FROM emails WHERE send_group_id = $1 ORDER BY sent_at ASC LIMIT 1`,
        [sendGroupId],
      )
      const row = repRow[0]
      if (row) {
        res.status(200).json({
          ...toGroupedMessage(row),
          // The replay is keyed by the LOGICAL send id — echoed so a client
          // that retried after a lost response can match it to its original
          // submission even though history shows the representative row id.
          id: sendGroupId,
          idempotentReplay: true,
        })
        return
      }
    }

    // Quota pre-flight (spec §10): the number of INDIVIDUAL provider messages
    // this operation will consume (To+CC-only = 1; with BCC: 1 per hidden
    // recipient + 1 normal visible message; CC-only: one per CC recipient).
    const requestedMessages = expansionMessageCount({ to, cc, bcc, subject: body.subject })
    const quota = await checkQuota(requestedMessages)
    if (!quota.allowed) {
      res.status(402).json({
        error: quota.reason ?? 'Email quota exceeded',
        quota: {
          requested: quota.requested,
          month: quota.month,
          day: quota.day,
        },
      })
      return
    }

    // Mode is explicit — never inferred from content. HTML is sanitized ONCE,
    // up front: the sanitized form is both SENT (wrapped into a document so
    // fragments need no boilerplate) and STORED. Plain-text mode: body →
    // text field only, never the html field.
    const isHtml = body.bodyType === 'html'
    const storedBody = isHtml ? sanitizeEmailHtml(body.message) : body.message

    const result = await deliverEmail({
      email: {
        to,
        cc,
        bcc,
        subject: body.subject,
        ...(isHtml ? { html: wrapHtmlFragment(storedBody) } : { text: body.message }),
      },
      storedBody,
      bodyType: body.bodyType,
      type: body.type ?? ('update' satisfies EmailType),
      sendGroupId,
    })

    // Audit metadata stays compact and aggregate-only: recipient COUNTS and
    // batch info, never the recipient lists themselves. No message body is
    // ever recorded.
    await recordAudit(adminActor(req.admin!), 'admin', 'email.sent', body.subject, {
      toCount: String(to.length),
      ccCount: String(cc.length),
      bccCount: String(bcc.length),
      providerMessages: String(result.messageCount),
      batches: String(result.batchCount),
      delivery: result.messageCount > 1 || bcc.length > 0 ? 'expanded' : 'normal',
      bodyType: body.bodyType,
      type: body.type ?? 'update',
      sendGroupId: result.sendGroupId,
    })

    // Response describes the LOGICAL action; expanded operations carry
    // aggregate delivery info (never the per-recipient rows).
    res.status(201).json({
      id: result.sendGroupId,
      resendId: '',
      from,
      to,
      cc,
      bcc,
      subject: body.subject,
      bodyType: body.bodyType,
      type: body.type ?? 'update',
      status: result.allAccepted ? ('sent' as const) : ('queued' as const),
      sentAt: new Date().toISOString(),
      delivery: {
        mode: result.messageCount > 1 || bcc.length > 0 ? 'expanded' : 'normal',
        providerMessages: result.messageCount,
        batches: result.batchCount,
        accepted: result.accepted,
        uncertain: result.uncertain,
        failed: result.failed,
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
