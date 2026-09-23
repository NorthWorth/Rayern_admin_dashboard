import { useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { SearchInput } from '../components/SearchInput'
import { Badge } from '../components/ui/Badge'
import { Select } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { auditService } from '../services/audit'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useQuery } from '../hooks/useQuery'
import { formatDateTime } from '../lib/utils'
import type { AuditActorKind, AuditEvent } from '../lib/types'

/* ------------------------- Compact metadata rendering ---------------------- */

type RecipientField = 'To' | 'CC' | 'BCC'

interface RecipientSection {
  field: RecipientField
  count: number
  /** Full addresses when a legacy row stored them; empty for count-only rows. */
  addresses: string[]
}

interface MetaView {
  /** Present only when the event carries recipient information at all. */
  recipientLine: string | null
  recipients: RecipientSection[]
  /** Non-recipient entries, values truncated for safe inline badges. */
  badges: Array<{ key: string; value: string }>
  /** Non-recipient entries with full values (for the details modal). */
  entries: Array<{ key: string; value: string }>
}

const RECIPIENT_LIST_KEYS: Array<['to' | 'cc' | 'bcc', RecipientField]> = [
  ['to', 'To'],
  ['cc', 'CC'],
  ['bcc', 'BCC'],
]
const RECIPIENT_COUNT_KEYS: Array<['toCount' | 'ccCount' | 'bccCount', RecipientField]> = [
  ['toCount', 'To'],
  ['ccCount', 'CC'],
  ['bccCount', 'BCC'],
]

function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function truncateBadge(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Turns audit metadata into a compact, bulk-send-safe view.
 *
 * The Audit Log must never render one recipient per line or rows whose height
 * scales with recipient count: full To/CC/BCC lists (legacy rows) collapse to
 * counts in the table, and the complete list is only reachable through the
 * explicit Details modal. Email bodies are never part of audit metadata.
 */
function summarizeMetadata(metadata: Record<string, string>): MetaView {
  const counts: Record<RecipientField, number> = { To: 0, CC: 0, BCC: 0 }
  const addresses: Record<RecipientField, string[]> = { To: [], CC: [], BCC: [] }
  const consumed = new Set<string>()
  let sawRecipientField = false

  // Legacy rows stored full comma-joined recipient lists under to/cc/bcc.
  for (const [key, field] of RECIPIENT_LIST_KEYS) {
    if (!(key in metadata)) continue
    consumed.add(key)
    sawRecipientField = true
    addresses[field] = splitAddresses(metadata[key] ?? '')
    counts[field] = addresses[field].length
  }
  // New rows store aggregate counts only (the full list stays in email history).
  for (const [key, field] of RECIPIENT_COUNT_KEYS) {
    if (!(key in metadata)) continue
    consumed.add(key)
    sawRecipientField = true
    const n = Number(metadata[key])
    if (Number.isFinite(n) && n >= 0) counts[field] = Math.floor(n)
  }

  const total = counts.To + counts.CC + counts.BCC
  const recipientLine = !sawRecipientField
    ? null
    : counts.CC > 0 || counts.BCC > 0
      ? `${counts.To} To · ${counts.CC} CC · ${counts.BCC} BCC`
      : `${total} recipient${total === 1 ? '' : 's'}`

  const entries: Array<{ key: string; value: string }> = Object.entries(metadata)
    .filter(([key]) => !consumed.has(key))
    .map(([key, value]) => ({ key, value }))
  return {
    recipientLine,
    recipients: RECIPIENT_LIST_KEYS
      .map(([, field]) => ({ field, count: counts[field], addresses: addresses[field] }))
      .filter((s) => s.count > 0 || s.addresses.length > 0),
    badges: entries.map(({ key, value }) => ({ key, value: truncateBadge(value) })),
    entries,
  }
}

function MetadataBadges({ view, max = 3 }: { view: MetaView; max?: number }) {
  if (!view.recipientLine && view.badges.length === 0) {
    return <span className="text-xs text-ink-400">—</span>
  }
  return (
    <>
      {view.recipientLine ? <Badge tone="neutral">{view.recipientLine}</Badge> : null}
      {view.badges.slice(0, max).map((b) => (
        <span
          key={b.key}
          title={`${b.key}: ${b.value}`}
          className="max-w-[9rem] truncate rounded-full border border-ink-200 bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600"
        >
          {b.key}: {b.value}
        </span>
      ))}
      {view.badges.length > max ? (
        <span className="text-[10px] font-medium text-ink-400">+{view.badges.length - max}</span>
      ) : null}
    </>
  )
}

/* --------------------------------- Page ----------------------------------- */

export function AuditPage() {
  const [search, setSearch] = useState('')
  const [actorKind, setActorKind] = useState<AuditActorKind | 'all'>('all')
  const [detail, setDetail] = useState<AuditEvent | null>(null)
  const debouncedSearch = useDebouncedValue(search)

  const listQ = useQuery(
    () => auditService.list({ search: debouncedSearch, actorKind }),
    [debouncedSearch, actorKind],
  )

  const events = listQ.data ?? []
  const detailView = detail ? summarizeMetadata(detail.metadata) : null

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <Card>
        <CardHeader
          title="Audit log"
          subtitle="Administrative and important system events — recipients shown as counts"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search actor, action, target…" className="w-full sm:w-72" />
              <Select aria-label="Filter by actor" value={actorKind} onChange={(e) => setActorKind(e.target.value as AuditActorKind | 'all')} className="w-36">
                <option value="all">All actors</option>
                <option value="admin">Admin</option>
                <option value="system">System</option>
              </Select>
            </div>
          }
        />
        {listQ.loading ? (
          <CardBody><LoadingBlock rows={8} /></CardBody>
        ) : listQ.error ? (
          <ErrorState message={listQ.error} onRetry={listQ.refetch} />
        ) : events.length === 0 ? (
          <EmptyState title="No audit events" description="Adjust the search or actor filter." />
        ) : (
          <>
            {/* Desktop: compact rows — metadata is aggregated, never stacked. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Actor</th>
                    <th scope="col" className="px-3 py-2.5">Action</th>
                    <th scope="col" className="px-3 py-2.5">Target</th>
                    <th scope="col" className="px-3 py-2.5">Metadata</th>
                    <th scope="col" className="px-3 py-2.5">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev: AuditEvent) => {
                    const view = summarizeMetadata(ev.metadata)
                    return (
                      <tr key={ev.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <span className="inline-flex items-center gap-2">
                            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${ev.actorKind === 'admin' ? 'bg-ink-900 text-white' : 'bg-ink-200 text-ink-600'}`}>
                              {ev.actorKind === 'admin' ? 'A' : 'S'}
                            </span>
                            <span className="max-w-[12rem] truncate text-ink-800" title={ev.actor}>{ev.actor}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5"><code className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-700">{ev.action}</code></td>
                        <td className="px-3 py-2.5">
                          <p className="max-w-[14rem] truncate font-mono text-[12px] text-ink-700" title={ev.target}>{ev.target}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex max-w-[22rem] flex-wrap items-center gap-1">
                            <MetadataBadges view={view} />
                            <button
                              type="button"
                              onClick={() => setDetail(ev)}
                              className="ml-1 shrink-0 text-[11px] font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline"
                            >
                              Details
                            </button>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink-600">{formatDateTime(ev.timestamp)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: compact cards — no stacked addresses, no wide table. */}
            <ul className="divide-y divide-ink-100 md:hidden">
              {events.map((ev: AuditEvent) => {
                const view = summarizeMetadata(ev.metadata)
                return (
                  <li key={ev.id} className="space-y-1.5 px-4 py-3">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <code className="truncate rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-700">{ev.action}</code>
                      <span className="shrink-0 text-[11px] text-ink-500">{formatDateTime(ev.timestamp)}</span>
                    </div>
                    <p className="truncate text-xs text-ink-700" title={ev.target}>{ev.target || '—'}</p>
                    <p className="truncate text-[11px] text-ink-500" title={ev.actor}>{ev.actor}</p>
                    <div className="flex flex-wrap items-center gap-1">
                      <MetadataBadges view={view} max={2} />
                      <button
                        type="button"
                        onClick={() => setDetail(ev)}
                        className="ml-auto shrink-0 text-[11px] font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline"
                      >
                        Details
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Card>

      {/* Details interaction: full recipient metadata lives HERE, not in the
          table rows. Metadata only — audit events never contain email bodies. */}
      {detail && detailView ? (
        <Modal
          open
          onClose={() => setDetail(null)}
          title="Audit event details"
          description={`${detail.action} · ${formatDateTime(detail.timestamp)}`}
          width="md"
        >
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <p className="min-w-0"><span className="text-ink-400">Actor</span><br className="sm:hidden" /> <span className="break-all text-ink-800">{detail.actor}</span></p>
              <p className="min-w-0"><span className="text-ink-400">Target</span><br className="sm:hidden" /> <span className="break-all text-ink-800">{detail.target || '—'}</span></p>
            </div>

            {detailView.recipients.length > 0 ? (
              <div className="space-y-3">
                {detailView.recipients.map((section) => (
                  <section key={section.field}>
                    <p className="text-xs font-medium text-ink-700">
                      {section.field} · {section.count} recipient{section.count === 1 ? '' : 's'}
                    </p>
                    {section.addresses.length > 0 ? (
                      <ul className="scrollbar-thin mt-1 max-h-44 overflow-y-auto rounded-md border border-ink-200 bg-ink-50 p-2 text-xs">
                        {section.addresses.map((addr) => (
                          <li key={addr} className="truncate py-0.5 text-ink-700" title={addr}>{addr}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-ink-400">
                        Count only — the full recipient list is retained with the email history record.
                      </p>
                    )}
                  </section>
                ))}
              </div>
            ) : null}

            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-700">Metadata</p>
              {detailView.entries.length === 0 ? (
                <p className="text-xs text-ink-400">No additional metadata recorded.</p>
              ) : (
                <dl className="space-y-1.5">
                  {detailView.entries.map(({ key, value }) => (
                    <div key={key} className="flex gap-2 text-xs">
                      <dt className="w-24 shrink-0 text-ink-400">{key}</dt>
                      <dd className="min-w-0 break-words text-ink-700">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
