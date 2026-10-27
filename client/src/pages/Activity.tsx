import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { PageHeader } from '../components/PageHeader'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { SearchInput } from '../components/SearchInput'
import { Badge } from '../components/ui/Badge'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { auditService } from '../services/audit'
import { formatDateTime } from '../lib/utils'
import type { AuditActorKind, AuditEvent } from '../lib/types'

/**
 * Coarse category for a recorded action — presentation only, derived from the
 * action name itself so no new event taxonomy is invented.
 */
function categoryOf(action: string): { label: string; tone: 'blue' | 'green' | 'neutral' | 'amber' } {
  if (action.startsWith('sync.')) return { label: 'Rayern sync', tone: 'blue' }
  if (action.startsWith('email.')) return { label: 'Email', tone: 'green' }
  if (action.startsWith('marketing.campaign')) return { label: 'Campaign', tone: 'green' }
  if (action.startsWith('marketing.consent')) return { label: 'Consent', tone: 'amber' }
  if (action.startsWith('admin.')) return { label: 'Administration', tone: 'neutral' }
  return { label: 'System', tone: 'neutral' }
}

function kindLabel(kind: AuditActorKind): string {
  return kind === 'admin' ? 'Admin' : 'System'
}

/**
 * Activity — the chronological event feed for supported, reliably recorded
 * events (administrative actions, campaign sends, consent changes, Rayern
 * sync outcomes). It is intentionally limited to dashboard-originated events:
 * Rayern product usage is not streamed to the dashboard, so customer activity
 * is not shown here.
 */
export function ActivityPage() {
  const [search, setSearch] = useState('')
  const [actorKind, setActorKind] = useState<AuditActorKind | 'all'>('all')
  const debouncedSearch = useDebouncedValue(search)

  const q = useQuery(() => auditService.list({ search: debouncedSearch, actorKind }))
  usePageRefresh([q])

  const events = q.data ?? []

  const byDay = useMemo(() => {
    const groups = new Map<string, AuditEvent[]>()
    for (const ev of events) {
      const day = ev.timestamp.slice(0, 10)
      const list = groups.get(day) ?? []
      list.push(ev)
      groups.set(day, list)
    }
    return [...groups.entries()]
  }, [events])

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const ev of events) {
      const c = categoryOf(ev.action).label
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [events])

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Activity"
        description="Administrative and system events recorded by the dashboard, newest first."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={search} onChange={setSearch} placeholder="Search action, actor, target…" className="w-64" />
            <div role="group" aria-label="Filter by actor" className="inline-flex rounded-md border border-ink-200 bg-white p-0.5">
              {([['all', 'All'], ['admin', 'Admin'], ['system', 'System']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={actorKind === value}
                  onClick={() => setActorKind(value)}
                  className={
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors ' +
                    (actorKind === value ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100')
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        }
        footnote="Source: dashboard audit events — customer product usage inside Rayern workspaces is never recorded here."
      />

      <div className="flex flex-wrap gap-2">
        {categoryCounts.map(([label, count]) => (
          <span key={label} className="rounded-md border border-ink-200 bg-white px-2.5 py-1 text-xs text-ink-600">
            {label} <span className="font-semibold text-ink-900">{count}</span>
          </span>
        ))}
      </div>

      <Card>
        <CardHeader title="Event feed" subtitle={`${events.length} recorded events`} />
        {q.loading ? (
          <CardBody><LoadingBlock rows={6} /></CardBody>
        ) : q.error ? (
          <ErrorState message={q.error} onRetry={q.refetch} />
        ) : byDay.length === 0 ? (
          <EmptyState title="No events match" description="Adjust the search or actor filter." />
        ) : (
          <CardBody className="space-y-6">
            {byDay.map(([day, list]) => (
              <div key={day}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-500">{day}</p>
                <ul className="mt-2 divide-y divide-ink-100">
                  {list.map((ev) => {
                    const category = categoryOf(ev.action)
                    return (
                      <li key={ev.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-800">
                            {ev.action}
                            <Badge tone={category.tone}>{category.label}</Badge>
                            <Badge tone={ev.actorKind === 'system' ? 'neutral' : 'blue'}>{kindLabel(ev.actorKind)}</Badge>
                          </p>
                          <p className="mt-0.5 truncate text-xs text-ink-500">
                            {ev.actor} · {ev.target || '—'}
                            {Object.keys(ev.metadata ?? {}).length > 0
                              ? ` · ${Object.entries(ev.metadata)
                                  .slice(0, 3)
                                  .map(([k, v]) => `${k}=${v}`)
                                  .join(', ')}`
                              : ''}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-ink-500">{formatDateTime(ev.timestamp)}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </CardBody>
        )}
      </Card>

      <div className="rounded-lg border border-ink-200 bg-white px-4 py-3 text-xs text-ink-500">
        Need the raw administrative table with search across metadata? It lives on the{' '}
        <Link to="/audit" className="font-medium text-champagne-700 hover:text-champagne-800">
          Audit log
        </Link>{' '}
        page.
      </div>
    </div>
  )
}
