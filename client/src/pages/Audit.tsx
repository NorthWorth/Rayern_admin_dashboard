import { useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { SearchInput } from '../components/SearchInput'
import { Badge } from '../components/ui/Badge'
import { Select } from '../components/ui/Input'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { auditService } from '../services/audit'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useQuery } from '../hooks/useQuery'
import { formatDateTime } from '../lib/utils'
import type { AuditActorKind, AuditEvent } from '../lib/types'

export function AuditPage() {
  const [search, setSearch] = useState('')
  const [actorKind, setActorKind] = useState<AuditActorKind | 'all'>('all')
  const debouncedSearch = useDebouncedValue(search)

  const listQ = useQuery(
    () => auditService.list({ search: debouncedSearch, actorKind }),
    [debouncedSearch, actorKind],
  )

  const events = listQ.data ?? []

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <Card>
        <CardHeader
          title="Audit log"
          subtitle="Administrative and important system events"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search actor, action, target…" className="w-72" />
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
          <div className="overflow-x-auto">
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
                {events.map((ev: AuditEvent) => (
                  <tr key={ev.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-2">
                        <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${ev.actorKind === 'admin' ? 'bg-ink-900 text-white' : 'bg-ink-200 text-ink-600'}`}>
                          {ev.actorKind === 'admin' ? 'A' : 'S'}
                        </span>
                        <span className="text-ink-800">{ev.actor}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5"><code className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-700">{ev.action}</code></td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-700">{ev.target}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(ev.metadata).map(([k, v]) => (
                          <Badge key={k} tone="neutral">{k}: {v}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-600">{formatDateTime(ev.timestamp)}</td>
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
