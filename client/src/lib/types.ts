export type BillingCurrency = 'USD'
export type BillingAmountUnit = 'minor_units'
export type RayernServiceKind = 'api' | 'database' | 'cache' | 'queue' | 'email' | 'storage'
export type RayernServiceStatus = 'healthy' | 'degraded' | 'failing'

export interface AdminMetricAccounts {
  totalAccounts: number
  newAccounts30d: number
  verifiedAccounts: number
  unverifiedAccounts: number
  deletedAccounts30d: number | null
  deletionRequestsPending: number | null
  registrationsTrend: Array<{ date: string; count: number }>
  planBreakdown: Array<{ plan: string; count: number }>
}

export interface AdminMetricWorkspaces {
  totalWorkspaces: number
  newWorkspaces30d: number
  avgMembersPerWorkspace: number
}

export interface AdminMetricMrrByPlan {
  plan: string
  subscriberCount: number
  mrrMinor: number
}

export interface AdminMetricMrr {
  amountMinor: number
  amountMajor: number
  byPlan: AdminMetricMrrByPlan[]
}

export interface AdminMetricArr {
  amountMinor: number
  amountMajor: number
  definition: string
}

export interface AdminMetricPlanBreakdownEntry {
  plan: string
  userCount: number
  subscriptionCount: number
  isPaid: boolean
}

export interface AdminMetricBilling {
  currency: BillingCurrency
  amountUnit: BillingAmountUnit
  generatedAt: string
  activePaidSubscribers: number
  freeUsers: number
  totalAccounts: number
  mrr: AdminMetricMrr
  arr: AdminMetricArr
  planBreakdown: AdminMetricPlanBreakdownEntry[]
  definitions: Record<string, unknown>
}

export interface AdminMetricService {
  service: string
  kind: RayernServiceKind
  status: RayernServiceStatus
  uptimePct30d: number | null
  latencyMsP50: number | null
  latencyMsP95: number | null
  lastIncidentAt: string | null
}

export interface AdminMetricTelemetry {
  [key: string]: unknown
}

export interface AdminMetricEnvelope {
  success: true
  data: {
    accounts: AdminMetricAccounts
    workspaces: AdminMetricWorkspaces
    billing: AdminMetricBilling | null
    services: AdminMetricService[]
    telemetry: AdminMetricTelemetry
  }
}

export interface AdminMetricErrorEnvelope {
  success: false
  error: { code: string; message: string; fields?: Record<string, string> }
}

export type AdminMetricResponse = AdminMetricEnvelope | AdminMetricErrorEnvelope
