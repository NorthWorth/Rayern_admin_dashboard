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
import { requireMonitoringToken } from '../auth/monitoringToken'
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
    });
  } catch (err) {
    next(err);
  }
});

/** Audience records synchronized by the dashboard-side audience sync (built
 * from the existing `rayern_audience` table). Read-back only — this route
 * never writes the audience; it is written by `POST /marketing/local-audience-sync`.
 */
router.get('/audience', async (_req, res, next) => {
  try {
    const rows = await query<
      {
        email: string
        first_name: string | null
        last_name: string | null
        status: string
        email_verified: boolean
        workspace_plan: string | null
        subscription_plan: string | null
        subscription_status: string | null
        has_paid_access: boolean
        consent_opted_in: boolean
        consented_at: Date | null
        consent_source: string | null
        synced_at: Date
      }
    >(
      `SELECT email, first_name, last_name, status, email_verified, workspace_plan, subscription_plan, subscription_status, has_paid_access, consent_opted_in, consented_at, consent_source, synced_at
       FROM rayern_audience
       ORDER BY synced_at DESC, email`,
    );
    res.json({
      items: rows.map((r) => ({
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        status: r.status,
        emailVerified: r.email_verified,
        workspacePlan: r.workspace_plan,
        subscriptionPlan: r.subscription_plan,
        subscriptionStatus: r.subscription_status,
        hasPaidAccess: r.has_paid_access,
        consentOptedIn: r.consent_opted_in,
        consentedAt: r.consented_at ? r.consented_at.toISOString() : null,
        consentSource: r.consent_source,
        syncedAt: r.synced_at.toISOString(),
      })),
      counts: {
        total: rows.length,
        eligible: rows.filter((r) => r.consent_opted_in && r.status === 'active' && r.email_verified).length,
        optedIn: rows.filter((r) => r.consent_opted_in).length,
        optedOut: rows.filter((r) => r.consent_opted_in === false).length,
        suspended: rows.filter((r) => r.status === 'suspended').length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Eligibility over the locally synchronized audience. Matches the campaign
 * composer's promotional eligibility contract:
 * `marketingConsent.optedIn === true` AND `status === 'active'` AND
 * `emailVerified === true`.
 */
router.get('/audience/eligibility', async (_req, res, next) => {
  try {
    const row = await query<{
      eligible: string
      optedIn: string
      active: string
      emailVerified: string
      total: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE consent_opted_in = TRUE AND status = 'active' AND email_verified = TRUE)::text AS eligible,
         COUNT(*) FILTER (WHERE consent_opted_in = TRUE)::text AS optedIn,
         COUNT(*) FILTER (WHERE status = 'active')::text AS active,
         COUNT(*) FILTER (WHERE email_verified = TRUE)::text AS emailVerified,
         COUNT(*)::text AS total
       FROM rayern_audience`,
    );
    const counts = row[0] ?? {
      eligible: '0',
      optedIn: '0',
      active: '0',
      emailVerified: '0',
      total: '0',
    };
    res.json({
      eligible: Number(counts.eligible),
      optedIn: Number(counts.optedIn),
      active: Number(counts.active),
      emailVerified: Number(counts.emailVerified),
      total: Number(counts.total),
    });
  } catch (err) {
    next(err);
  }
});

/** Local audience sync. Reuses the existing ingestion implementation and the
 * existing `RAYERN_MONITORING_TOKEN` contract (it mirrors the server-side
 * `/internal/dashboard/rayern-audience` route in `rayernPush.ts`), so Rayern's
 * audience synchronization stays on the same short-lived service token.
 */
router.post('/local-audience-sync', requireMonitoringToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await ingestRayernAudience(req.body);
    if (!result.ok) {
      res.status(result.status ?? 400).json({
        success: false,
        error: { code: 'AUDIENCE_REJECTED', message: result.error ?? 'Audience rejected' },
      });
      return;
    }
    res.status(200).json({
      success: true,
      syncId: result.syncId ?? null,
      received: result.received ?? 0,
      upserted: result.upserted ?? 0,
      removed: result.removed ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /marketing/consent
