/**
 * Email sending via Resend. The API key lives only on the server (env var);
 * the browser never sees it. The From identity is enforced server-side.
 *
 * Body modes: the caller passes EITHER `html` (HTML mode) OR `text`
 * (plain-text mode) — never both, never neither. The mode chosen in the
 * composer survives the whole path and lands in exactly one Resend field.
 * HTML is sanitized/wrapped by the route BEFORE it gets here; this module
 * never re-interprets a body.
 *
 * Provider transport (two shapes, chosen by the recipient structure):
 *
 *  1. Normal sends (To and/or CC present) → `emails.send()` with the exact
 *     To/CC/BCC structure the admin composed. Multiple To recipients remain
 *     a single message (Resend shows all To recipients to each other — that
 *     is standard email semantics the admin explicitly composed).
 *
 *  2. Recipient-expanded sends (BCC-only, and BCC alongside visible
 *     recipients) → `batch.send()` with ONE message per hidden recipient,
 *     each message carrying ONLY that recipient in its `to`. Every recipient
 *     receives a message addressed to them alone — BCC recipients can never
 *     see one another, and no fake/shared To is ever fabricated. The Batch
 *     API accepts up to 100 messages per request; larger operations are
 *     chunked (see emailDelivery.ts). Each message in a batch is an
 *     individual email for usage/quota purposes.
 *
 * Idempotency: every provider submission carries a deterministic
 * `Idempotency-Key` (logical send id + message index — see emailDelivery.ts).
 * Resend treats a retried submission with the same key as the same operation,
 * so a timeout/lost response can be safely re-submitted without duplicating
 * a send.
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
  /** Visible To recipients. May be empty when visibility is handled by expansion. */
  to: string[]
  cc: string[]
  /** Hidden recipients — expanded into individual messages, never shared. */
  bcc: string[]
  subject: string
  /** HTML-mode body — goes ONLY to Resend's `html` field. */
  html?: string
  /** Plain-text-mode body — goes ONLY to Resend's `text` field. */
  text?: string
}

/** One individual provider message (exactly one `to` recipient when expanded). */
export interface OutgoingMessage {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html?: string
  text?: string
}

/**
 * Outcome of a provider submission:
 *  - `accepted`  — provider confirmed receipt (one or more ids returned)
 *  - `uncertain` — submission outcome unknown (timeout/lost response). NOT
 *                  counted as usage; reconciliation decides (emailDelivery).
 *  - `failed`    — provider rejected the submission; nothing was sent.
 */
export type SendOutcome = 'accepted' | 'uncertain' | 'failed'

export interface SentEmailResult {
  /** Provider message ids — one per individual message, in submission order. */
  providerMessageIds: string[]
  outcome: SendOutcome
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

/* ----------------------------- Resend payloads ----------------------------- */

/**
 * Builds the exact payload handed to resend@4's `emails.send()` for a normal
 * (visible-recipient) message.
 *
 * - `to` is always present (SDK types require it) and is empty ONLY when the
 *   message is part of an expanded send where the route has already decided
 *   visibility (see emailDelivery.ts) — no To address is ever fabricated.
 * - `cc`/`bcc` are present only when non-empty, so recipient visibility in
 *   the delivered message matches exactly what was composed.
 * - Exactly one body field: `html` in HTML mode, `text` in plain-text mode.
 *
 * Exported so tests can assert the provider payload without network access.
 */
export function buildResendPayload(email: OutgoingMessage, from: string): CreateEmailOptions {
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

/**
 * Builds one individual message of an expanded send: `to`/`cc` are provided
 * by the caller (the recipient alone for hidden recipients) — never a shared
 * list of BCC recipients, never a fabricated placeholder. Subject/body/mode
 * are preserved verbatim, so every expanded message is identical in content
 * to a normal send of the same composition. Exported for tests.
 */
export function buildExpandedMessage(
  email: OutgoingEmail,
  _recipient: string,
  to: string[],
  cc: string[],
): CreateEmailOptions {
  return {
    from: from(),
    to,
    subject: email.subject,
    ...(cc.length > 0 ? { cc } : {}),
    ...(email.html !== undefined ? { html: email.html } : { text: email.text ?? '' }),
  }
}

/** Sender identity used for every provider submission. */
function from(): string {
  return `${config.emailFrom.name} <${config.emailFrom.address}>`
}

/** Server-enforced identity used for display and audit metadata. */
export function senderIdentity(): string {
  return from()
}

/* ------------------------------ Submission -------------------------------- */

/** Classifies a thrown submission error: network-ish failures are `uncertain`
 * (the provider may have accepted the message), provider rejections (the SDK
 * returned an error response) are definite `failed`. */
export function isUncertainSendError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name.toLowerCase()
    const msg = err.message.toLowerCase()
    if (name.includes('timeout') || name.includes('abort')) return true
    if (
      msg.includes('timeout') ||
      msg.includes('aborted') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up')
    ) {
      return true
    }
  }
  return false
}

/**
 * Submits ONE normal (visible-recipient) message via `emails.send` with an
 * idempotency key. Throws on provider rejection; network-ish failures carry
 * `uncertain: true` so the caller can reconcile instead of double-counting.
 */
export async function submitSingle(
  email: OutgoingMessage,
  idempotencyKey: string,
): Promise<{ providerMessageId: string | null; outcome: SendOutcome }> {
  if (config.emailDryRun) {
    const bodyMode = email.html !== undefined ? 'html' : 'text'
    // Aggregate counts only — a bulk send must never dump addresses into logs.
    console.info(
      `[dashboard-api] EMAIL_DRY_RUN: would send \"${email.subject}\" ` +
        `to=${email.to.length} cc=${email.cc.length} bcc=${email.bcc.length} body=${bodyMode} idem=${idempotencyKey}`,
    )
    return { providerMessageId: null, outcome: 'accepted' }
  }
  const payload = buildResendPayload(email, from())
  try {
    const result = await withSpan(
      {
        name: 'resend.send',
        kind: SpanKind.CLIENT,
        service: 'resend',
        operation: 'resend.send',
        attributes: { 'provider': 'resend', 'email.body_mode': email.html !== undefined ? 'html' : 'text' },
      },
      async () => resendClient().emails.send(payload, { idempotencyKey }),
    )
    if (result.error) {
      throw new Error(`Resend error: ${result.error.message}`)
    }
    return { providerMessageId: result.data?.id ?? null, outcome: 'accepted' }
  } catch (err) {
    if (isUncertainSendError(err)) {
      return { providerMessageId: null, outcome: 'uncertain' }
    }
    throw err
  }
}

/**
 * Submits a CHUNK (≤ RESEND_BATCH_CHUNK_SIZE messages, Resend max 100) via
 * the Batch API with one idempotency key per chunk. Every message in the
 * chunk is an individual email. The batch response returns one id per
 * message, in the same order as the submission.
 */
export async function submitBatchChunk(
  messages: CreateEmailOptions[],
  idempotencyKey: string,
): Promise<{ providerMessageIds: string[]; outcome: SendOutcome }> {
  if (messages.length === 0) return { providerMessageIds: [], outcome: 'accepted' }
  if (config.emailDryRun) {
    console.info(
      `[dashboard-api] EMAIL_DRY_RUN: would batch-send \"${String(messages[0]?.subject ?? '')}\" ` +
        `messages=${messages.length} idem=${idempotencyKey}`,
    )
    // NULL ids: dry-run rows must not occupy the unique provider-id index.
    return { providerMessageIds: messages.map(() => null as unknown as string), outcome: 'accepted' }
  }
  try {
    const result = await withSpan(
      {
        name: 'resend.batch',
        kind: SpanKind.CLIENT,
        service: 'resend',
        operation: 'resend.batch',
        attributes: {
          'provider': 'resend',
          'email.batch_messages': messages.length,
          'email.body_mode': messages[0]?.html !== undefined ? 'html' : 'text',
        },
      },
      async () => resendClient().batch.send(messages, { idempotencyKey }),
    )
    if (result.error) {
      throw new Error(`Resend batch error: ${result.error.message}`)
    }
    const ids = (result.data?.data ?? []).map((m) => m.id)
    return { providerMessageIds: ids, outcome: 'accepted' }
  } catch (err) {
    if (isUncertainSendError(err)) {
      return { providerMessageIds: [], outcome: 'uncertain' }
    }
    throw err
  }
}
