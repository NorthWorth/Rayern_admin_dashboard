import { apiRequest, DEFAULT_FROM, USE_DEMO_DATA } from '../lib/api'
import type {
  ComposeEmailPayload,
  EmailBodyType,
  EmailMessage,
  EmailStats,
  EmailType,
  EmailUsage,
} from '../lib/types'
import { buildEmails, buildEmailStats, buildEmailUsage, buildSentEmail } from './demoData'

const demoEmails = buildEmails()

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
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

  /** Recipients available for bulk "select all" (account emails only). */
  audience(verification: 'verified' | 'unverified' | 'all' = 'all'): Promise<{ count: number; recipients: string[] }> {
    if (USE_DEMO_DATA) return delay({ count: 0, recipients: [] })
    return apiRequest<{ count: number; recipients: string[] }>(`/emails/audience?verification=${verification}`)
  },

  /** Persisted monthly/daily usage + remaining quota (backend-computed). */
  usage(): Promise<EmailUsage> {
    if (USE_DEMO_DATA) return delay(buildEmailUsage())
    return apiRequest<EmailUsage>('/emails/usage')
  },

  /** Reconcile uncertain submissions with the provider (safe to call anytime). */
  reconcile(): Promise<{ usage: EmailUsage }> {
    if (USE_DEMO_DATA) return delay({ usage: buildEmailUsage() })
    return apiRequest<{ usage: EmailUsage }>('/emails/usage/reconcile', { method: 'POST' })
  },

  /**
   * Content of a past email for "copy as new email" (never auto-sends).
   * Includes bodyType so the composer reopens in the original mode.
   */
  copyBody(
    id: string,
  ): Promise<{ subject: string; message: string; bodyType: EmailBodyType; to: string[]; cc: string[]; bcc: string[] }> {
    const shape = { subject: '', message: '', bodyType: 'text' as EmailBodyType, to: [] as string[], cc: [] as string[], bcc: [] as string[] }
    if (USE_DEMO_DATA) {
      const src = demoEmails.find((e) => e.id === id)
      return delay({
        ...shape,
        subject: src?.subject ?? '',
        bodyType: src?.bodyType ?? 'text',
        to: src?.to ?? [],
        cc: src?.cc ?? [],
        bcc: src?.bcc ?? [],
      })
    }
    return apiRequest<typeof shape>(`/emails/${id}/body`)
  },

  /**
   * Sends an admin-composed email through the dashboard backend. A
   * client-generated idempotency key makes a retried/double-clicked request
   * replay the original result instead of sending twice (the backend is the
   * authoritative dedup — this key just survives a lost first response).
   */
  async send(payload: ComposeEmailPayload & { type?: EmailType }): Promise<EmailMessage> {
    const body = { ...payload, from: payload.from || DEFAULT_FROM }
    if (USE_DEMO_DATA) {
      return delay(
        buildSentEmail({ subject: payload.subject, to: payload.to, cc: payload.cc, bcc: payload.bcc, bodyType: payload.bodyType }),
        900,
      )
    }
    const idempotencyKey = crypto.randomUUID()
    return apiRequest<EmailMessage>('/emails/send', { method: 'POST', body: { ...body, idempotencyKey } })
  },
}
