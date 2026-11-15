import { z } from 'zod'
import { query } from './db'
import { markPushSyncSuccess } from './rayernSync'

export interface AudienceIngestionResult {
  ok: boolean
  syncId?: string
  received?: number
  upserted?: number
  removed?: number
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

const AudiencePayloadSchema = z.object({
  syncId: z.string().min(1).max(128).optional(),
  generatedAt: z.string().datetime().optional(),
  audience: z.array(AudienceRecordSchema).max(100000),
})

export async function ingestRayernAudience(raw: unknown): Promise<AudienceIngestionResult> {
  let data: z.infer<typeof AudiencePayloadSchema>
  try {
    const parsed = AudiencePayloadSchema.safeParse(raw)
    if (!parsed.success) {
      const paths = parsed.error.issues.slice(0, 12).map((i) => i.path.join('.') || 'root')
      return {
        ok: false,
        status: 400,
        error: `Audience payload failed validation (${parsed.error.issues.length} issue(s); paths: ${paths.join(',') || 'root'})`,
      }
    }
    data = parsed.data
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : 'invalid payload' }
  }

  const syncId = data.syncId ?? null
  const received = data.audience.length

  try {
    for (const r of data.audience) {
      await query(
        `INSERT INTO rayern_audience (email, first_name, last_name, status, email_verified, workspace_plan, subscription_plan, subscription_status, has_paid_access, consent_opted_in, consented_at, consent_updated_at, consent_source, user_updated_at, synced_at)
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
           synced_at = now()`,
        [
          r.email.toLowerCase(),
          r.firstName ?? null,
          r.lastName ?? null,
          r.status,
          r.emailVerified,
          r.workspacePlan ?? null,
          r.subscription?.plan ?? null,
          r.subscription?.status ?? null,
          r.subscription?.hasPaidAccess ?? false,
          r.marketingConsent.optedIn,
          r.marketingConsent.consentedAt ? new Date(r.marketingConsent.consentedAt) : null,
          r.marketingConsent.updatedAt ? new Date(r.marketingConsent.updatedAt) : null,
          r.marketingConsent.source ?? null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ],
      )
    }

    let removed = 0
    if (received > 0) {
      const emails = data.audience.map((r) => r.email.toLowerCase())
      const placeholders = emails.map((_, i) => `$${i + 1}`).join(',')
      const res = await query<{ email: string }>(
        `DELETE FROM rayern_audience WHERE email NOT IN (${placeholders}) RETURNING email`,
        emails,
      )
      removed = res.length
    } else {
      const res = await query<{ email: string }>(`DELETE FROM rayern_audience RETURNING email`)
      removed = res.length
    }

    // A successfully applied audience snapshot is a successful push transport: it
    // advances the same canonical "last successful sync" metadata as a pull.
    try {
      await markPushSyncSuccess()
    } catch {
      // status bookkeeping is best-effort; the audience write already succeeded
    }

    return { ok: true, syncId: syncId ?? undefined, received, upserted: received, removed }
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
    out = out.filter((r) => r.consentOptedIn && r.status === 'active' && r.emailVerified)
  }
  return out
}
