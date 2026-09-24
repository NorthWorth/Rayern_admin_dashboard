/**
 * Email delivery orchestration — the privacy-critical heart of the send path.
 *
 * The frontend submits the LOGICAL composition (To/CC/BCC lists + body +
 * mode). THIS module owns everything provider-facing (spec §1–§3):
 *
 * NORMAL sends (To present, no BCC) keep the classic transport: one
 * `emails.send` call with the exact composed To/CC structure — multiple To
 * recipients stay one message (standard email semantics the admin composed,
 * spec §3). CC-only/BCC-only messages cannot use this transport because
 * Resend's email API requires a `to` recipient.
 *
 * EXPANDED sends (any BCC, or CC-only) build INDIVIDUAL messages:
 *   - each hidden (BCC) recipient → one message, `to` = that recipient ALONE
 *   - CC-only recipients → one message each, `to` = that recipient alone
 *   (a message whose `to` would be empty can never be submitted — that is
 *   the provider constraint that motivates this architecture)
 *   - with visible To recipients present, they additionally receive ONE
 *     normal message preserving the composed visible structure
 *
 * VISIBILITY GUARANTEE (spec §1): an expanded message carries exactly one
 * `to` — the recipient alone. No fake To, no shared list. Alice/Bob/Carol in
 * BCC receive three separate emails, each addressed only to themselves.
 *
 * BATCHING: expanded messages go through Resend's Batch API in chunks of ≤
 * RESEND_BATCH_CHUNK_SIZE (provider max 100). Each message in a batch is an
 * individual email for usage purposes (spec §6).
 *
 * IDEMPOTENCY (spec §2, §11): every provider submission carries a
 * deterministic `Idempotency-Key` = `<sendGroupId>:<kind>:<index>` (`m` =
 * single message, `b` = batch chunk; expanded rows append the recipient).
 * A retried submission re-uses the SAME key so Resend deduplicates; a
 * timeout/lost response is safe to re-submit. The route additionally
 * replays a completed sendGroupId without contacting the provider.
 *
 * RECONCILIATION (spec §12): when a submission's outcome is UNKNOWN
 * (timeout / lost response), messages are persisted `uncertain` and NOT
 * counted as usage. A reconciliation pass re-submits them with their
 * ORIGINAL keys: already-accepted messages return the same ids without
 * re-sending; never-received ones are delivered now; rejected ones become
 * `failed`. Reconciliation failure keeps last-known usage — the dashboard
 * stays fully usable.
 */
import { query } from './db'
import { config } from './config'
import { withSpan } from './telemetry'
import { SpanKind } from '@opentelemetry/api'
import {
  buildExpandedMessage,
  submitBatchChunk,
  submitSingle,
  type OutgoingEmail,
  type SendOutcome,
} from './emailer'

export interface DeliveryResult {
  sendGroupId: string
  /** Individual provider messages (usage semantics), never batch requests. */
  messageCount: number
  /** Provider API requests used to carry them (batch chunks + singles). */
  batchCount: number
  accepted: number
  uncertain: number
  failed: number
  /** True when at least one provider submission was definitively accepted. */
  ok: boolean
  /** True when every message is accepted (dry-run counts as accepted). */
  allAccepted: boolean
}

export function senderIdentity(): string {
  return `${config.emailFrom.name} <${config.emailFrom.address}>`
}

/**
 * True when the composition cannot travel as one classic message: any BCC
 * recipient must be isolated, and a To-less CC-only send cannot satisfy the
 * provider's required `to` field.
 */
export function requiresExpansion(email: OutgoingEmail): boolean {
  return email.bcc.length > 0 || (email.to.length === 0 && email.cc.length > 0)
}

/** Individual provider messages an operation will consume (quota input). */
export function expansionMessageCount(email: OutgoingEmail): number {
  if (!requiresExpansion(email)) return 1
  if (email.to.length > 0) return 1 + email.bcc.length
  return email.cc.length + email.bcc.length
}

/** Splits items into provider-sized chunks (≤ 100 for Resend Batch API). */
export function chunkMessages<T>(items: T[], size = config.resend.batchChunkSize): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/* ------------------------------- Persistence ------------------------------- */

interface EmailRowId {
  id: string
}

/**
 * Persists ONE individual provider message. `recipient` is the message's own
 * To (never an audience). `visible` carries the composed visible recipients
 * for history, and `groupMeta` records the original logical composition so
 * copy-as-new and grouped history can reconstruct the admin's action.
 */
async function insertMessage(row: {
  sendGroupId: string
  idempotencyKey: string
  recipient: string
  visibleTo: string[]
  visibleCc: string[]
  bccCount: number
  subject: string
  body: string
  bodyType: 'text' | 'html'
  type: string
  status: SendOutcome
  providerMessageId: string | null
  messageCount: number
  batchCount: number
  mode: 'expanded' | 'normal'
}): Promise<string> {
  const groupMeta =
    row.mode === 'expanded'
      ? JSON.stringify({ to: row.visibleTo, cc: row.visibleCc, bccCount: row.bccCount, mode: row.mode })
      : null
  const rows = await query<EmailRowId>(
    `INSERT INTO emails (resend_id, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, body, body_type, type, status,
                         idempotency_key, send_group_id, message_count, batch_count, provider_message_id, group_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      row.providerMessageId,
      senderIdentity(),
      [row.recipient],
      row.mode === 'expanded' ? row.visibleCc : row.visibleCc,
      // BCC stays out of per-row storage: the group's rows collectively
      // represent the hidden audience; group_meta records its count and the
      // audit metadata records the counts. Nobody's address is duplicated
      // onto other recipients' rows.
      [],
      row.subject,
      row.body,
      row.bodyType,
      row.type,
      row.status,
      row.idempotencyKey,
      row.sendGroupId,
      row.messageCount,
      row.batchCount,
      row.providerMessageId,
      groupMeta,
    ],
  )
  return rows[0].id
}

/** A submission that was already completed for this logical send. */
export async function findCompletedGroup(sendGroupId: string): Promise<DeliveryResult | null> {
  const rows = await query<{
    message_count: number
    batch_count: number
    accepted: string
    uncertain: string
    failed: string
  }>(
    `SELECT
       MAX(message_count)::int AS message_count,
       MAX(batch_count)::int   AS batch_count,
       COUNT(*) FILTER (WHERE status IN ('accepted','sent','delivered'))::text AS accepted,
       COUNT(*) FILTER (WHERE status = 'uncertain')::text AS uncertain,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
     FROM emails WHERE send_group_id = $1`,
    [sendGroupId],
  )
  const r = rows[0]
  if (!r || Number(r.accepted) + Number(r.uncertain) + Number(r.failed) === 0) return null
  const accepted = Number(r.accepted)
  const uncertain = Number(r.uncertain)
  const failed = Number(r.failed)
  return {
    sendGroupId,
    messageCount: r.message_count ?? 0,
    batchCount: r.batch_count ?? 0,
    accepted,
    uncertain,
    failed,
    ok: accepted > 0 || uncertain > 0,
    allAccepted: r.message_count !== null && accepted === r.message_count && failed === 0 && uncertain === 0,
  }
}

/* ------------------------------- The send path ------------------------------ */

/**
 * Executes a logical send through the right transport. Each message is
 * persisted only AFTER its provider outcome is known (spec §11) — usage is
 * never incremented speculatively.
 */
export async function deliverEmail(input: {
  email: OutgoingEmail
  /** Sanitized + mode-resolved body (route-owned). */
  storedBody: string
  bodyType: 'text' | 'html'
  type: string
  sendGroupId: string
}): Promise<DeliveryResult> {
  const { email } = input
  const mode: 'expanded' | 'normal' = requiresExpansion(email) ? 'expanded' : 'normal'

  return withSpan(
    {
      name: 'email.deliver',
      kind: SpanKind.INTERNAL,
      service: 'email',
      operation: 'email.deliver',
      attributes: {
        'email.mode': mode,
        // Counts only — never recipient addresses (privacy boundary).
        'email.to_count': email.to.length,
        'email.cc_count': email.cc.length,
        'email.bcc_count': email.bcc.length,
        'email.messages': expansionMessageCount(email),
      },
    },
    async () => {
      if (mode === 'expanded') {
        return deliverExpanded(input, email)
      }
      return deliverNormal(input, email)
    },
  )
}

interface CommonInput {
  storedBody: string
  bodyType: 'text' | 'html'
  type: string
  sendGroupId: string
}

/** Normal transport: one provider message preserving the composed structure. */
async function deliverNormal(input: CommonInput, email: OutgoingEmail): Promise<DeliveryResult> {
  const key = `${input.sendGroupId}:m:0`
  try {
    const res = await submitSingle(email, key)
    await insertMessage({
      sendGroupId: input.sendGroupId,
      idempotencyKey: key,
      recipient: email.to[0] ?? email.cc[0] ?? '',
      visibleTo: email.to,
      visibleCc: email.cc,
      bccCount: 0,
      subject: email.subject,
      body: input.storedBody,
      bodyType: input.bodyType,
      type: input.type,
      status: res.outcome,
      providerMessageId: res.providerMessageId,
      messageCount: 1,
      batchCount: 0,
      mode: 'normal',
    })
    return {
      sendGroupId: input.sendGroupId,
      messageCount: 1,
      batchCount: 0,
      accepted: res.outcome === 'accepted' ? 1 : 0,
      uncertain: res.outcome === 'uncertain' ? 1 : 0,
      failed: res.outcome === 'failed' ? 1 : 0,
      ok: res.outcome !== 'failed',
      allAccepted: res.outcome === 'accepted',
    }
  } catch (err) {
    // Provider rejection: persist the failed message, then surface the error.
    await insertMessage({
      sendGroupId: input.sendGroupId,
      idempotencyKey: key,
      recipient: email.to[0] ?? email.cc[0] ?? '',
      visibleTo: email.to,
      visibleCc: email.cc,
      bccCount: 0,
      subject: email.subject,
      body: input.storedBody,
      bodyType: input.bodyType,
      type: input.type,
      status: 'failed',
      providerMessageId: null,
      messageCount: 1,
      batchCount: 0,
      mode: 'normal',
    })
    throw err
  }
}

/**
 * Expanded transport: individual messages per recipient that must not see
 * the others, plus one normal message for the visible audience when present.
 *
 *  - visible To present → one normal message (to = composed To, cc = CC)
 *  - every BCC recipient → to = [recipient], cc = composed CC (visible CC is
 *    legitimately visible in standard BCC semantics; BCC never is)
 *  - CC-only (no To) → each CC recipient gets to = [recipient]
 */
async function deliverExpanded(input: CommonInput, email: OutgoingEmail): Promise<DeliveryResult> {
  const visibleTo = email.to
  const visibleCc = email.cc

  // One provider message per unit, in deterministic order.
  const units: Array<{ recipient: string; to: string[]; cc: string[] }> = []
  if (visibleTo.length > 0) {
    // The visible conversation stays one message (spec §3).
    units.push({ recipient: visibleTo[0], to: visibleTo, cc: visibleCc })
  }
  for (const c of visibleCc) {
    if (visibleTo.length === 0) units.push({ recipient: c, to: [c], cc: [] })
  }
  for (const h of email.bcc) {
    units.push({ recipient: h, to: [h], cc: visibleCc })
  }

  const chunks = chunkMessages(units)
  let accepted = 0
  let uncertain = 0
  let failed = 0
  let batchCount = 0

  const persistUnit = async (
    u: { recipient: string; to: string[]; cc: string[] },
    key: string,
    status: SendOutcome,
    providerMessageId: string | null,
  ): Promise<void> => {
    await insertMessage({
      sendGroupId: input.sendGroupId,
      idempotencyKey: key,
      recipient: u.recipient,
      visibleTo,
      visibleCc,
      bccCount: email.bcc.length,
      subject: email.subject,
      body: input.storedBody,
      bodyType: input.bodyType,
      type: input.type,
      status,
      providerMessageId,
      messageCount: units.length,
      batchCount: chunks.length,
      mode: 'expanded',
    })
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]
    const key = `${input.sendGroupId}:b:${chunkIndex}`
    batchCount++
    let outcome: SendOutcome = 'failed'
    let providerMessageIds: string[] = []
    try {
      const res = await submitBatchChunk(
        chunk.map((u) => buildExpandedMessage(email, u.recipient, u.to, u.cc)),
        key,
      )
      outcome = res.outcome
      providerMessageIds = res.providerMessageIds
    } catch (err) {
      // Provider rejected the chunk: persist every message in it as failed,
      // then rethrow so the route surfaces a clear error.
      for (const u of chunk) {
        await persistUnit(u, `${key}:${u.recipient}`, 'failed', null)
        failed++
      }
      throw err
    }
    for (let i = 0; i < chunk.length; i++) {
      const u = chunk[i]
      // An accepted message with a NULL/'' id (dry-run) stores NULL — the
      // unique index must never hold an empty placeholder.
      const rawId = outcome === 'accepted' ? providerMessageIds[i] ?? null : null
      const messageId = rawId && rawId.length > 0 ? rawId : null
      await persistUnit(u, `${key}:${u.recipient}`, outcome, messageId)
      if (outcome === 'accepted') accepted++
      else if (outcome === 'uncertain') uncertain++
      else failed++
    }
  }

  return {
    sendGroupId: input.sendGroupId,
    messageCount: units.length,
    batchCount,
    accepted,
    uncertain,
    failed,
    ok: accepted > 0 || uncertain > 0,
    allAccepted: accepted === units.length && failed === 0 && uncertain === 0,
  }
}

/* ------------------------------- Reconciliation ----------------------------- */

/**
 * Resolves uncertain messages (spec §12) by re-submitting them with their
 * ORIGINAL idempotency keys, grouped back into their batch chunks. Never
 * throws: a failed reconciliation keeps last-known usage and a later pass
 * retries the remaining rows.
 */
export async function reconcileUncertainMessages(): Promise<{
  attempted: number
  accepted: number
  failed: number
  stillUncertain: number
}> {
  if (!config.resend.reconcileUncertainBatches || config.emailDryRun) {
    return { attempted: 0, accepted: 0, failed: 0, stillUncertain: 0 }
  }
  const rows = await query<{
    id: string
    idempotency_key: string
    to_addrs: string[]
    cc_addrs: string[]
    subject: string
    body: string
    body_type: string
  }>(
    `SELECT id, idempotency_key, to_addrs, cc_addrs, subject, body, body_type
     FROM emails WHERE status = 'uncertain' ORDER BY sent_at ASC LIMIT 500`,
  )
  if (rows.length === 0) {
    return { attempted: 0, accepted: 0, failed: 0, stillUncertain: 0 }
  }

  // Group by chunk key: `<groupId>:b:<chunkIndex>` (singles: `<groupId>:m:0`).
  // Keys end with `:<recipient>` (email addresses contain no colons), so the
  // chunk prefix is everything up to the last colon.
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = row.idempotency_key
    const groupKey = key.includes(':b:') ? key.slice(0, key.lastIndexOf(':')) : key
    const list = groups.get(groupKey) ?? []
    list.push(row)
    groups.set(groupKey, list)
  }

  let attempted = 0
  let accepted = 0
  let failed = 0
  let stillUncertain = 0

  const settleAll = async (
    messages: typeof rows,
    outcome: SendOutcome,
    providerMessageIds: string[],
  ): Promise<void> => {
    for (let i = 0; i < messages.length; i++) {
      const messageId = outcome === 'accepted' ? providerMessageIds[i] ?? null : null
      if (outcome === 'accepted') {
        await query(`UPDATE emails SET status = 'accepted', provider_message_id = $2 WHERE id = $1`, [
          messages[i].id,
          messageId,
        ])
        accepted++
      } else if (outcome === 'failed') {
        await query(`UPDATE emails SET status = 'failed' WHERE id = $1`, [messages[i].id])
        failed++
      } else {
        stillUncertain++
      }
    }
  }

  for (const [groupKey, messages] of groups) {
    attempted += messages.length
    try {
      if (groupKey.endsWith(':m:0')) {
        // Single (normal) message — resubmit alone with its original key.
        const first = messages[0]
        const res = await submitSingle(
          {
            to: first.to_addrs,
            cc: first.cc_addrs,
            bcc: [],
            subject: first.subject,
            ...(first.body_type === 'html' ? { html: first.body } : { text: first.body }),
          },
          first.idempotency_key,
        )
        await settleAll(messages, res.outcome, res.providerMessageId ? [res.providerMessageId] : [])
      } else {
        // Batch chunk — resubmit as a unit (same order, same chunk key).
        const res = await submitBatchChunk(
          messages.map((m) => ({
            from: senderIdentity(),
            to: m.to_addrs,
            subject: m.subject,
            ...(m.body_type === 'html' ? { html: m.body } : { text: m.body }),
          })),
          groupKey,
        )
        await settleAll(messages, res.outcome, res.providerMessageIds)
      }
    } catch {
      // Reconciliation failure must never break the dashboard: keep the
      // uncertain rows; a later pass retries them.
      stillUncertain += messages.length
    }
  }
  return { attempted, accepted, failed, stillUncertain }
}
