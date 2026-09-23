import { apiRequest, DEFAULT_FROM, USE_DEMO_DATA } from '../lib/api'
import type { ComposeEmailPayload, EmailBodyType, EmailMessage, EmailStats, EmailType } from '../lib/types'
import { buildEmails, buildEmailStats, buildSentEmail } from './demoData'

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

  /** Sends an admin-composed email through the dashboard backend. */
  async send(payload: ComposeEmailPayload & { type?: EmailType }): Promise<EmailMessage> {
    const body = { ...payload, from: payload.from || DEFAULT_FROM }
    if (USE_DEMO_DATA) {
      return delay(
        buildSentEmail({ subject: payload.subject, to: payload.to, cc: payload.cc, bcc: payload.bcc, bodyType: payload.bodyType }),
        900,
      )
    }
    return apiRequest<EmailMessage>('/emails/send', { method: 'POST', body })
  },
}
