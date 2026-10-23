/**
 * Marketing routes — consent-gated campaign operations for the dashboard.
 *
 * All routes are mounted at /marketing (root-level, NO /api/v1 prefix — the
 * same convention as /users, /emails, /platform-metrics, …) and require an
 * authenticated dashboard admin.
 *
 * Privacy / consent model:
 *  - Consent is administrative marketing metadata on the account record
 *    (opted_in / opted_out / unknown). No workspace linkage, no customer
 *    content — exactly the same data boundary as the Users page.
 *  - ABSENCE OF A CONSENT ROW MEANS 'unknown' and is NEVER mailable.
 *    Campaigns only ever reach accounts with an explicit opted_in record
 *    (opt-in only — never assume consent).
 *  - Campaign sends reuse the existing BCC-only expansion pipeline
 *    (emailDelivery.ts): every audience member receives an individual
 *    message, recipients can never see one another, quota is enforced
 *    server-side before any provider call, and deterministic idempotency
 *    keys make a retried send replay instead of double-sending.
 *  - Audit metadata and responses carry COUNTS only — never recipient lists
 *    or message bodies.
 */
import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { query } from '../db'
import { recordAudit, adminActor } from '../audit'
import { sanitizeEmailHtml, wrapHtmlFragment, senderIdentity } from '../emailer'
import { deliverEmail, expansionMessageCount, findCompletedGroup } from '../emailDelivery'
import { checkQuota } from '../emailUsage'
import type { Request, Response, NextFunction } from 'express'

const router = Router()

export type ConsentStatus = 'opted_in' | 'opted_out' | 'unknown'

/** Escapes LIKE metacharacters for safe ILIKE usage (same as users route). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/* ------------------------------ Consent core ------------------------------ */

interface ConsentCounts {
  optedIn: number
  optedOut: number
  unknown: number
}

/**
 * Consent counts over non-closed accounts (closed accounts are deletions and
 * never part of a marketing audience). `unknown` = accounts with NO consent
 * row — counted from the accounts table itself so nothing is silently lost.
 */
async function consentCounts(): Promise<ConsentCounts> {
  const rows = await query<{ status: string | null; count: string }>(
    `SELECT mc.status, COUNT(*)::text AS count
     FROM accounts a
     LEFT JOIN marketing_consent mc ON mc.account_id = a.id
     WHERE a.status <> 'closed'
     GROUP BY mc.status`,
  )
  const counts: ConsentCounts = { optedIn: 0, optedOut: 0, unknown: 0 }
  for (const row of rows) {
    const n = Number(row.count)
    if (row.status === 'opted_in') counts.optedIn = n
    else if (row.status === 'opted_out') counts.optedOut = n
    else counts.unknown = n
  }
  return counts
}

/** Active accounts with an explicit opted_in record — the only mailable set. */
async function mailableEmails(): Promise<string[]> {
  const rows = await query<{ email: string }>(
    `SELECT a.email
     FROM accounts a
     JOIN marketing_consent mc ON mc.account_id = a.id
     WHERE mc.status = 'opted_in' AND a.status = 'active'
     ORDER BY a.created_at DESC`,
  )
  return rows.map((r) => r.email)
}

/** Mailable + excluded counts for preview/UI display. */
async function audienceSummary(): Promise<{ mailable: number; optedOut: number; unknown: number }> {
  const [counts, mailable] = await Promise.all([consentCounts(), mailableEmails()])
  // opted_in counts include suspended/closed accounts; the mailable set is
  // active-only, so report the actual sendable count separately.
  return { mailable: mailable.length, optedOut: counts.optedOut, unknown: counts.unknown }
}

/* ------------------------------- Endpoints -------------------------------- */

/** GET /marketing/metrics — consent + campaign KPIs (aggregate only). */
router.get('/metrics', async (_req, res, next) => {
  try {
    const [counts, mailable, campaignTotals, recent] = await Promise.all([
      consentCounts(),
      mailableEmails(),
      query<{ total: string; sent30d: string; recipients30d: string; last_sent_at: Date | null }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE sent_at >= now() - interval '30 days')::text AS sent30d,
           COALESCE(SUM(audience_count) FILTER (WHERE sent_at >= now() - interval '30 days'), 0)::text AS recipients30d,
           MAX(sent_at) AS last_sent_at
         FROM marketing_campaigns`,
      ),
      query<{
        id: string
        subject: string
        type: string
        body_type: string
        audience_count: number
        provider_messages: number
        status: string
        sent_by: string
        sent_at: Date
      }>(
        `SELECT id, subject, type, body_type, audience_count, provider_messages, status, sent_by, sent_at
         FROM marketing_campaigns ORDER BY sent_at DESC LIMIT 10`,
      ),
    ])

    const t = campaignTotals[0]
    res.json({
      consent: counts,
      mailable: mailable.length,
      campaigns: {
        total: Number(t?.total ?? 0),
        sent30d: Number(t?.sent30d ?? 0),
        recipients30d: Number(t?.recipients30d ?? 0),
        lastSentAt: t?.last_sent_at ? t.last_sent_at.toISOString() : null,
      },
      recentCampaigns: recent.map((c) => ({
        id: c.id,
        subject: c.subject,
        type: c.type,
        bodyType: c.body_type === 'html' ? 'html' : 'text',
        audienceCount: c.audience_count,
        providerMessages: c.provider_messages,
        status: c.status,
        sentBy: c.sent_by,
        sentAt: c.sent_at.toISOString(),
      })),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /marketing/directory — account directory with consent status.
 * Same administrative data boundary as /users (identifier, name, email,
 * verification, account status, registration date) plus the consent flag.
 */
router.get('/directory', async (req, res, next) => {
  try {
    const q = z
      .object({
        search: z.string().max(200).optional(),
        consent: z.enum(['opted_in', 'opted_out', 'unknown', 'all']).default('all'),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(req.query)

    const conditions: string[] = []
    const params: unknown[] = []

    if (q.search) {
      params.push(`%${escapeLike(q.search)}%`)
      conditions.push(`(a.name ILIKE $${params.length} ESCAPE '\\' OR a.email ILIKE $${params.length} ESCAPE '\\')`)
    }
    if (q.consent === 'unknown') {
      conditions.push('mc.status IS NULL')
    } else if (q.consent !== 'all') {
      params.push(q.consent)
      conditions.push(`mc.status = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const pageSize = q.pageSize ?? 25
    const page = q.page ?? 1
    const offset = (page - 1) * pageSize

    const from = `FROM accounts a LEFT JOIN marketing_consent mc ON mc.account_id = a.id ${where}`

    const totalRows = await query<{ count: string }>(`SELECT COUNT(*)::text AS count ${from}`, params)
    const rows = await query<{
      id: string
      name: string
      email: string
      verification: string
      status: string
      created_at: Date
      consent: string | null
      consent_updated_at: Date | null
    }>(
      `SELECT a.id, a.name, a.email, a.verification, a.status, a.created_at,
              mc.status AS consent, mc.updated_at AS consent_updated_at
       ${from}
       ORDER BY a.created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    )

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        verification: r.verification,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        consent: (r.consent ?? 'unknown') as ConsentStatus,
        consentUpdatedAt: r.consent_updated_at ? r.consent_updated_at.toISOString() : null,
      })),
      total: Number(totalRows[0]?.count ?? 0),
      page,
      pageSize,
    })
  } catch (err) {
    next(err)
  }
})

/** GET /marketing/consent — consent summary (counts only, no recipient data). */
router.get('/consent', async (_req, res, next) => {
  try {
    const [counts, mailable] = await Promise.all([consentCounts(), mailableEmails()])
    res.json({
      ...counts,
      mailable: mailable.length,
      total: counts.optedIn + counts.optedOut + counts.unknown,
    })
  } catch (err) {
    next(err)
  }
})

const ConsentPatch = z.object({
  status: z.enum(['opted_in', 'opted_out', 'unknown']),
})

/**
 * PATCH /marketing/consent/:accountId — record an explicit consent decision.
 * 'unknown' clears the record (back to no-consent); opted_in / opted_out
 * upsert it. Every change is audited with counts/ids only.
 */
router.patch('/consent/:accountId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = z.string().uuid().parse(req.params.accountId)
    const parsed = ConsentPatch.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'status must be opted_in, opted_out, or unknown' })
      return
    }
    const status = parsed.data.status

    const existing = await query<{ id: string }>(`SELECT id FROM accounts WHERE id = $1 LIMIT 1`, [accountId])
    if (existing.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }

    let updatedAt: string
    if (status === 'unknown') {
      await query(`DELETE FROM marketing_consent WHERE account_id = $1`, [accountId])
      updatedAt = new Date().toISOString()
    } else {
      const rows = await query<{ updated_at: Date }>(
        `INSERT INTO marketing_consent (account_id, status, source, updated_by, updated_at)
         VALUES ($1, $2, 'admin', $3, now())
         ON CONFLICT (account_id)
         DO UPDATE SET status = EXCLUDED.status, source = 'admin', updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING updated_at`,
        [accountId, status, req.admin!.email],
      )
      updatedAt = (rows[0]?.updated_at ?? new Date()).toISOString()
    }

    await recordAudit(adminActor(req.admin!), 'admin', 'marketing.consent.updated', accountId, { status })

    res.json({ id: accountId, consent: status as ConsentStatus, consentUpdatedAt: updatedAt })
  } catch (err) {
    next(err)
  }
})

/* ------------------------------- Campaigns -------------------------------- */

const CampaignBody = z.object({
  subject: z.string().trim().min(1).max(300),
  message: z.string().min(1).max(100_000),
  bodyType: z.enum(['text', 'html']).default('text'),
  type: z.enum(['update', 'announcement', 'promotion', 'notice']).default('promotion'),
})

/**
 * POST /marketing/campaigns/preview — what this campaign WOULD send, without
 * sending: the server-sanitized body (identical to what recipients would
 * receive) plus the live consent-gated audience counts.
 */
router.post('/campaigns/preview', async (req, res, next) => {
  try {
    const parsed = CampaignBody.safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      res.status(400).json({ error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid request' })
      return
    }
    const body = parsed.data
    const isHtml = body.bodyType === 'html'
    const storedBody = isHtml ? sanitizeEmailHtml(body.message) : body.message

    const audience = await audienceSummary()
    res.json({
      subject: body.subject,
      bodyType: body.bodyType,
      type: body.type,
      from: senderIdentity(),
      /** Sanitized (HTML) or verbatim (text) body — exactly what is sent. */
      body: storedBody,
      /** Full document for sandboxed iframe preview (html mode only). */
      wrappedHtml: isHtml ? wrapHtmlFragment(storedBody) : null,
      audience,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /marketing/campaigns/send — send a campaign to every active account
 * with an explicit opted_in consent record. The audience is resolved
 * SERVER-SIDE from the database — the client can never choose recipients and
 * can never widen the audience. Each recipient receives an individual message
 * through the existing BCC-only expansion pipeline (quota + idempotency
 * enforced there before any provider call).
 */
router.post('/campaigns/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CampaignBody.extend({ idempotencyKey: z.string().uuid().optional() }).safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      res.status(400).json({ error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid request' })
      return
    }
    const body = parsed.data

    const sendGroupId = body.idempotencyKey ?? randomUUID()

    // Idempotent replay: the same logical campaign (same key) never sends
    // twice and never double-counts usage.
    const existing = await findCompletedGroup(sendGroupId)
    if (existing) {
      const camp = await query<{
        id: string
        subject: string
        body_type: string
        type: string
        audience_count: number
        provider_messages: number
        batch_count: number
        status: string
        sent_by: string
        sent_at: Date
      }>(`SELECT * FROM marketing_campaigns WHERE id = $1 LIMIT 1`, [sendGroupId])
      const c = camp[0]
      res.status(200).json({
        id: sendGroupId,
        subject: c?.subject ?? body.subject,
        bodyType: (c?.body_type ?? body.bodyType) === 'html' ? 'html' : 'text',
        type: c?.type ?? body.type,
        from: senderIdentity(),
        audienceCount: c?.audience_count ?? existing.accepted,
        status: (c?.status ?? (existing.allAccepted ? 'sent' : 'queued')) as 'sent' | 'queued',
        sentAt: (c?.sent_at ?? new Date()).toISOString(),
        idempotentReplay: true,
        delivery: {
          mode: 'expanded',
          providerMessages: existing.messageCount,
          batches: existing.batchCount,
          accepted: existing.accepted,
          uncertain: existing.uncertain,
          failed: existing.failed,
        },
      })
      return
    }

    const audience = await mailableEmails()
    if (audience.length === 0) {
      res.status(400).json({
        error: 'No consented recipients: campaigns can only reach accounts with an explicit marketing opt-in.',
      })
      return
    }

    // Quota pre-flight (same server-side gate as /emails/send): the whole
    // operation must fit the remaining monthly AND daily quota.
    const requestedMessages = expansionMessageCount({ to: [], cc: [], bcc: audience, subject: body.subject })
    const quota = await checkQuota(requestedMessages)
    if (!quota.allowed) {
      res.status(402).json({
        error: quota.reason ?? 'Email quota exceeded',
        quota: { requested: quota.requested, month: quota.month, day: quota.day },
      })
      return
    }

    const isHtml = body.bodyType === 'html'
    const storedBody = isHtml ? sanitizeEmailHtml(body.message) : body.message

    // BCC-only expansion: to=[] cc=[] bcc=audience → one individual message
    // per recipient, no shared To list. Recipients can never see one another.
    const result = await deliverEmail({
      email: {
        to: [],
        cc: [],
        bcc: audience,
        subject: body.subject,
        ...(isHtml ? { html: wrapHtmlFragment(storedBody) } : { text: body.message }),
      },
      storedBody,
      bodyType: body.bodyType,
      type: body.type,
      sendGroupId,
    })

    const status = result.allAccepted ? ('sent' as const) : ('queued' as const)
    await query(
      `INSERT INTO marketing_campaigns
         (id, subject, body_type, type, audience_count, provider_messages, batch_count, status, sent_by, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO NOTHING`,
      [
        sendGroupId,
        body.subject,
        body.bodyType,
        body.type,
        audience.length,
        result.messageCount,
        result.batchCount,
        status,
        req.admin!.email,
      ],
    )

    // Audit: counts and ids only — never the audience list, never the body.
    await recordAudit(adminActor(req.admin!), 'admin', 'marketing.campaign.sent', body.subject, {
      audience: String(audience.length),
      providerMessages: String(result.messageCount),
      batches: String(result.batchCount),
      accepted: String(result.accepted),
      uncertain: String(result.uncertain),
      failed: String(result.failed),
      bodyType: body.bodyType,
      type: body.type,
      sendGroupId: result.sendGroupId,
    })

    res.status(201).json({
      id: result.sendGroupId,
      subject: body.subject,
      bodyType: body.bodyType,
      type: body.type,
      from: senderIdentity(),
      audienceCount: audience.length,
      status,
      sentAt: new Date().toISOString(),
      delivery: {
        mode: 'expanded',
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
