import { apiRequest, DEFAULT_FROM, USE_DEMO_DATA } from '../lib/api'
import type { ComposeEmailPayload, EmailMessage, EmailStats, EmailType } from '../lib/types'
import { buildEmails, buildEmailStats, buildSentEmail } from './demoData'

const demoEmails = buildEmails()

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/**
 * Who a bulk 'select all' may reach. Marketing consent gates PROMOTIONAL mail
 * only; operational/service messages must still reach opted-out or unverified
 * accounts, so they get the broader synchronized set.
 */
export type AudienceScope = 'promotional' | 'operational'

export interface AudienceRecipients {
  count: number
  recipients: string[]
  lastSyncedAt: string | null
  scope: AudienceScope
}

/** The scope the composer must use for a given email type. */
export function audienceScopeFor(type: EmailType): AudienceScope {
  return type === 'promotion' ? 'promotional' : 'operational'
}

/** The rule in effect, shown next to the audience freshness note. */
export const AUDIENCE_SCOPE_RULE: Record<AudienceScope, string> = {
  promotional: 'Recipient scope: promotional — opted in, active and email verified only.',
  operational:
    'Recipient scope: operational — every synchronized recipient, including opted-out and unverified accounts.',
}

/**
 * Email domain service. The browser never talks to Resend — composing an email
 * posts to the dashboard backend, which performs the actual send via Resend.
 * DEFAULT_FROM is only a display default; the backend validates/enforces it.
 */
export const emailsService = {
  list(): Promise<EmailMessage[]> {
    if (USE_DEMO_DATA) return delay(demoEmails)
    return apiRequest<EmailMessage[]>('/emails')
  },

  stats(): Promise<EmailStats> {
    if (USE_DEMO_DATA) return delay(buildEmailStats(demoEmails))
    return apiRequest<EmailStats>('/emails/stats')
  },

  /**
   * Bulk "select all" recipients: the same synchronized Rayern audience the
   * campaign composer reads, scoped by the email type, with its newest sync
   * time.
   */
  audience(scope: AudienceScope): Promise<AudienceRecipients> {
    if (USE_DEMO_DATA) return delay({ count: 0, recipients: [], lastSyncedAt: null, scope })
    return apiRequest<AudienceRecipients>(`/emails/audience?scope=${scope}`)
  },

  /** Content of a past email for "copy as new email" (never auto-sends). */
  copyBody(id: string): Promise<{ subject: string; message: string; to: string[]; cc: string[]; bcc: string[] }> {
    if (USE_DEMO_DATA) {
      const src = demoEmails.find((e) => e.id === id)
      return delay({ subject: src?.subject ?? '', message: '', to: src?.to ?? [], cc: src?.cc ?? [], bcc: src?.bcc ?? [] })
    }
    return apiRequest<{ subject: string; message: string; to: string[]; cc: string[]; bcc: string[] }>(`/emails/${id}/body`)
  },

  /** Sends an admin-composed email through the dashboard backend. */
  async send(payload: ComposeEmailPayload & { type?: EmailType }): Promise<EmailMessage> {
    const body = { ...payload, from: payload.from || DEFAULT_FROM }
    if (USE_DEMO_DATA) return delay(buildSentEmail({ subject: payload.subject, to: payload.to, cc: payload.cc, bcc: payload.bcc }), 900)
    return apiRequest<EmailMessage>('/emails/send', { method: 'POST', body })
  },
}
