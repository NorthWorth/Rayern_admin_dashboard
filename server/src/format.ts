/**
 * Shared row → API-shape mappers. These are the privacy contract: routes may
 * only return data passing through these shapes.
 */
export interface AccountRow {
  id: string
  name: string
  email: string
  verification: string
  status: string
  created_at: Date
}

export interface WorkspaceRow {
  id: string
  name: string
  member_count: number
  plan: string
  created_at: Date
}

export interface EmailRow {
  id: string
  resend_id: string | null
  from_addr: string
  to_addrs: string[]
  cc_addrs: string[]
  bcc_addrs: string[]
  subject: string
  /** Composer body mode ('text' | 'html'); rows predating it read as 'text'. */
  body_type?: string | null
  type: string
  status: string
  sent_at: Date
}

export interface AuditRow {
  id: string
  actor: string
  actor_kind: string
  action: string
  target: string
  metadata: Record<string, string>
  timestamp: Date
}

export type VerificationStatus = 'verified' | 'unverified' | 'pending'
export type AccountStatus = 'active' | 'suspended' | 'closed'
export type WorkspacePlan = 'free' | 'pro' | 'team'
export type EmailType = 'update' | 'announcement' | 'promotion' | 'notice'
export type EmailStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'bounced'

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function toUser(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    verification: row.verification as VerificationStatus,
    status: row.status as AccountStatus,
    createdAt: iso(row.created_at),
  }
}

export function toWorkspace(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    memberCount: row.member_count,
    plan: row.plan as WorkspacePlan,
    createdAt: iso(row.created_at),
  }
}

export function toEmailMessage(row: EmailRow) {
  return {
    id: row.id,
    resendId: row.resend_id ?? '',
    from: row.from_addr,
    to: row.to_addrs,
    cc: row.cc_addrs,
    bcc: row.bcc_addrs,
    subject: row.subject,
    bodyType: row.body_type === 'html' ? ('html' as const) : ('text' as const),
    type: row.type as EmailType,
    status: row.status as EmailStatus,
    sentAt: iso(row.sent_at),
  }
}

export function toAuditEvent(row: AuditRow) {
  return {
    id: row.id,
    actor: row.actor,
    actorKind: row.actor_kind as 'admin' | 'system',
    action: row.action,
    target: row.target,
    metadata: row.metadata,
    timestamp: iso(row.timestamp),
  }
}
