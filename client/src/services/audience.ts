import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { AdminUserRecord } from '../lib/types'

/**
 * One row of the locally persisted Rayern audience (`rayern_audience`). Rayern
 * pushes these records to the dashboard; the composer reads them from the
 * local API only. Values are exactly what Rayern sent — absent plan or
 * subscription data stays absent and is never defaulted to a plan here.
 */
export interface SyncedAudienceRecord {
  email: string
  firstName: string | null
  lastName: string | null
  status: string
  emailVerified: boolean
  workspacePlan: string | null
  subscriptionPlan: string | null
  subscriptionStatus: string | null
  hasPaidAccess: boolean
  consentOptedIn: boolean
  consentedAt: string | null
  consentUpdatedAt?: string | null
  consentSource: string | null
  syncedAt?: string | null
}

export interface SyncedAudienceResponse {
  items: SyncedAudienceRecord[]
  counts: {
    total: number
    eligible: number
    optedIn: number
    optedOut: number
    suspended: number
    unverified?: number
  }
  /** Newest `synced_at` across the synchronized rows, null when never synced. */
  lastSyncedAt: string | null
}

function toAdminUserRecord(r: SyncedAudienceRecord): AdminUserRecord {
  const hasSubscription =
    r.subscriptionPlan !== null || r.subscriptionStatus !== null || r.hasPaidAccess === true
  const hasConsentRecord =
    r.consentOptedIn === true || r.consentSource !== null || r.consentedAt !== null
  return {
    id: r.email,
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    emailVerified: r.emailVerified,
    accountStatus: r.status,
    marketingConsent: hasConsentRecord
      ? {
          optedIn: r.consentOptedIn === true,
          consentedAt: r.consentedAt,
          updatedAt: r.consentUpdatedAt ?? r.consentedAt,
          source: r.consentSource ?? undefined,
        }
      : null,
    workspace: r.workspacePlan ? { plan: r.workspacePlan } : null,
    subscription: hasSubscription
      ? {
          plan: r.subscriptionPlan ?? undefined,
          status: r.subscriptionStatus ?? undefined,
          hasPaidAccess: r.hasPaidAccess,
        }
      : null,
  }
}

export const audienceService = {
  async list(): Promise<SyncedAudienceResponse> {
    if (USE_DEMO_DATA) {
      return {
        items: [],
        counts: { total: 0, eligible: 0, optedIn: 0, optedOut: 0, suspended: 0, unverified: 0 },
        lastSyncedAt: null,
      }
    }
    const res = await apiRequest<SyncedAudienceResponse>('/marketing/audience')
    return { ...res, items: res.items ?? [], lastSyncedAt: res.lastSyncedAt ?? null }
  },
  toAdminUserRecord,
}
