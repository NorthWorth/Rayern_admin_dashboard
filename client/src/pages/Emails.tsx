import { useState, useEffect } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Field, Input, Textarea } from '../components/ui/Input'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { VolumeBarChart } from '../components/charts'
import { Collapser } from '../components/Collapser'
import { useToast } from '../components/ui/Toast'
import { useQuery } from '../hooks/useQuery'
import { emailsService } from '../services/emails'
import { DEFAULT_FROM } from '../lib/api'
import { formatDateTime, formatNumber, formatPct, titleCase } from '../lib/utils'
import type { EmailBodyType, EmailMessage, EmailUsageWindow, EmailType } from '../lib/types'

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

/** Compact audience summary for a single message's To/CC/BCC recipients. */
function audienceSummary(to: string[], cc: string[], bcc: string[]): { label: string; breakdown?: string } {
  const total = to.length + cc.length + bcc.length
  if (total === 0) return { label: 'No recipients' }
  const parts: string[] = []
  if (to.length) parts.push(`To: ${to.length}`)
  if (cc.length) parts.push(`CC: ${cc.length}`)
  if (bcc.length) parts.push(`BCC: ${bcc.length}`)
  const label = parts.join(' · ')
  const breakdown = parts.length > 1 ? `Total recipients: ${total}` : undefined
  return { label, breakdown }
}

/**\n * Compact quota window (spec §8/§9/§13): `used / limit`, remaining, % used —\n * straight from persisted backend accounting. Amber/red as the quota fills.\n */\nfunction UsageWindow({ label, w }: { label: string; w: EmailUsageWindow }) {\n  const pct = w.usedPct ?? 0\n  const tone = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-accent'\n  return (\n    <div className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-ink-50/60 p-3">\n      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</p>\n      <p className="mt-1 text-lg font-semibold tabular-nums text-ink-900">\n        {formatNumber(w.used)}\n        <span className="text-sm font-normal text-ink-500"> / {formatNumber(w.limit)}</span>\n      </p>\n      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink-200" role="presentation">\n        <div\n          className={`h-full rounded-full transition-all ${tone}`}\n          style={{ width: `${Math.min(100, pct)}%` }}\n        />\n      </div>\n      <p className="mt-1.5 text-[11px] text-ink-600">\n        {formatNumber(w.remaining)} remaining\n        {w.usedPct !== null ? ` · ${formatPct(w.usedPct, 1)} used` : ''}\n      </p>\n    </div>\n  )\n}

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
  const usageQ = useQuery(() => emailsService.usage())
  const [composerOpen, setComposerOpen] = useState(false)
  const [copySource, setCopySource] = useState<string | null>(null)

  const emails = listQ.data ?? []
  const usage = usageQ.data

  const openComposer = (copyId: string | null = null): void => {
    setCopySource(copyId)
    setComposerOpen(true)
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="grid flex-1 grid-cols-2 gap-3 lg:grid-cols-5">
          <KpiCard label="Sent (30d)" value={statsQ.data ? formatNumber(statsQ.data.totalSent) : '—'} />
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

      {/* ------------------------- Resend usage / quota ------------------------ */}
      <Card>
        <CardHeader
          title="Email usage"
          subtitle="Individual messages accepted by the provider — counted per recipient, never per batch or request"
        />
        <CardBody>
          {usageQ.loading ? (
            <LoadingBlock rows={2} />
          ) : usageQ.error ? (
            <ErrorState message={usageQ.error} onRetry={usageQ.refetch} />
          ) : usage ? (
            <div className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <UsageWindow label="This month" w={usage.month} />
                <UsageWindow label="Today" w={usage.day} />
              </div>
              <p className="text-[11px] text-ink-400">
                Limits: {formatNumber(usage.limits.monthly)}/month · {formatNumber(usage.limits.daily)}/day
                {usage.lastReconciledAt ? ` · last reconciled ${usage.lastReconciledAt.slice(0, 16).replace('T', ' ')}` : ''}
              </p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Email history"
            subtitle="Every admin-sent message persisted by the dashboard backend"
            actions={<button type="button" onClick={() => openComposer()} className="text-xs font-medium text-emerald-700 hover:text-emerald-800">Compose →</button>}
          />
          {listQ.loading ? (
            <CardBody><LoadingBlock rows={5} /></CardBody>
          ) : listQ.error ? (
            <ErrorState message={listQ.error} onRetry={listQ.refetch} />
          ) : emails.length === 0 ? (
            <CardBody><EmptyState title="No emails yet" description="Admin-sent messages will appear here once the dashboard sends its first email." /></CardBody>
          ) : (
            <Collapser total={emails.length} label="emails">
              {(visibleCount) => (
            <div className="space-y-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                      <th scope="col" className="px-4 py-2.5">Recipient summary</th>
                      <th scope="col" className="px-3 py-2.5">Subject</th>
                      <th scope="col" className="px-3 py-2.5">Type</th>
                      <th scope="col" className="px-3 py-2.5">Status</th>
                      <th scope="col" className="px-3 py-2.5">Sent</th>
                      <th scope="col" className="px-3 py-2.5">Resend ID</th>
                      <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {emails.slice(0, visibleCount).map((e: EmailMessage) => {
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
                {emails.slice(0, visibleCount).map((e: EmailMessage) => {
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
            </div>
              )}
            </Collapser>
          )}
        </Card>

        <Card>
          <CardHeader title="Delivery summary" subtitle="Aggregate delivery by type — counts only, never recipients" />
          <CardBody>
            {statsQ.loading ? (
              <LoadingBlock rows={4} />
            ) : statsQ.error ? (
              <ErrorState message={statsQ.error} onRetry={statsQ.refetch} />
            ) : statsQ.data ? (
              <div className="space-y-3">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <Statistic label="Total sent" value={formatNumber(statsQ.data.totalSent)} />
                  <Statistic label="Delivered" value={formatNumber(statsQ.data.delivered)} tone="green" />
                  <Statistic label="Failed" value={formatNumber(statsQ.data.failed)} tone="red" />
                  <Statistic label="Bounced" value={formatNumber(statsQ.data.bounced)} tone="amber" />
                </dl>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                      <th scope="col" className="px-4 py-2.5">Type</th>
                      <th scope="col" className="px-3 py-2.5 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statsQ.data.byType.map((t) => (
                      <tr key={t.type} className="border-b border-ink-100 last:border-0">
                        <td className="px-4 py-2.5"><Badge tone={typeTone(t.type)}>{TYPE_LABELS[t.type]}</Badge></td>
                        <td className="px-3 py-2.5 text-right text-ink-700 tabular-nums">{formatNumber(t.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Daily volume" subtitle="Sent and failed per day over the last 30 days" />
        <CardBody>
          {statsQ.loading ? (
            <LoadingBlock rows={5} />
          ) : statsQ.error ? (
            <ErrorState message={statsQ.error} onRetry={statsQ.refetch} />
          ) : statsQ.data && statsQ.data.daily.length > 0 ? (
            <VolumeBarChart
              data={statsQ.data.daily.map((d) => ({ time: d.date.slice(5, 10), count: d.sent, errors: d.failed }))}
              xKey="time"
              series={[
                { key: 'count', name: 'Sent', color: '#1f6f54' },
                { key: 'errors', name: 'Failed', color: '#d64545' },
              ]}
            />
          ) : (
            <EmptyState title="No daily data" description="Daily volume will appear once enough emails have been sent." />
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function Statistic({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'red' | 'amber' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md border border-ink-100 bg-ink-50/60 px-3 py-2">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tone && `text-${tone}-700`}`}>{value}</dd>
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
  const valid = !recipientsInvalid && !subjectInvalid

  useEffect(() => {
    if (!open) return
    if (copyId) {
      emailsService.copyBody(copyId).then((body) => {
        setFrom(body.from ?? DEFAULT_FROM)
        setTo(body.to ?? [])
        setCc(body.cc ?? [])
        setBcc(body.bcc ?? [])
        setSubject(body.subject ?? '')
        setMessage(body.message ?? '')
        setBodyType(body.bodyType ?? 'text')
      }).catch(() => setSendError('Could not load the copied email'))
    }
  }, [open, copyId])

  const canSend = valid && !sending
  const typeDisabled = sending || !canSend

  return (
    <Modal open={open} onClose={onClose} title="Compose email" footer={
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-500">{audienceCount !== null ? `Live audience: ${audienceCount} active opted-in accounts` : 'Calculating audience…'}</p>
        <div className="flex items-center gap-2">
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button onClick={() => send()} disabled={!canSend} type="primary">
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    }>
      {sendError ? (
        <div className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm text-red-700">{sendError}</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="From">
              <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="you@rayern.com.ng" />
            </Field>
            <Field label="Type">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as EmailType)}
                disabled={typeDisabled}
                className="rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-800 focus:border-ink-400 focus:outline-none focus:ring-2 focus:ring-ink-200"
              >
                <option value="update">Product update</option>
                <option value="announcement">Announcement</option>
                <option value="promotion">Promotional</option>
                <option value="notice">Important notice</option>
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-4">
            <Field label="To" grow>
              <Input
                value={to.join(', ')}
                onChange={(e) => setTo(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                placeholder="one@rayern.com.ng, two@rayern.com.ng"
              />
            </Field>
            <Field label="CC" grow>
              <Input
                value={cc.join(', ')}
                onChange={(e) => setCc(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                placeholder="cc@rayern.com.ng"
              />
            </Field>
            <Field label="BCC" grow>
              <Input
                value={bcc.join(', ')}
                onChange={(e) => setBcc(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                placeholder="bcc@rayern.com.ng"
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-4">
            <Field label="Subject" grow>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What's this about?" />
            </Field>
            <Field label="Body type">
              <div className="flex rounded-md border border-ink-200 p-0.5" role="group" aria-label="Body type">
                <button
                  type="button"
                  role="radio"
                  aria-checked={bodyType === 'text'}
                  onClick={() => setBodyType('text')}
                  disabled={sending}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300 ${
                    bodyType === 'text' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:text-ink-900'
                  }`}
                >
                  Plain text
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={bodyType === 'html'}
                  onClick={() => setBodyType('html')}
                  disabled={sending}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300 ${
                    bodyType === 'html' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:text-ink-900'
                  }`}
                >
                  HTML
                </button>
              </div>
            </Field>
          </div>

          <Field label={`Message (${bodyType === 'html' ? 'HTML' : 'plain text'})`} grow className="!pt-0">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={10}
              placeholder={bodyType === 'html' ? '<html>…</html>' : 'Write your message here…'}
            />
          </Field>

          {message && bodyType === 'html' && (
            <div className="rounded-lg border border-ink-200">
              <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-3 py-2">
                <span className="text-xs font-medium text-ink-600">HTML preview</span>
                <button
                  type="button"
                  onClick={() => setPreviewing((p) => !p)}
                  className="text-xs font-medium text-ink-500 hover:text-ink-800"
                >
                  {previewing ? 'Hide' : 'Preview'}
                </button>
              </div>
              {previewing && (
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={previewDocument(message)}
                  className="h-[240px] w-full"
                />
              )}
            </div>
          )}

          <p className="text-xs text-ink-500">
            This will send from <code className="rounded bg-ink-100 px-1 text-xs">{DEFAULT_FROM}</code> to {to.length + cc.length + bcc.length} recipient{to.length + cc.length + bcc.length === 1 ? '' : 's'}.
            The backend is the authoritative sender — the browser never touches Resend.
          </p>
        </div>
      )}
    </Modal>
  )

  async function send() {
    setSendError(null)
    setSending(true)
    try {
      const sent = await emailsService.send({ from, to, cc, bcc, subject, message, bodyType, type })
      onSent()
      setComposerOpen(false)
      showToast({ message: `Sent ${sent.resendId}`, variant: 'success' })
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }
}
