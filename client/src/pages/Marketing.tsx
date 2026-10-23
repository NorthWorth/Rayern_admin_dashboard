import { useEffect, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { Button } from '../components/ui/Button'
import { Field, Input, Select, Textarea } from '../components/ui/Input'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { SearchInput } from '../components/SearchInput'
import { Pagination } from '../components/Pagination'
import { useToast } from '../components/ui/Toast'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useQuery } from '../hooks/useQuery'
import { marketingService } from '../services/marketing'
import { clsx, formatDate, formatDateTime, formatNumber, initialsOf } from '../lib/utils'
import type {
  CampaignPreview,
  ConsentStatus,
  DirectoryEntry,
  EmailBodyType,
  EmailType,
  Paged,
} from '../lib/types'

const PAGE_SIZE = 12

const TYPE_LABELS: Record<EmailType, string> = {
  update: 'Product update',
  announcement: 'Announcement',
  promotion: 'Promotional',
  notice: 'Important notice',
}

/**
 * Browser-like document for the HTML preview. Rendered inside a fully
 * sandboxed iframe (sandbox="") — no script, forms, popups or navigation can
 * execute, so campaign HTML can never run JS in the dashboard.
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

function ConsentBadge({ consent }: { consent: ConsentStatus }) {
  if (consent === 'opted_in') return <StatusBadge tone="green">Opted in</StatusBadge>
  if (consent === 'opted_out') return <StatusBadge tone="red">Opted out</StatusBadge>
  return <Badge tone="neutral">Unknown</Badge>
}

/**
 * Marketing: consent-gated campaign operations.
 *
 * Consent is opt-in only — accounts without an explicit opt-in are never
 * mailable, and the audience is resolved server-side on every send. The
 * campaign body goes through the dashboard backend (sanitization + delivery);
 * the browser never talks to Resend and never chooses recipients.
 */
export function MarketingPage() {
  const { showToast } = useToast()

  const [search, setSearch] = useState('')
  const [consentFilter, setConsentFilter] = useState<ConsentStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search)

  const [pendingConsentId, setPendingConsentId] = useState<string | null>(null)

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, consentFilter])

  const metricsQ = useQuery(() => marketingService.metrics())
  const listQ = useQuery(
    () => marketingService.directory({ search: debouncedSearch, consent: consentFilter, page, pageSize: PAGE_SIZE }),
    [debouncedSearch, consentFilter, page],
  )

  const metrics = metricsQ.data
  const data: Paged<DirectoryEntry> | null = listQ.data

  const handleConsent = async (accountId: string, status: ConsentStatus): Promise<void> => {
    setPendingConsentId(accountId)
    try {
      await marketingService.setConsent(accountId, status)
      showToast('success', `Consent updated to ${status.replace('_', ' ')}.`)
      listQ.refetch()
      metricsQ.refetch()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to update consent.')
    } finally {
      setPendingConsentId(null)
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard
          label="Opted in"
          value={metrics ? formatNumber(metrics.consent.optedIn) : '—'}
          tone="green"
        />
        <KpiCard
          label="Opted out"
          value={metrics ? formatNumber(metrics.consent.optedOut) : '—'}
          tone="red"
        />
        <KpiCard label="Unknown" value={metrics ? formatNumber(metrics.consent.unknown) : '—'} sub="no consent on record" />
        <KpiCard
          label="Mailable"
          value={metrics ? formatNumber(metrics.mailable) : '—'}
          sub="active + opted in"
        />
        <KpiCard
          label="Campaigns (30d)"
          value={metrics ? formatNumber(metrics.campaigns.sent30d) : '—'}
          sub={metrics && metrics.campaigns.recipients30d > 0 ? `${formatNumber(metrics.campaigns.recipients30d)} recipients` : 'none yet'}
        />
      </div>

      {metricsQ.error ? <ErrorState message={metricsQ.error} onRetry={metricsQ.refetch} /> : null}

      <CampaignComposer mailable={metrics?.mailable ?? 0} onSent={() => metricsQ.refetch()} />

      <Card>
        <CardHeader
          title="Consent directory"
          subtitle="Account-level marketing consent — workspace contents are never accessible. Accounts without an explicit opt-in are never mailable."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search name or email…" className="w-64" />
              <Select
                aria-label="Filter by consent"
                value={consentFilter}
                onChange={(e) => setConsentFilter(e.target.value as ConsentStatus | 'all')}
                className="w-40"
              >
                <option value="all">All consent</option>
                <option value="opted_in">Opted in</option>
                <option value="opted_out">Opted out</option>
                <option value="unknown">Unknown</option>
              </Select>
            </div>
          }
        />
        {listQ.loading ? (
          <CardBody>
            <LoadingBlock rows={8} />
          </CardBody>
        ) : listQ.error ? (
          <ErrorState message={listQ.error} onRetry={listQ.refetch} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No accounts found" description="Try adjusting your search or consent filter." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Account</th>
                    <th scope="col" className="px-3 py-2.5">Account status</th>
                    <th scope="col" className="px-3 py-2.5">Consent</th>
                    <th scope="col" className="px-3 py-2.5">Consent updated</th>
                    <th scope="col" className="px-3 py-2.5">Record decision</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((d) => (
                    <tr key={d.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">
                            {initialsOf(d.name)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink-900">{d.name}</p>
                            <p className="truncate text-xs text-ink-500">{d.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {d.status === 'active' ? (
                          <StatusBadge tone="green">Active</StatusBadge>
                        ) : d.status === 'suspended' ? (
                          <Badge tone="amber">Suspended</Badge>
                        ) : (
                          <Badge tone="neutral">Closed</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <ConsentBadge consent={d.consent} />
                      </td>
                      <td className="px-3 py-2.5 text-ink-600">
                        {d.consentUpdatedAt ? formatDate(d.consentUpdatedAt) : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <Select
                          aria-label={`Consent decision for ${d.email}`}
                          value={d.consent}
                          disabled={pendingConsentId === d.id}
                          onChange={(e) => void handleConsent(d.id, e.target.value as ConsentStatus)}
                          className="w-36"
                        >
                          <option value="opted_in">Opted in</option>
                          <option value="opted_out">Opted out</option>
                          <option value="unknown">Unknown</option>
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
          </>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent campaigns" subtitle="Consent-gated sends — audience counts only, never recipient lists" />
        {metricsQ.loading ? (
          <CardBody>
            <LoadingBlock rows={3} />
          </CardBody>
        ) : !metrics || metrics.recentCampaigns.length === 0 ? (
          <EmptyState title="No campaigns yet" description="Preview and send your first campaign above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-4 py-2.5">Campaign</th>
                  <th scope="col" className="px-3 py-2.5">Audience</th>
                  <th scope="col" className="px-3 py-2.5">Provider messages</th>
                  <th scope="col" className="px-3 py-2.5">Status</th>
                  <th scope="col" className="px-3 py-2.5">Sent</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recentCampaigns.map((c) => (
                  <tr key={c.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                    <td className="px-4 py-2.5">
                      <p className="truncate font-medium text-ink-900">{c.subject}</p>
                      <p className="text-[10px] uppercase tracking-wide text-ink-400">
                        {TYPE_LABELS[c.type] ?? c.type} · {c.bodyType === 'html' ? 'HTML' : 'Plain Text'}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 text-ink-700">{formatNumber(c.audienceCount)} recipients</td>
                    <td className="px-3 py-2.5 text-ink-700">{formatNumber(c.providerMessages)}</td>
                    <td className="px-3 py-2.5">
                      {c.status === 'sent' ? <StatusBadge tone="green">Sent</StatusBadge> : <Badge tone="amber">Queued</Badge>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-600">
                      {formatDateTime(c.sentAt)}
                      <span className="block text-[11px] text-ink-400">by {c.sentBy}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

/* ------------------------------ Campaign composer ------------------------- */

/**
 * Compose → server preview (sanitized body + live audience counts) → send.
 * The audience is always resolved server-side from consented accounts; the
 * composer only carries subject, body, mode and type.
 */
function CampaignComposer({ mailable, onSent }: { mailable: number; onSent: () => void }) {
  const { showToast } = useToast()
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [bodyType, setBodyType] = useState<EmailBodyType>('text')
  const [type, setType] = useState<EmailType>('announcement')
  const [localPreview, setLocalPreview] = useState(false)
  const [preview, setPreview] = useState<CampaignPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const subjectInvalid = subject.trim().length === 0
  const messageInvalid = message.trim().length === 0

  const reset = (): void => {
    setSubject('')
    setMessage('')
    setBodyType('text')
    setLocalPreview(false)
    setPreview(null)
    setSendError(null)
  }

  const switchMode = (mode: EmailBodyType): void => {
    setBodyType(mode)
    setLocalPreview(false)
    setPreview(null)
  }

  const handlePreview = async (): Promise<void> => {
    setPreviewing(true)
    setSendError(null)
    try {
      const result = await marketingService.previewCampaign({
        subject: subject.trim(),
        message,
        bodyType,
        type,
      })
      setPreview(result)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Preview failed.')
    } finally {
      setPreviewing(false)
    }
  }

  const handleSend = async (): Promise<void> => {
    setSendError(null)
    setSending(true)
    try {
      const result = await marketingService.sendCampaign({
        subject: subject.trim(),
        message,
        bodyType,
        type,
      })
      showToast(
        'success',
        `Campaign sent to ${formatNumber(result.audienceCount)} recipient${
          result.audienceCount === 1 ? '' : 's'
        } (${formatNumber(result.delivery.providerMessages)} provider messages).`,
      )
      reset()
      onSent()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send campaign'
      setSendError(msg)
      showToast('error', msg)
    } finally {
      setSending(false)
    }
  }

  const canSend = !subjectInvalid && !messageInvalid && !sending && mailable > 0

  return (
    <Card>
      <CardHeader
        title="Campaign composer"
        subtitle="Sent through the dashboard backend to opted-in accounts only — each recipient receives an individual message"
      />
      <CardBody>
        <div className="grid gap-6 lg:grid-cols-2">
          {/* ------------------------------ Compose ------------------------------ */}
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Subject" error={subjectInvalid && sendError !== null ? 'Subject is required' : null}>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
              </Field>
              <Field label="Type" hint="Category shown in history and audit log">
                <Select value={type} onChange={(e) => setType(e.target.value as EmailType)} aria-label="Campaign type">
                  {(Object.keys(TYPE_LABELS) as EmailType[]).map((t) => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </Select>
              </Field>
            </div>

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
                onClick={() => setLocalPreview((p) => !p)}
                aria-pressed={localPreview}
                disabled={messageInvalid}
                className="text-xs font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline disabled:opacity-40"
              >
                {localPreview ? 'Edit' : 'Local preview'}
              </button>
            </div>

            <Field
              label="Message"
              hint={bodyType === 'html' ? 'Sent as HTML — a fragment like <p>Hello</p> is enough' : 'Sent as plain text — tags stay literal'}
              error={messageInvalid && sendError !== null ? 'Message is required' : null}
            >
              {localPreview ? (
                bodyType === 'html' ? (
                  <iframe
                    title="Local HTML preview"
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

            {sendError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{sendError}</div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 pt-4">
              <p className="text-xs text-ink-500">
                {mailable > 0 ? (
                  <>
                    Audience: <span className="font-semibold text-ink-800">{formatNumber(mailable)} mailable</span> —
                    opted-out and unknown accounts are excluded server-side
                  </>
                ) : (
                  'No mailable audience — record at least one opted-in account in the consent directory'
                )}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => void handlePreview()} disabled={messageInvalid || subjectInvalid || previewing}>
                  {previewing ? 'Previewing…' : 'Preview campaign'}
                </Button>
                <Button variant="primary" onClick={() => void handleSend()} disabled={!canSend}>
                  {sending ? 'Sending…' : 'Send campaign'}
                </Button>
              </div>
            </div>
          </div>

          {/* ------------------------------- Preview ------------------------------ */}
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              Server preview (sanitized)
            </p>
            {preview === null ? (
              <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-ink-200 bg-ink-50/50 p-6 text-center text-xs text-ink-400">
                Run “Preview campaign” to see the sanitized body the backend would send and the live consent-gated audience counts.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-lg border border-ink-200 bg-ink-50/60 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Audience</p>
                  <div className="mt-1.5 flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-700">
                      {formatNumber(preview.audience.mailable)} mailable
                    </span>
                    <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 font-medium text-red-700">
                      {formatNumber(preview.audience.optedOut)} opted out (excluded)
                    </span>
                    <span className="rounded-full border border-ink-200 bg-white px-2.5 py-0.5 font-medium text-ink-600">
                      {formatNumber(preview.audience.unknown)} unknown (excluded)
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-ink-500">From: {preview.from}</p>
                </div>
                <div className="rounded-md border border-ink-200 bg-white">
                  <div className="border-b border-ink-100 px-3 py-2">
                    <p className="truncate text-sm font-semibold text-ink-900">{preview.subject}</p>
                    <p className="text-[10px] uppercase tracking-wide text-ink-400">
                      {TYPE_LABELS[preview.type] ?? preview.type} · {preview.bodyType === 'html' ? 'HTML' : 'Plain Text'}
                    </p>
                  </div>
                  {preview.bodyType === 'html' ? (
                    <iframe
                      title="Server-sanitized campaign preview"
                      sandbox=""
                      srcDoc={previewDocument(preview.body)}
                      className="min-h-48 w-full"
                    />
                  ) : (
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-[13px] leading-relaxed text-ink-800">
                      {preview.body}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
