/**
 * Resend email usage accounting — persisted, idempotent, quota-enforcing.
 *
 * WHAT COUNTS AS ONE EMAIL (spec §6): an individual recipient message that
 * the provider accepted — NOT an API request, NOT a batch, NOT a click, NOT
 * a validation failure. A normal email to 3 recipients = 3 emails; a
 * BCC-only operation to 250 recipients = 250 individual messages = 250
 * emails even though Resend carried them in 3 batch API requests.
 *
 * WHERE IT LIVES (spec §7): the authoritative counter is the `emails` table
 * itself — one row per individual provider message, status `accepted`.
 * Month/day usage are SQL aggregates over that table, so they survive
 * restarts, refreshes and deployments for free, can never drift from the
 * visible history, and are idempotent by construction (a retried submission
 * that was already persisted cannot be counted twice — the unique
 * provider_message_id index plus idempotent resend IDs guarantee one row per
 * real provider message).
 *
 * QUOTA (spec §10): enforcement happens HERE, before any provider call. An
 * operation that cannot fully fit into both remaining quotas is rejected in
 * its entirety — never partially sent. Limits come from config
 * (RESEND_MONTHLY_EMAIL_LIMIT / RESEND_DAILY_EMAIL_LIMIT), never hardcoded.
 *
 * Frontend usage display reads GET /emails/usage (this module) — the browser
 * is never authoritative for quota decisions.
 */
import { query } from './db'
import { config } from './config'

export interface UsageWindow {
  used: number
  limit: number
  remaining: number
  /** `used / limit * 100`, rounded to 1 decimal — null when limit is 0. */
  usedPct: number | null
}

export interface EmailUsage {
  month: UsageWindow
  day: UsageWindow
  /** When these numbers were computed (always "now" — they are live SQL aggregates). */
  computedAt: string
  /** `null` until a reconciliation pass has ever run; see emailDelivery.reconcileUncertainBatches. */
  lastReconciledAt: string | null
  limits: { monthly: number; daily: number }
}

/** Which individual message statuses consume quota (spec §6: accepted only). */
const COUNTED_STATUSES = `('accepted', 'sent', 'delivered')`

async function countSince(interval: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM emails
     WHERE status IN ${COUNTED_STATUSES} AND sent_at >= date_trunc('${interval}', now())`,
  )
  return Number(rows[0]?.n ?? 0)
}

/** Individual provider messages accepted in the current calendar month. */
export async function monthlyUsage(): Promise<number> {
  return countSince('month')
}

/** Individual provider messages accepted since local midnight. */
export async function dailyUsage(): Promise<number> {
  return countSince('day')
}

function window(used: number, limit: number): UsageWindow {
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    usedPct: limit > 0 ? Number(((used / limit) * 100).toFixed(1)) : null,
  }
}

/** Full usage snapshot for the /emails/usage endpoint and the UI. */
export async function getUsage(lastReconciledAt: string | null): Promise<EmailUsage> {
  const [month, day] = await Promise.all([monthlyUsage(), dailyUsage()])
  const monthly = config.resend.monthlyEmailLimit
  const daily = config.resend.dailyEmailLimit
  return {
    month: window(month, monthly),
    day: window(day, daily),
    computedAt: new Date().toISOString(),
    lastReconciledAt,
    limits: { monthly, daily },
  }
}

export interface QuotaDecision {
  allowed: boolean
  /** Individual emails the operation will consume (recipient count after dedup). */
  requested: number
  month: { used: number; limit: number; remaining: number }
  day: { used: number; limit: number; remaining: number }
  /** Human-readable reason when rejected (no recipient data — counts only). */
  reason?: string
}

/**
 * Pre-flight quota check (spec §10): the WHOLE operation must fit inside BOTH
 * the monthly and the daily remaining quota, or it is rejected before any
 * provider submission. No partial sends, no silent discards.
 */
export async function checkQuota(requestedMessages: number): Promise<QuotaDecision> {
  const [monthUsed, dayUsed] = await Promise.all([monthlyUsage(), dailyUsage()])
  const monthlyLimit = config.resend.monthlyEmailLimit
  const dailyLimit = config.resend.dailyEmailLimit
  const decision: QuotaDecision = {
    allowed: true,
    requested: requestedMessages,
    month: { used: monthUsed, limit: monthlyLimit, remaining: Math.max(0, monthlyLimit - monthUsed) },
    day: { used: dayUsed, limit: dailyLimit, remaining: Math.max(0, dailyLimit - dayUsed) },
  }
  if (monthUsed + requestedMessages > monthlyLimit) {
    decision.allowed = false
    decision.reason =
      `Monthly email quota exceeded: ${monthUsed}/${monthlyLimit} used, ${Math.max(0, monthlyLimit - monthUsed)} remaining, ` +
      `${requestedMessages} requested. Reduce the recipient count or wait for the monthly reset.`
  } else if (dayUsed + requestedMessages > dailyLimit) {
    decision.allowed = false
    decision.reason =
      `Daily email quota exceeded: ${dayUsed}/${dailyLimit} used today, ${Math.max(0, dailyLimit - dayUsed)} remaining, ` +
      `${requestedMessages} requested. Reduce the recipient count or wait for the daily reset.`
  }
  return decision
}

/* --------------------------- Reconciliation state -------------------------- */

interface UsageMetaRow {
  key: string
  value: string
}

let cachedReconciledAt: string | null = null

/** Last successful reconciliation timestamp (persisted in audit-free kv rows). */
export async function getLastReconciledAt(): Promise<string | null> {
  if (cachedReconciledAt !== null) return cachedReconciledAt
  try {
    const rows = await query<UsageMetaRow>(
      `SELECT key, value FROM rayern_sync_state WHERE key = 'email_usage_reconciled_at'`,
    )
    cachedReconciledAt = rows[0]?.value ?? null
  } catch {
    cachedReconciledAt = null
  }
  return cachedReconciledAt
}

export async function setLastReconciledAt(at: string): Promise<void> {
  cachedReconciledAt = at
  await query(
    `INSERT INTO rayern_sync_state (key, payload, updated_at) VALUES ('email_usage_reconciled_at', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [JSON.stringify(at)],
  )
}

export function resetReconcileCacheForTests(): void {
  cachedReconciledAt = null
}
