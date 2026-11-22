import { z } from 'zod'
import { query, withTransaction } from './db'
import { markPushSyncSuccess } from './rayernSync'

export interface AudienceIngestionResult {
  ok: boolean
  syncId?: string
  received?: number
  upserted?: number
  removed?: number
  /** True when the payload declared itself complete and absent rows were pruned. */
  pruned?: boolean
  error?: string
  status?: number
}

const ConsentSchema = z.object({
  optedIn: z.boolean().default(false),
  consentedAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
  source: z.string().nullable().optional(),
})

const AudienceRecordSchema = z.object({
  email: z.string().email().max(254),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
  status: z.enum(['active', 'suspended', 'closed']).default('active'),
  emailVerified: z.boolean().default(false),
  workspacePlan: z.string().max(50).nullable().optional(),
  subscription: z
    .object({
      plan: z.string().max(50).optional(),
      status: z.string().max(50).optional(),
      hasPaidAccess: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  marketingConsent: ConsentSchema,
  updatedAt: z.string().datetime().nullable().optional(),
})

/**
 * Audience snapshot pushed by Rayern.
 *
 * `complete` is the producer's explicit statement that the array is the WHOLE
 * consent table. Only then may rows absent from it be pruned. A page, a delta or
 * a truncated payload leaves it unset, and pruning is skipped: an incomplete
 * payload can therefore never delete a mailable recipient.
 */
const AudiencePayloadSchema = z.object({
  syncId: z.string().min(1).max(128).optional(),
  generatedAt: z.string().datetime().optional(),
  complete: z.boolean().optional(),
  audience: z.array(AudienceRecordSchema).max(100000),
})

type AudiencePayload = z.infer<typeof AudiencePayloadSchema>
type AudienceRecord = z.infer<typeof AudienceRecordSchema>

export type AudiencePayloadParse =
  | { ok: true; data: AudiencePayload }
  | { ok: false; status: number; error: string }

/**
 * Structural + safety validation for an incoming audience snapshot.
 *
 * Exported so the guard rails can be tested without a database.
 */
export function parseAudiencePayload(raw: unknown): AudiencePayloadParse {
  const parsed = AudiencePayloadSchema.safeParse(raw)
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 12).map((i) => i.path.join('.') || 'root')
    return {
      ok: false,
      status: 400,
      error: `Audience payload failed validation (${parsed.error.issues.length} issue(s); paths: ${paths.join(',') || 'root'})`,
    }
  }

  // An empty snapshot is never applied. Rayern "having no eligible recipients"
  // and "the producer sent us nothing" are indistinguishable in an empty array,
  // and interpreting the second as the first would silently wipe the entire
  // mailable audience. Clearing it must be an explicit, separate operation.
  if (parsed.data.audience.length === 0) {
    return {
      ok: false,
      status: 400,
      error:
        'Empty audience snapshot rejected: an empty payload does not prove that no recipients exist, so the stored audience was left untouched. Send complete:true with at least one record to prune.',
    }
  }

  return { ok: true, data: parsed.data }
}

/** One row per email; a duplicate inside a payload resolves to its last record. */
function dedupeByEmail(records: AudienceRecord[]): Map<string, AudienceRecord> {
  const byEmail = new Map<string, AudienceRecord>()
  for (const record of records) {
    byEmail.set(record.email.toLowerCase(), record)
  }
  return byEmail
}

const UPSERT_SQL = `INSERT INTO rayern_audience (email, first_name, last_name, status, email_verified, workspace_plan, subscription_plan, subscription_status, has_paid_access, consent_opted_in, consented_at, consent_updated_at, consent_source, user_updated_at, synced_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
   ON CONFLICT (email) DO UPDATE SET
     first_name = EXCLUDED.first_name,
     last_name = EXCLUDED.last_name,
     status = EXCLUDED.status,
     email_verified = EXCLUDED.email_verified,
     workspace_plan = EXCLUDED.workspace_plan,
     subscription_plan = EXCLUDED.subscription_plan,
     subscription_status = EXCLUDED.subscription_status,
     has_paid_access = EXCLUDED.has_paid_access,
     consent_opted_in = EXCLUDED.consent_opted_in,
     consented_at = EXCLUDED.consented_at,
     consent_updated_at = EXCLUDED.consent_updated_at,
     consent_source = EXCLUDED.consent_source,
     user_updated_at = EXCLUDED.user_updated_at,
     synced_at = now()`

export async function ingestRayernAudience(raw: unknown): Promise<AudienceIngestionResult> {
  const parsed = parseAudiencePayload(raw)
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, error: parsed.error }
  }

  const data = parsed.data
  const syncId = data.syncId ?? null
  const received = data.audience.length
  const records = dedupeByEmail(data.audience)
  const emails = [...records.keys()]
  const prune = data.complete === true

  try {
    // Upserts and (when explicitly allowed) pruning commit together: a failure
    // halfway through can never leave a half-applied audience snapshot.
    const removed = await withTransaction(async (tx) => {
      for (const [email, record] of records) {
        await tx.query(UPSERT_SQL, [
          email,
          record.firstName ?? null,
          record.lastName ?? null,
          record.status,
          record.emailVerified,
          record.workspacePlan ?? null,
          record.subscription?.plan ?? null,
          record.subscription?.status ?? null,
          record.subscription?.hasPaidAccess ?? false,
          record.marketingConsent.optedIn,
          record.marketingConsent.consentedAt ? new Date(record.marketingConsent.consentedAt) : null,
          record.marketingConsent.updatedAt ? new Date(record.marketingConsent.updatedAt) : null,
          record.marketingConsent.source ?? null,
          record.updatedAt ? new Date(record.updatedAt) : null,
        ])
      }

      if (!prune) return 0

      const placeholders = emails.map((_, index) => `$${index + 1}`).join(',')
      const pruned = await tx.query<{ email: string }>(
        `DELETE FROM rayern_audience WHERE email NOT IN (${placeholders}) RETURNING email`,
        emails,
      )
      return pruned.length
    })

    // A successfully applied audience snapshot is a successful push transport: it
    // advances the same canonical "last successful sync" metadata as a pull.
    try {
      await markPushSyncSuccess()
    } catch {
      // status bookkeeping is best-effort; the audience write already succeeded
    }

    return { ok: true, syncId: syncId ?? undefined, received, upserted: records.size, removed, pruned: prune }
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : 'storage error', syncId: syncId ?? undefined }
  }
}

export async function listAudience(filters?: { eligibleOnly?: boolean }): Promise<
  { email: string; firstName: string | null; lastName: string | null; status: string; emailVerified: boolean; workspacePlan: string | null; subscriptionPlan: string | null; subscriptionStatus: string | null; hasPaidAccess: boolean; consentOptedIn: boolean; consentedAt: string | null; consentSource: string | null }[]
> {
  const rows = await query<{
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
  }>(`SELECT email, first_name, last_name, status, email_verified, workspace_plan, subscription_plan, subscription_status, has_paid_access, consent_opted_in, consented_at, consent_source FROM rayern_audience ORDER BY email`)
  let out = rows.map((r) => ({
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
  }))
  if (filters?.eligibleOnly) {
    // Eligibility is authoritative upstream and re-checked here: opted in,
    // active account, verified email. Never derived from plan or activity.
    out = out.filter((r) => r.consentOptedIn && r.status === 'active' && r.emailVerified)
  }
  return out
}
