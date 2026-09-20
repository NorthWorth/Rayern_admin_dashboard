import { useState } from 'react'
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

  const emails = listQ.data ?? []

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
            <Button variant="primary" onClick={() => setComposerOpen(true)}>
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
                </tr>
              </thead>
              <tbody>
                {emails.map((e) => (
                  <tr key={e.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <EmailComposer open={composerOpen} onClose={() => setComposerOpen(false)} onSent={() => listQ.refetch()} />
    </div>
  )
}

/* ------------------------------- Composer -------------------------------- */

export function EmailComposer({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: () => void }) {
  const { showToast } = useToast()
  const [from, setFrom] = useState(DEFAULT_FROM)
  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [bcc, setBcc] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const toInvalid = to.length === 0
  const subjectInvalid = subject.trim().length === 0
  const messageInvalid = message.trim().length === 0

  const reset = (): void => {
    setTo([]); setCc([]); setBcc([]); setSubject(''); setMessage(''); setSendError(null)
  }

  const handleSend = async (): Promise<void> => {
    setSendError(null)
    setSending(true)
    try {
      // Request goes to the dashboard backend, which performs the Resend send.
      await emailsService.send({ from, to, cc, bcc, subject: subject.trim(), message })
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
        <Field label="To" hint="Press Enter after each address" error={toInvalid && sendError !== null ? 'At least one recipient is required' : null}>
          <TokenInput value={to} onChange={setTo} placeholder="recipient@example.com" ariaLabel="To recipients" />
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
