/**
 * Email sending via Resend. The API key lives only on the server (env var);
 * the browser never sees it. The From identity is enforced server-side.
 */
import { Resend } from 'resend'
import { config } from './config'

let client: Resend | null = null

function resendClient(): Resend {
  if (!client) {
    if (!config.resendApiKey) {
      throw new Error('RESEND_API_KEY is not configured on the dashboard backend')
    }
    client = new Resend(config.resendApiKey)
  }
  return client
}

export interface OutgoingEmail {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html: string
  text: string
}

export interface SentEmailResult {
  resendId: string | null
  /** True when EMAIL_DRY_RUN=1: validated + recorded, not actually sent. */
  dryRun: boolean
}

export async function sendEmail(email: OutgoingEmail): Promise<SentEmailResult> {
  if (config.emailDryRun) {
    console.info(
      `[dashboard-api] EMAIL_DRY_RUN: would send "${email.subject}" to ${email.to.join(', ')}` +
        (email.cc.length ? ` (cc: ${email.cc.join(', ')})` : '') +
        (email.bcc.length ? ` (bcc: ${email.bcc.join(', ')})` : ''),
    )
    return { resendId: null, dryRun: true }
  }

  const from = `${config.emailFrom.name} <${config.emailFrom.address}>`
  const result = await resendClient().emails.send({
    from,
    to: email.to,
    cc: email.cc.length > 0 ? email.cc : undefined,
    bcc: email.bcc.length > 0 ? email.bcc : undefined,
    subject: email.subject,
    html: email.html,
    text: email.text,
  })

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`)
  }
  return { resendId: result.data?.id ?? null, dryRun: false }
}

/** Server-enforced identity used for display and audit metadata. */
export function senderIdentity(): string {
  return `${config.emailFrom.name} <${config.emailFrom.address}>`
}
