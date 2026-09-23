/**
 * Email sending via Resend. The API key lives only on the server (env var);
 * the browser never sees it. The From identity is enforced server-side.
 *
 * Body modes: the caller passes EITHER `html` (HTML mode) OR `text`
 * (plain-text mode) — never both, never neither. The mode chosen in the
 * composer survives the whole path and lands in exactly one Resend field.
 *
 * Recipients: `to` may legitimately be EMPTY for CC-only/BCC-only sends.
 * Resend's installed SDK (resend@4.8.0) types `to` as a required
 * `string | string[]` and its API docs mark the field required (max 50),
 * with no documented representation for an empty `to`. We therefore always
 * include the field — as an empty array when there is no visible To
 * recipient — and NEVER invent a To address, because a fake To would leak
 * recipient visibility (a BCC-only send must stay BCC-only). If Resend's API
 * ever rejects an empty `to`, the provider error surfaces as a normal send
 * failure (recorded, shown to the admin) — no misleading workaround is
 * applied. `cc`/`bcc` are omitted entirely when empty.
 */
import { Resend } from 'resend'
import type { CreateEmailOptions } from 'resend'
import { SpanKind } from '@opentelemetry/api'
import { config } from './config'
import { withSpan } from './telemetry'

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
  /** Visible To recipients. May be empty (CC-only / BCC-only sends). */
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** HTML-mode body — goes ONLY to Resend's `html` field. */
  html?: string
  /** Plain-text-mode body — goes ONLY to Resend's `text` field. */
  text?: string
}

export interface SentEmailResult {
  resendId: string | null
  /** True when EMAIL_DRY_RUN=1: validated + recorded, not actually sent. */
  dryRun: boolean
}

/* ------------------------- Untrusted HTML handling ------------------------ */

/**
 * Strips script-capable constructs from admin-supplied email HTML before it
 * is stored or handed to the provider. Email HTML is untrusted content:
 * scripts, frames, embeds, form/base/meta/link elements, inline event
 * handlers and `javascript:`/`vbscript:`/`data:text/html` URLs are removed.
 * Formatting tags (including <style>) are preserved. This is defense in
 * depth — the dashboard's HTML preview additionally renders inside a fully
 * sandboxed iframe that cannot execute script regardless.
 */
export function sanitizeEmailHtml(fragment: string): string {
  // javascript:/vbscript: (with whitespace-obfuscation tolerance) plus the
  // data:text/html vector. Legitimate data:image/ URLs are intentionally kept.
  const DANGEROUS_URL = String.raw`(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t)\s*:|d\s*a\s*t\s*a\s*:\s*t\s*e\s*x\s*t\s*\/\s*h\s*t\s*m\s*l`
  return fragment
    // Container elements that can execute/relay script: remove tag + content.
    .replace(/<\s*(script|iframe|object|embed|applet|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    // Any remaining (possibly unclosed) dangerous/void tags.
    .replace(/<\s*(script|iframe|object|embed|applet|form|base|meta|link|portal)\b[^>]*>/gi, '')
    // Inline event handlers (onerror=, onload=, …) in any quoting style.
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Dangerous URL schemes in href/src (any quoting style).
    .replace(new RegExp(String.raw`\b(href|src)(\s*=\s*)["']?\s*${DANGEROUS_URL}`, 'gi'), '$1$2"#"')
}

/**
 * Wraps an HTML fragment in a minimal document so the composer never makes
 * the admin write `<!DOCTYPE html><html><head>…` boilerplate. A payload that
 * is already a full document is passed through unchanged.
 */
export function wrapHtmlFragment(fragment: string): string {
  const body = fragment.trim()
  if (/<!doctype\s+html|<html[\s>]/i.test(body)) return body
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    `<body>${body}</body></html>`
  )
}

/* ----------------------------- Resend payload ----------------------------- */

/**
 * Builds the exact payload handed to resend@4's `emails.send()`.
 *
 * - `to` is always present (SDK types require it) but may be `[]` — for a
 *   BCC-only or CC-only send no To address is ever fabricated.
 * - `cc`/`bcc` are present only when non-empty, so recipient visibility in
 *   the delivered message matches exactly what the admin composed.
 * - Exactly one body field: `html` in HTML mode, `text` in plain-text mode
 *   (the route guarantees at least one is set).
 *
 * Exported so tests can assert the provider payload without network access.
 */
export function buildResendPayload(email: OutgoingEmail, from: string): CreateEmailOptions {
  const base = {
    from,
    to: email.to,
    subject: email.subject,
    ...(email.cc.length > 0 ? { cc: email.cc } : {}),
    ...(email.bcc.length > 0 ? { bcc: email.bcc } : {}),
  }
  return email.html !== undefined
    ? { ...base, html: email.html }
    : { ...base, text: email.text ?? '' }
}

export async function sendEmail(email: OutgoingEmail): Promise<SentEmailResult> {
  const bodyMode = email.html !== undefined ? 'html' : 'text'
  if (config.emailDryRun) {
    // Aggregate counts only — a bulk send must never dump hundreds of
    // addresses into the logs.
    console.info(
      `[dashboard-api] EMAIL_DRY_RUN: would send "${email.subject}" ` +
        `to=${email.to.length} cc=${email.cc.length} bcc=${email.bcc.length} body=${bodyMode}`,
    )
    return { resendId: null, dryRun: true }
  }

  const from = `${config.emailFrom.name} <${config.emailFrom.address}>`
  const payload = buildResendPayload(email, from)
  // External HTTP CLIENT span (child of the requesting API span). No recipient,
  // subject, body or key is ever recorded — only duration and success/failure;
  // any provider error message is scrubbed of emails/ids before export.
  const result = await withSpan(
    {
      name: 'resend.send',
      kind: SpanKind.CLIENT,
      service: 'resend',
      operation: 'resend.send',
      attributes: { 'provider': 'resend', 'email.body_mode': bodyMode },
    },
    async () => {
      const r = await resendClient().emails.send(payload)
      if (r.error) {
        throw new Error(`Resend error: ${r.error.message}`)
      }
      return r
    },
  )
  return { resendId: result.data?.id ?? null, dryRun: false }
}

/** Server-enforced identity used for display and audit metadata. */
export function senderIdentity(): string {
  return `${config.emailFrom.name} <${config.emailFrom.address}>`
}
