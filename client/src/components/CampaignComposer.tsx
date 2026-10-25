import { useMemo, useState } from 'react'
import { Card, CardBody, CardHeader } from './ui/Card'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import { Field, Input, Select, Textarea } from './ui/Input'
import { Badge } from './ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from './ui/states'
import { useToast } from './ui/Toast'
import { useQuery } from '../hooks/useQuery'
import { campaignsService } from '../services/campaigns'
import { emailsService } from '../services/emails'
import { DEFAULT_FROM } from '../lib/api'
import {
  RAYERN_PLANS,
  SKIP_REASON_LABELS,
  SUBSCRIPTION_STATUSES,
  type AdminUserFilters,
  type AdminUserRecord,
  type AdminUsersPage,
  type CampaignAudience,
  type CampaignPreviewResponse,
  type CampaignSendResponse,
  type ConsentFilter,
  type RayernPlan,
  type SubscriptionStatus,
} from '../lib/types'

/**
 * Email category. The category decides WHICH users may be selected and HOW the
 * send is delivered — promotional consent never bleeds into other categories:
 *
 *  - `promotional` — marketing email. Only accounts that opted in (and are
 *    active) are selectable, and Rayern revalidates consent again inside the
 *    send call, so this UI can never widen the audience.
 *  - `service_notice` — non-promotional, legally permitted service message.
 *    Consent is not required, recipients are chosen explicitly, and delivery
 *    goes through the dashboard's existing individual-recipient email pipeline.
 */
export type CampaignCategory = 'promotional' | 'service_notice'

type AudienceMode = 'all_eligible' | 'filters' | 'manual'

const CATEGORY_LABELS: Record<CampaignCategory, string> = {
  promotional: 'Promotional (marketing consent required)',
  service_notice: 'Service notice (non-promotional)',
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function consentOf(user: AdminUserRecord): boolean {
  return user.marketingConsent?.optedIn === true
}

function reasonLabel(reason: string): string {
  return SKIP_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ')
}

export function CampaignComposer({
  open,
  onClose,
  onSent,
}: {
  open: boolean
  onClose: () => void
  onSent?: () => void
}) {
  const { showToast } = useToast()

  const [category, setCategory] = useState<CampaignCategory>('promotional')
  const [mode, setMode] = useState<AudienceMode>('all_eligible')
  const [plan, setPlan] = useState<RayernPlan | 'all'>('all')
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | 'all'>('all')
  const [consent, setConsent] = useState<ConsentFilter | 'all'>('opted_in')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])

  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')

  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<CampaignPreviewResponse | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [result, setResult] = useState<CampaignSendResponse | null>(null)

  const [idempotencyKey] = useState(newIdempotencyKey)

  const promotional = category === 'promotional'
  // Promotional sends are consent-gated: the picker can only ever show and
  // select accounts that already opted in (Rayern re-checks at send time).
  const consentFilter: ConsentFilter | 'all' = promotional ? 'opted_in' : consent

  const filters: AdminUserFilters = useMemo(
    () => ({
      page,
      limit: 50,
      plan,
      subscriptionStatus,
      consent: consentFilter,
    }),
    [page, plan, subscriptionStatus, consentFilter],
  )

  const usersQ = useQuery<AdminUsersPage | null>(
    () => (open ? campaignsService.listUsers(filters) : Promise.resolve(null)),
    [open, page, plan, subscriptionStatus, consentFilter],
  )
  const users = usersQ.data?.users ?? []
  const pagination = usersQ.data?.pagination ?? null

  const audience: CampaignAudience | null = useMemo(() => {
    if (!promotional) {
      return selected.length > 0 ? { type: 'manual_emails', emails: selected } : null
    }
    if (mode === 'all_eligible') return { type: 'all_eligible' }
    if (mode === 'filters') {
      const selector: { type: 'filters'; plan?: RayernPlan; subscriptionStatus?: SubscriptionStatus } = {
        type: 'filters',
      }
      if (plan !== 'all') selector.plan = plan
      if (subscriptionStatus !== 'all') selector.subscriptionStatus = subscriptionStatus
      return selector
    }
    return selected.length > 0 ? { type: 'manual_emails', emails: selected } : null
  }, [promotional, mode, plan, subscriptionStatus, selected])

  const canPreview = audience !== null && !previewing
  const canSend = subject.trim().length > 0 && message.trim().length > 0 && audience !== null && !sending

  const toggleSelected = (email: string): void => {
    setSelected((prev) => (prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]))
  }

  const handleCategoryChange = (next: CampaignCategory): void => {
    setCategory(next)
    setPreview(null)
    setPreviewError(null)
    setResult(null)
    setSendError(null)
    if (next === 'promotional') setConsent('opted_in')
    if (next === 'service_notice') setMode('manual')
    if (next === 'promotional') setMode('all_eligible')
  }

  const handlePreview = async (): Promise<void> => {
    if (!audience) return
    setPreviewing(true)
    setPreviewError(null)
    setPreview(null)
    try {
      const response = await campaignsService.preview(audience)
      setPreview(response)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Audience preview failed')
    } finally {
      setPreviewing(false)
    }
  }

  const reset = (): void => {
    setSelected([])
    setSubject('')
    setMessage('')
    setPreview(null)
    setPreviewError(null)
    setSendError(null)
    setResult(null)
  }

  const handleSend = async (): Promise<void> => {
    if (!audience) return
    setSending(true)
    setSendError(null)
    try {
      if (promotional) {
        // Promotional campaign → Rayern's campaign backend, which revalidates
        // consent server-side and reports every skipped recipient.
        const response = await campaignsService.send({
          subject: subject.trim(),
          bodyHtml: message,
          audience,
          idempotencyKey,
        })
        setResult(response)
        showToast(
          'success',
          `Campaign accepted for ${response.campaign.totals.accepted} recipient(s); ${response.campaign.totals.skipped} skipped.`,
        )
        onSent?.()
      } else {
        // Non-promotional service notice → the dashboard's existing individual
        // recipient pipeline (BCC-only expansion; nobody sees anybody else).
        await emailsService.send({
          from: DEFAULT_FROM,
          to: [],
          cc: [],
          bcc: selected,
          subject: subject.trim(),
          message,
          type: 'notice',
        })
        showToast('success', `Service notice queued for ${selected.length} recipient(s).`)
        reset()
        onSent?.()
        onClose()
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Send failed'
      setSendError(text)
      showToast('error', text)
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Campaign composer"
      description="Choose who receives this email, preview the audience, then send. Promotional sends are consent-gated server-side."
      width="xl"
    >
      <div className="space-y-4">
        <Field label="Email category" hint="Consent rules differ per category">
          <Select value={category} onChange={(e) => handleCategoryChange(e.target.value as CampaignCategory)} aria-label="Email category">
            <option value="promotional">{CATEGORY_LABELS.promotional}</option>
            <option value="service_notice">{CATEGORY_LABELS.service_notice}</option>
          </Select>
        </Field>

        {/* --------------------------- Recipients --------------------------- */}
        <Card>
          <CardHeader
            title="Recipients"
            subtitle={
              promotional
                ? 'Promotional email reaches opted-in accounts only — the server revalidates consent at send time'
                : 'Non-promotional service notice — pick any account explicitly'
            }
          />
          <CardBody className="space-y-4">
            {promotional ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Audience selection</p>
                <div className="space-y-1.5">
                  {(
                    [
                      ['all_eligible', 'All eligible users (server resolves opt-ins)'],
                      ['filters', 'Filtered segment (plan / subscription status)'],
                      ['manual', 'Choose individuals'],
                    ] as Array<[AudienceMode, string]>
                  ).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2 text-sm text-ink-700">
                      <input
                        type="radio"
                        name="audience-mode"
                        value={value}
                        checked={mode === value}
                        onChange={() => {
                          setMode(value)
                          setPreview(null)
                          setPreviewError(null)
                        }}
                        className="h-4 w-4 border-ink-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-600">
                Select the accounts that should receive this non-promotional notice
                {selected.length > 0 ? ` — ${selected.length} selected.` : '.'}
              </p>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Plan">
                <Select
                  value={plan}
                  onChange={(e) => {
                    setPlan(e.target.value as RayernPlan | 'all')
                    setPage(1)
                    setPreview(null)
                  }}
                  aria-label="Filter by plan"
                >
                  <option value="all">All plans</option>
                  {RAYERN_PLANS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Subscription status">
                <Select
                  value={subscriptionStatus}
                  onChange={(e) => {
                    setSubscriptionStatus(e.target.value as SubscriptionStatus | 'all')
                    setPage(1)
                    setPreview(null)
                  }}
                  aria-label="Filter by subscription status"
                >
                  <option value="all">Any status</option>
                  {SUBSCRIPTION_STATUSES.map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Marketing consent"
                hint={promotional ? 'Locked to opted-in for promotional sends' : undefined}
              >
                <Select
                  value={consentFilter}
                  disabled={promotional}
                  onChange={(e) => {
                    setConsent(e.target.value as ConsentFilter | 'all')
                    setPage(1)
                    setPreview(null)
                  }}
                  aria-label="Filter by marketing consent"
                >
                  <option value="opted_in">Opted in</option>
                  <option value="opted_out">Not opted in / opted out</option>
                  <option value="all">Any consent state</option>
                </Select>
              </Field>
            </div>

            {usersQ.loading ? (
              <LoadingBlock rows={4} />
            ) : usersQ.error ? (
              <ErrorState message={usersQ.error} onRetry={() => usersQ.refetch()} />
            ) : users.length === 0 ? (
              <EmptyState
                title="No matching users"
                description="No accounts match these filters. Widen the filters to see recipients."
              />
            ) : (
              <div className="overflow-x-auto rounded-md border border-ink-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                      <th scope="col" className="px-3 py-2"><span className="sr-only">Select</span></th>
                      <th scope="col" className="px-3 py-2.5">Email</th>
                      <th scope="col" className="px-3 py-2.5">Name</th>
                      <th scope="col" className="px-3 py-2.5">Plan</th>
                      <th scope="col" className="px-3 py-2.5">Subscription</th>
                      <th scope="col" className="px-3 py-2.5">Consent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => {
                      const opted = consentOf(user)
                      const selectable = !promotional || (opted && (user.accountStatus ?? 'active') === 'active')
                      return (
                        <tr key={user.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              aria-label={`Select ${user.email}`}
                              disabled={!selectable || mode !== 'manual'}
                              checked={selected.includes(user.email)}
                              onChange={() => toggleSelected(user.email)}
                              className="h-4 w-4 rounded border-ink-300 text-emerald-600 focus:ring-emerald-500 disabled:opacity-40"
                            />
                          </td>
                          <td className="px-3 py-2 font-medium text-ink-800">{user.email}</td>
                          <td className="px-3 py-2 text-ink-600">
                            {[user.firstName, user.lastName].filter(Boolean).join(' ') || '—'}
                          </td>
                          <td className="px-3 py-2">
                            <Badge tone={(user.subscription?.plan ?? 'starter') === 'starter' ? 'neutral' : 'blue'}>
                              {user.subscription?.plan ?? 'starter'}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-ink-600">
                            {(user.subscription?.status ?? 'none').replace(/_/g, ' ')}
                          </td>
                          <td className="px-3 py-2">
                            {opted ? (
                              <Badge tone="green">opted in</Badge>
                            ) : user.marketingConsent ? (
                              <Badge tone="red">opted out</Badge>
                            ) : (
                              <Badge tone="neutral">no consent</Badge>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-500">
              <span>
                {pagination
                  ? `${pagination.totalResults} matching user(s) · page ${pagination.page} of ${pagination.totalPages}`
                  : ''}
                {selected.length > 0 ? ` · ${selected.length} selected` : ''}
              </span>
              <span className="flex items-center gap-2">
                <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pagination === null || page >= pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </span>
            </div>
          </CardBody>
        </Card>

        {/* ---------------------------- Audience ---------------------------- */}
        <Card>
          <CardHeader
            title="Audience preview"
            subtitle={promotional ? 'Resolved and consent-checked by the server before anything is sent' : 'Recipients you selected'}
            actions={
              promotional ? (
                <Button variant="secondary" size="sm" onClick={() => void handlePreview()} disabled={!canPreview}>
                  {previewing ? 'Previewing…' : 'Preview audience'}
                </Button>
              ) : undefined
            }
          />
          <CardBody className="space-y-3">
            {!promotional ? (
              selected.length === 0 ? (
                <p className="text-sm text-ink-500">No recipients selected yet.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {selected.map((email) => (
                    <li key={email}>
                      <Badge tone="neutral">{email}</Badge>
                    </li>
                  ))}
                </ul>
              )
            ) : previewError ? (
              <ErrorState message={previewError} onRetry={() => void handlePreview()} />
            ) : preview ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-md border border-ink-200 bg-ink-50/60 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Eligible</p>
                    <p className="text-lg font-semibold text-ink-900">{preview.eligibleCount}</p>
                  </div>
                  <div className="rounded-md border border-ink-200 bg-ink-50/60 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Skipped</p>
                    <p className="text-lg font-semibold text-ink-900">{preview.skippedCount}</p>
                  </div>
                  <div className="rounded-md border border-ink-200 bg-ink-50/60 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Size cap</p>
                    <p className="text-lg font-semibold text-ink-900">{preview.sizeCap}</p>
                  </div>
                  <div className="rounded-md border border-ink-200 bg-ink-50/60 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Capped</p>
                    <p className="text-lg font-semibold text-ink-900">{preview.capped ? 'yes' : 'no'}</p>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Will receive</p>
                  {preview.preview.length === 0 ? (
                    <p className="mt-1 text-sm text-ink-500">Nobody is eligible for this audience.</p>
                  ) : (
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {preview.preview.map((row) => (
                        <li key={row.email}>
                          <Badge tone="green">{row.email}</Badge>
                        </li>
                      ))}
                      {preview.previewTruncated ? (
                        <li className="text-xs text-ink-500">…more not shown</li>
                      ) : null}
                    </ul>
                  )}
                </div>

                {preview.skipped.length > 0 ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Skipped by the server</p>
                    <ul className="mt-1 space-y-1">
                      {preview.skipped.map((row) => (
                        <li key={row.email} className="flex flex-wrap items-center gap-2 text-sm text-ink-600">
                          <span>{row.email}</span>
                          <Badge tone="amber">{reasonLabel(row.reason)}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-ink-500">
                {audience
                  ? 'Preview the audience to see exactly who is eligible before sending.'
                  : 'Select recipients (or choose an audience mode) to preview the audience.'}
              </p>
            )}
          </CardBody>
        </Card>

        {/* ----------------------------- Message ---------------------------- */}
        <Field label="Subject" hint={promotional ? 'Sent by Rayern’s campaign backend' : 'Sent through the dashboard email pipeline'}>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        </Field>
        <Field label="Message" hint={promotional ? 'HTML' : 'Plain text or HTML'}>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="<p>Hello, …</p>" className="min-h-32" />
        </Field>

        {result ? (
          <div className="rounded-md border border-ink-200 bg-ink-50/60 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-ink-900">
                Campaign {result.campaign.status.replace(/_/g, ' ')}
                {result.duplicate ? ' (duplicate — already sent)' : ''}
              </p>
              <span className="text-xs text-ink-500">
                accepted = accepted by the email provider, not a delivery confirmation
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <span className="text-ink-700">Resolved: <strong>{result.campaign.totals.resolved}</strong></span>
              <span className="text-ink-700">Accepted: <strong>{result.campaign.totals.accepted}</strong></span>
              <span className="text-ink-700">Failed: <strong>{result.campaign.totals.failed}</strong></span>
              <span className="text-ink-700">Skipped: <strong>{result.campaign.totals.skipped}</strong></span>
            </div>
            {result.campaign.failed.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {result.campaign.failed.map((row) => (
                  <li key={row.email} className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
                    <span>{row.email}</span>
                    <Badge tone="red">failed: {row.error}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            {result.campaign.skipped.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {result.campaign.skipped.map((row) => (
                  <li key={row.email} className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
                    <span>{row.email}</span>
                    <Badge tone="amber">{reasonLabel(row.reason)}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {sendError ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            {sendError}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-ink-200 pt-4">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void handleSend()} disabled={!canSend}>
            {sending ? 'Sending…' : promotional ? 'Send campaign' : 'Send notice'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
