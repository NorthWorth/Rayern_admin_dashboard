import { useState, useEffect } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Field, Input, Textarea } from '../components/ui/Input'
import { TokenInput } from '../components/ui/TokenInput'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { VolumeBarChart } from '../components/charts'
import { useToast } from '../components/ui/Toast'
import { useQuery } from '../hooks/useQuery'
import { emailsService } from '../services/emails'
import { DEFAULT_FROM } from '../lib/api'
import { audienceSummary, clsx, formatDateTime, formatNumber, titleCase } from '../lib/utils'
import type { EmailBodyType, EmailMessage, EmailType } from '../lib/types'

import { emailStatusTone } from './Overview'

const TYPE_LABELS: Record<EmailType, string> = {
  update: 'Product update',
  announcement: 'Announcement',
  promotion: 'Promotional',
  notice: 'Important notice',
}

function typeTone(t: EmailType): 'blue' | 'green' | 'amber' | 'neutral' {
  switch (t) {
    case 'update': return 'blue'
    case 'announcement': return 'green'
    case 'promotion': return 'amber'
    default: return 'neutral'
  }
}

const BODY_LABEL: Record<EmailBodyType, string> = { html: 'HTML', text: 'Plain Text' }

/**
 * Browser-like document for the HTML preview. Rendered inside a fully
 * sandboxed iframe (sandbox="") — no script, forms, popups or navigation can
 * execute, so untrusted email HTML can never run JS in the dashboard.
 */
function previewDocument(html: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>body{margin:16px;font-family:Inter,Segoe UI,system-ui,sans-serif;' +
    'font-size:14px;line-height:1.6;color:#1b1f25;}img{max-width:100%;height:auto;}' +
    'a{color:#1f6f54;}</style></head><body>' +
    html +
    '</body></html>'
  )
}

export function EmailsPage() {
  const listQ = useQuery(() => emailsService.list())
  const statsQ = useQuery(() => emailsService.stats())
  const [composerOpen, setComposerOpen] = useState(false)
  const [copySource, setCopySource] = useState<string | null>(null)

  const emails = listQ.data ?? []

  const openComposer = (copyId: string | null = null): void => {
    setCopySource(copyId)
    setComposerOpen(true)
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="grid flex-1 grid-cols-2 gap-3 lg:grid-cols-5">          <KpiCard label="Sent (30d)" value={statsQ.data ? formatNumber(statsQ.data.totalSent) : '—'} />
          <KpiCard label="Delivered" value={statsQ.data ? formatNumber(statsQ.data.delivered) : '—'} tone="green" />
          <KpiCard label="Failed" value={statsQ.data ? formatNumber(statsQ.data.failed) : '—'} tone="red" />
          <KpiCard label="Bounced" value={statsQ.data ? formatNumber(statsQ.data.bounced) : '—'} tone="amber" />
          <KpiCard
            label="Sent from console"
            value={statsQ.data ? formatNumber(statsQ.data.byType.reduce((s, t) => s + t.count, 0)) : '—'}
            sub="admin-initiated emails"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Email volume (30d)" subtitle="Sent vs failed per day" />
          <CardBody>
            {statsQ.loading ? (
              <LoadingBlock rows={6} />
            ) : statsQ.error ? (
              <ErrorState message={statsQ.error} onRetry={statsQ.refetch} />
            ) : statsQ.data ? (
              <VolumeBarChart
                data={statsQ.data.daily.map((d) => ({ date: d.date.slice(5), sent: d.sent, failed: d.failed }))}
                xKey="date"
                series={[
                  { key: 'sent', name: 'Sent', color: '#1f6f54' },
                  { key: 'failed', name: 'Failed', color: '#d64545' },
                ]}
              />
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="By type" subtitle="Volume split by email category (30d)" />
          <CardBody>
            {statsQ.loading ? (
              <LoadingBlock rows={4} />
            ) : statsQ.error ? (
              <ErrorState message={statsQ.error} onRetry={statsQ.refetch} />
            ) : statsQ.data ? (
              <VolumeBarChart
                data={statsQ.data.byType.map((t) => ({ type: TYPE_LABELS[t.type], count: t.count }))}
                xKey="type"
                series={[{ key: 'count', name: 'Emails', color: '#40464f' }]}
              />
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent email activity"
          subtitle="Metadata only — audience shown as counts; content is never displayed here"
          actions={
            <Button variant="primary" onClick={() => openComposer()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              Send Email
            </Button>
          }
        />
        {listQ.loading ? (
          <CardBody><LoadingBlock rows={8} /></CardBody>
        ) : listQ.error ? (
          <ErrorState message={listQ.error} onRetry={listQ.refetch} />
        ) : emails.length === 0 ? (
          <EmptyState title="No emails yet" description="Emails sent through the dashboard backend will appear here." />
        ) : (
          <>
            {/* Desktop: audience rendered as counts — never hundreds of addresses. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Audience</th>
                    <th scope="col" className="px-3 py-2.5">Subject</th>
                    <th scope="col" className="px-3 py-2.5">Type</th>
                    <th scope="col" className="px-3 py-2.5">Status</th>
                    <th scope="col" className="px-3 py-2.5">Sent</th>
                    <th scope="col" className="px-3 py-2.5">Message ID</th>
                    <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {emails.map((e: EmailMessage) => {
                    const a = audienceSummary(e.to, e.cc, e.bcc)
                    return (
                      <tr key={e.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70 group">
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <p className="text-[13px] font-medium text-ink-800">{a.label}</p>
                          {a.breakdown ? <p className="text-[11px] text-ink-400">{a.breakdown}</p> : null}
                        </td>
                        <td className="max-w-[16rem] px-3 py-2.5">
                          <p className="truncate text-ink-800" title={e.subject}>{e.subject}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={typeTone(e.type)}>{TYPE_LABELS[e.type]}</Badge>
                          <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ink-400">{BODY_LABEL[e.bodyType]}</p>
                        </td>
                        <td className="px-3 py-2.5"><StatusBadge tone={emailStatusTone(e.status)}>{titleCase(e.status)}</StatusBadge></td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink-600">{formatDateTime(e.sentAt)}</td>
                        <td className="px-3 py-2.5">
                          <code className="block max-w-[9rem] truncate rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600" title={e.resendId}>{e.resendId}</code>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => openComposer(e.id)}
                            className="whitespace-nowrap text-xs font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline"
                          >
                            Copy as new
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: compact card list — no wide table, no page-wide scrolling. */}
            <ul className="divide-y divide-ink-100 md:hidden">
              {emails.map((e: EmailMessage) => {
                const a = audienceSummary(e.to, e.cc, e.bcc)
                return (
                  <li key={e.id} className="space-y-1.5 px-4 py-3">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink-800" title={e.subject}>{e.subject}</p>
                      <StatusBadge tone={emailStatusTone(e.status)}>{titleCase(e.status)}</StatusBadge>
                    </div>
                    <p className="text-xs font-medium text-ink-700">{a.label}</p>
                    {a.breakdown ? <p className="text-[11px] text-ink-400">{a.breakdown}</p> : null}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone={typeTone(e.type)}>{TYPE_LABELS[e.type]}</Badge>
                      <span className="text-[10px] uppercase tracking-wide text-ink-400">{BODY_LABEL[e.bodyType]}</span>
                      <span className="text-[11px] text-ink-500">{formatDateTime(e.sentAt)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <code className="min-w-0 truncate rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-600" title={e.resendId}>{e.resendId}</code>
                      <button
                        type="button"
                        onClick={() => openComposer(e.id)}
                        className="shrink-0 text-xs font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline"
                      >
                        Copy as new
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Card>

      <EmailComposer open={composerOpen} copyId={copySource} onClose={() => setComposerOpen(false)} onSent={() => listQ.refetch()} />
    </div>
  )
}

/* ------------------------------- Composer -------------------------------- */

export function EmailComposer({ open, copyId, onClose, onSent }: { open: boolean; copyId: string | null; onClose: () => void; onSent: () => void }) {
  const { showToast } = useToast()
  const [from, setFrom] = useState(DEFAULT_FROM)
  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [bcc, setBcc] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [bodyType, setBodyType] = useState<EmailBodyType>('text')
  const [previewing, setPreviewing] = useState(false)
  const [type, setType] = useState<EmailType>('update')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const [audienceCount, setAudienceCount] = useState<number | null>(null)
  const [loadingAudience, setLoadingAudience] = useState(false)

  // Send is allowed when ANY of To / CC / BCC has recipients — rejected only
  // when all three are empty (mirrors the server-side rule).
  const recipientsInvalid = to.length === 0 && cc.length === 0 && bcc.length === 0
  const subjectInvalid = subject.trim().length === 0
  const messageInvalid = message.trim().length === 0

  /* -------------------- Copy as new email (spec section 19) ------------------ */
  /* Prefills a NEW composition from a past email — including its body mode.
     It must never auto-send. */
  useEffect(() => {
    if (!open || !copyId) return
    let cancelled = false
    emailsService
      .copyBody(copyId)
      .then((body) => {
        if (cancelled) return
        setTo(body.to ?? [])
        setCc(body.cc ?? [])
        setBcc(body.bcc ?? [])
        setSubject(body.subject ? `[Copy] ${body.subject}` : '')
        setMessage(body.message ?? '')
        setBodyType(body.bodyType ?? 'text')
        setPreviewing(false)
      })
      .catch(() => showToast('error', 'Could not load the original email for copying.'))
    return () => {
      cancelled = true
    }
  }, [open, copyId, showToast])

  /* --------------- Bulk recipient selection (spec section 18) --------------- */
  const loadAudience = async (): Promise<void> => {
    setLoadingAudience(true)
    try {
      const { count, recipients } = await emailsService.audience('all')
      setAudienceCount(count)
      setTo(recipients)
    } catch {
      showToast('error', 'Could not load the recipient audience.')
    } finally {
      setLoadingAudience(false)
    }
  }

  const reset = (): void => {
    setTo([]); setCc([]); setBcc([]); setSubject(''); setMessage('')
    setBodyType('text'); setPreviewing(false)
    setSendError(null); setAudienceCount(null)
  }

  const handleSend = async (): Promise<void> => {
    setSendError(null)
    setSending(true)
    try {
      // Request goes to the dashboard backend, which performs the Resend send.
      // bodyType travels with it so the body lands in exactly one provider field.
      await emailsService.send({ from, to, cc, bcc, subject: subject.trim(), message, bodyType, type })
      showToast('success', 'Email sent successfully.')
      reset()
      onSent()
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send email'
      setSendError(msg)
      showToast('error', msg)
    } finally {
      setSending(false)
    }
  }

  const canSend = !recipientsInvalid && !subjectInvalid && !messageInvalid && !sending

  const switchMode = (mode: EmailBodyType): void => {
    setBodyType(mode)
    setPreviewing(false)
  }

  return (
    <Modal open={open} onClose={onClose} title="Compose email" description="Sent through the dashboard backend via Resend. The browser never touches Resend directly." width="lg">
      <div className="space-y-4">
        <Field label="From" hint="Fixed sender identity">
          <Input value={from} onChange={(e) => setFrom(e.target.value)} disabled readOnly />
        </Field>
        <Field
          label="To"
          hint="Press Enter after each address"
          error={recipientsInvalid && sendError !== null ? 'Add at least one recipient to To, CC, or BCC' : null}
        >
          <div className="space-y-1.5">
            <TokenInput value={to} onChange={setTo} placeholder="recipient@example.com" ariaLabel="To recipients" />
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => void loadAudience()}
                disabled={loadingAudience}
                className="text-xs font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline disabled:opacity-50"
              >
                {loadingAudience ? 'Loading audience…' : 'Select all recipients'}
              </button>
              {audienceCount !== null ? (
                <span className="text-[11px] text-ink-400">{audienceCount} account emails filled</span>
              ) : null}
            </div>
          </div>
        </Field>
        <Field label="Type" hint="Category shown in history and audit log">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as EmailType)}
            className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-400 focus:outline-none focus:ring-2 focus:ring-ink-200"
          >
            {(Object.keys(TYPE_LABELS) as EmailType[]).map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
        </Field>
        <Field label="CC" hint="Optional — CC-only sends are supported">
          <TokenInput value={cc} onChange={setCc} placeholder="cc@example.com" ariaLabel="CC recipients" />
        </Field>
        <Field label="BCC" hint="Optional — BCC-only sends are supported">
          <TokenInput value={bcc} onChange={setBcc} placeholder="bcc@example.com" ariaLabel="BCC recipients" />
        </Field>
        <Field label="Subject" error={subjectInvalid && sendError !== null ? 'Subject is required' : null}>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        </Field>

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-md border border-ink-200 p-0.5" role="group" aria-label="Message format">
              <button
                type="button"
                onClick={() => switchMode('text')}
                aria-pressed={bodyType === 'text'}
                className={clsx(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300',
                  bodyType === 'text' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:text-ink-900',
                )}
              >
                Plain Text
              </button>
              <button
                type="button"
                onClick={() => switchMode('html')}
                aria-pressed={bodyType === 'html'}
                className={clsx(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300',
                  bodyType === 'html' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:text-ink-900',
                )}
              >
                HTML
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPreviewing((p) => !p)}
              aria-pressed={previewing}
              disabled={messageInvalid}
              className="text-xs font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline disabled:opacity-40"
            >
              {previewing ? 'Edit' : 'Preview'}
            </button>
          </div>

          <Field
            label="Message"
            hint={bodyType === 'html' ? 'Sent as HTML — a fragment like <p>Hello</p> is enough' : 'Sent as plain text — tags stay literal'}
            error={messageInvalid && sendError !== null ? 'Message is required' : null}
          >
            {previewing ? (
              bodyType === 'html' ? (
                <iframe
                  title="HTML preview"
                  sandbox=""
                  srcDoc={previewDocument(message)}
                  className="min-h-40 w-full rounded-md border border-ink-200 bg-white"
                />
              ) : (
                <pre className="max-h-80 min-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-ink-200 bg-ink-50 p-3 font-mono text-[13px] leading-relaxed text-ink-800">
                  {message}
                </pre>
              )
            ) : (
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={bodyType === 'html' ? '<p>Hello, …</p>' : 'Hello,\n\nThis is a product update.\n\nThanks,\nRayern'}
                className="min-h-40"
              />
            )}
          </Field>
        </div>

        {sendError ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{sendError}</div>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-ink-200 pt-4">
          <Button variant="ghost" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSend()} disabled={!canSend}>
            {sending ? (
              <>
                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" /><path d="M21 12a9 9 0 01-9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
                Sending…
              </>
            ) : (
              'Send email'
            )}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
