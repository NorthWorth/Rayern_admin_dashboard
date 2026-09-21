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
import { formatDateTime, formatNumber, titleCase } from '../lib/utils'
import type { EmailType } from '../lib/types'

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
    <div className="mx-auto max-w-7xl space-y-6 p-6">
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
          subtitle="Metadata only — content is not displayed here"
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-4 py-2.5">Recipient</th>
                  <th scope="col" className="px-3 py-2.5">CC / BCC</th>
                  <th scope="col" className="px-3 py-2.5">Subject</th>
                  <th scope="col" className="px-3 py-2.5">Type</th>
                  <th scope="col" className="px-3 py-2.5">Status</th>
                  <th scope="col" className="px-3 py-2.5">Sent</th>
                  <th scope="col" className="px-3 py-2.5">Message ID</th>
                  <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {emails.map((e) => (
                  <tr key={e.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70 group">
                    <td className="px-4 py-2.5">
                      <p className="truncate font-medium text-ink-800" title={e.to.join(', ')}>{e.to.join(', ')}</p>
                    </td>
                    <td className="px-3 py-2.5 text-ink-600">
                      {[...e.cc, ...e.bcc].length ? [...e.cc, ...e.bcc].join(', ') : <span className="text-ink-400">—</span>}
                    </td>
                    <td className="max-w-[16rem] px-3 py-2.5"><p className="truncate text-ink-800">{e.subject}</p></td>
                    <td className="px-3 py-2.5"><Badge tone={typeTone(e.type)}>{TYPE_LABELS[e.type]}</Badge></td>
                    <td className="px-3 py-2.5"><StatusBadge tone={emailStatusTone(e.status)}>{titleCase(e.status)}</StatusBadge></td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-600">{formatDateTime(e.sentAt)}</td>
                    <td className="px-3 py-2.5"><code className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">{e.resendId}</code></td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => openComposer(e.id)}
                        className="text-xs font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline"
                      >
                        Copy as new
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  const [type, setType] = useState<EmailType>('update')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const [audienceCount, setAudienceCount] = useState<number | null>(null)
  const [loadingAudience, setLoadingAudience] = useState(false)

  const toInvalid = to.length === 0
  const subjectInvalid = subject.trim().length === 0
  const messageInvalid = message.trim().length === 0

  /* -------------------- Copy as new email (spec section 19) ------------------ */
  /* Prefills a NEW composition from a past email. It must never auto-send. */
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
    setTo([]); setCc([]); setBcc([]); setSubject(''); setMessage(''); setSendError(null); setAudienceCount(null)
  }

  const handleSend = async (): Promise<void> => {
    setSendError(null)
    setSending(true)
    try {
      // Request goes to the dashboard backend, which performs the Resend send.
      await emailsService.send({ from, to, cc, bcc, subject: subject.trim(), message, type })
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

  const canSend = !toInvalid && !subjectInvalid && !messageInvalid && !sending

  return (
    <Modal open={open} onClose={onClose} title="Compose email" description="Sent through the dashboard backend via Resend. The browser never touches Resend directly." width="lg">
      <div className="space-y-4">
        <Field label="From" hint="Fixed sender identity">
          <Input value={from} onChange={(e) => setFrom(e.target.value)} disabled readOnly />
        </Field>
        <Field
          label="To"
          hint="Press Enter after each address"
          error={toInvalid && sendError !== null ? 'At least one recipient is required' : null}
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
        <Field label="CC" hint="Optional">
          <TokenInput value={cc} onChange={setCc} placeholder="cc@example.com" ariaLabel="CC recipients" />
        </Field>
        <Field label="BCC" hint="Optional">
          <TokenInput value={bcc} onChange={setBcc} placeholder="bcc@example.com" ariaLabel="BCC recipients" />
        </Field>
        <Field label="Subject" error={subjectInvalid && sendError !== null ? 'Subject is required' : null}>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        </Field>
        <Field label="Message" hint="HTML allowed" error={messageInvalid && sendError !== null ? 'Message is required' : null}>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="<p>Hello, …</p>" className="min-h-40" />
        </Field>

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
