import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { AdminUserRecord, RayernPlan, SubscriptionStatus } from '../lib/types'

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
  consentSource: string | null
}

export interface SyncedAudienceResponse {
  items: SyncedAudienceRecord[]
  counts: { total: number; eligible: number; optedIn: number; optedOut: number; suspended: number }
}

function toAdminUserRecord(r: SyncedAudienceRecord): AdminUserRecord {
  return {
    id: r.email,
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    emailVerified: r.emailVerified,
    accountStatus: r.status,
    marketingConsent: r.consentOptedIn
      ? { optedIn: true, consentedAt: r.consentedAt, updatedAt: r.consentedAt, source: r.consentSource ?? undefined }
      : r.consentSource
        ? { optedIn: false, consentedAt: null, updatedAt: r.consentedAt, source: r.consentSource ?? undefined }
        : null,
    workspace: r.workspacePlan ? { plan: r.workspacePlan } : null,
    subscription: {
      plan: r.subscriptionPlan ?? r.workspacePlan ?? 'starter',
      status: r.subscriptionStatus ?? 'none',
      hasPaidAccess: r.hasPaidAccess,
    },
  }
}

export const audienceService = {
  async list(): Promise<SyncedAudienceResponse> {
    if (USE_DEMO_DATA) {
      return { items: [], counts: { total: 0, eligible: 0, optedIn: 0, optedOut: 0, suspended: 0 } }
    }
    const res = await apiRequest<{ items: SyncedAudienceRecord[]; counts: SyncedAudienceResponse['counts'] }>('/marketing/audience')
    return res
  },
  toAdminUserRecord,
}
