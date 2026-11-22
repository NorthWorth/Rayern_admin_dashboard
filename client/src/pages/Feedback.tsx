import { useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { Pagination } from '../components/Pagination'
import { Badge } from '../components/ui/Badge'
import { Select } from '../components/ui/Input'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { PageHeader } from '../components/PageHeader'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { formatDate, formatNumber, titleCase } from '../lib/utils'
import {
  FEEDBACK_CATEGORIES,
  feedbackService,
  type FeedbackCategory,
  type FeedbackRecord,
  type FeedbackStatus,
} from '../services/feedback'

const PAGE_SIZE = 25

const STATUS_TONE: Record<FeedbackStatus, 'neutral' | 'blue' | 'green'> = {
  open: 'blue',
  reviewed: 'neutral',
  resolved: 'green',
}

const NEXT_STATUSES: Record<FeedbackStatus, FeedbackStatus[]> = {
  open: ['reviewed', 'resolved'],
  reviewed: ['resolved', 'open'],
  resolved: ['reviewed', 'open'],
}

/**
 * Feedback — Rayern's administrator-only review queue, read through the
 * dashboard backend. Bodies are customer content: they are listed in this
 * admin-only queue and never included in analytics, logs or exports. The only
 * mutation exposed is the status transition Rayern supports.
 */
export function FeedbackPage() {
  const [category, setCategory] = useState<FeedbackCategory | 'all'>('all')
  const [status, setStatus] = useState<FeedbackStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const filterKey = `${category}\u0000${status}`
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey)
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey)
    setPage(1)
  }

  const summaryQ = useQuery(() => feedbackService.summary())
  const listQ = useQuery(
    () =>
      feedbackService.list({
        page,
        limit: PAGE_SIZE,
        category: category === 'all' ? undefined : category,
        status: status === 'all' ? undefined : status,
        sort: 'createdAt:desc',
      }),
    [category, status, page],
  )
  usePageRefresh([summaryQ, listQ])

  const data = listQ.data
  const items = data?.items ?? []
  const selected: FeedbackRecord | null =
    items.find((item) => item.id === selectedId) ?? (items.length > 0 && selectedId === null ? items[0] : null)
  const summary = summaryQ.data

  async function changeStatus(record: FeedbackRecord, next: FeedbackStatus) {
    setBusyId(record.id)
    setActionError(null)
    try {
      await feedbackService.updateStatus(record.id, next)
      setSelectedId(record.id)
      await Promise.all([listQ.refetch(), summaryQ.refetch()])
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The status update failed.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <PageHeader
        title="Feedback"
        description="Administrator-only review queue — submissions, categories and resolution state."
        footnote="Feedback bodies are customer content. They stay in this admin-only queue and are never included in analytics, application logs or exports. Every status change is audit-logged with the record id and new status only."
      />

      {summaryQ.error ? (
        <ErrorState message={summaryQ.error} onRetry={summaryQ.refetch} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <KpiCard label="Total" value={summary ? formatNumber(summary.total) : '—'} />
          <KpiCard label="Open" value={summary ? formatNumber(summary.byStatus.open) : '—'} tone="default" />
          <KpiCard label="Reviewed" value={summary ? formatNumber(summary.byStatus.reviewed) : '—'} />
          <KpiCard label="Resolved" value={summary ? formatNumber(summary.byStatus.resolved) : '—'} tone="green" />
          <KpiCard
            label="Last submission"
            value={summary?.lastSubmittedAt ? formatDate(summary.lastSubmittedAt) : '—'}
          />
        </div>
      )}

      <Card>
        <CardHeader
          title="Review queue"
          subtitle="Newest first — filter by category or resolution state"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Filter by category"
                value={category}
                onChange={(e) => setCategory(e.target.value as FeedbackCategory | 'all')}
                className="w-52"
              >
                <option value="all">All categories</option>
                {FEEDBACK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Filter by status"
                value={status}
                onChange={(e) => setStatus(e.target.value as FeedbackStatus | 'all')}
                className="w-36"
              >
                <option value="all">All states</option>
                <option value="open">Open</option>
                <option value="reviewed">Reviewed</option>
                <option value="resolved">Resolved</option>
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
        ) : items.length === 0 ? (
          <EmptyState
            title="No feedback in this view"
            description={
              category === 'all' && status === 'all'
                ? 'Rayern has no stored feedback submissions yet.'
                : 'No submissions match this category and state.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Submitted</th>
                    <th scope="col" className="px-3 py-2.5">Category</th>
                    <th scope="col" className="px-3 py-2.5">Account</th>
                    <th scope="col" className="px-3 py-2.5">Message</th>
                    <th scope="col" className="px-3 py-2.5">State</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={
                        'cursor-pointer border-b border-ink-100 last:border-0 hover:bg-ink-50/70 ' +
                        (selected?.id === item.id ? 'bg-ink-50' : '')
                      }
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-600">{formatDate(item.createdAt)}</td>
                      <td className="px-3 py-2.5 text-ink-700">{item.category}</td>
                      <td className="px-3 py-2.5 text-ink-600">{item.user?.email ?? '—'}</td>
                      <td className="max-w-md truncate px-3 py-2.5 text-ink-800">{item.message}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>{titleCase(item.status)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={data?.pagination.page ?? page}
              pageSize={data?.pagination.limit ?? PAGE_SIZE}
              total={data?.pagination.totalResults ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </Card>

      {selected ? (
        <Card>
          <CardHeader
            title="Feedback detail"
            subtitle={`${selected.category} · submitted ${formatDate(selected.createdAt)}`}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {NEXT_STATUSES[selected.status]?.map((next) => (
                  <button
                    key={next}
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void changeStatus(selected, next)}
                    className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                  >
                    {busyId === selected.id ? 'Saving…' : `Mark ${next}`}
                  </button>
                ))}
              </div>
            }
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">State</dt>
                <dd className="mt-0.5 text-ink-800">{titleCase(selected.status)}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Reviewed</dt>
                <dd className="mt-0.5 text-ink-800">{selected.reviewedAt ? formatDate(selected.reviewedAt) : '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Account</dt>
                <dd className="mt-0.5 text-ink-800">{selected.user?.email ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Workspace</dt>
                <dd className="mt-0.5 text-ink-800">{selected.workspaceId ?? '—'}</dd>
              </div>
            </dl>

            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Message</p>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-ink-200 bg-white px-3 py-2.5 text-sm text-ink-800">
                {selected.message}
              </p>
            </div>

            {actionError ? <p className="mt-3 text-xs text-red-600">{actionError}</p> : null}

            <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
              Status transitions are the only supported mutation: categories are set by the submitter and cannot be
              edited here.
            </p>
          </CardBody>
        </Card>
      ) : null}
    </div>
  )
}
