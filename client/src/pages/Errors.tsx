import { useEffect, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { SearchInput } from '../components/SearchInput'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { Drawer } from '../components/ui/Drawer'
import { Select } from '../components/ui/Input'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { Collapser } from '../components/Collapser'
import { errorsService } from '../services/errors'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useQuery } from '../hooks/useQuery'
import { formatDateTime, timeAgo } from '../lib/utils'
import type { ErrorEntry, ErrorSeverity } from '../lib/types'

function severityTone(s: ErrorSeverity): 'neutral' | 'amber' | 'red' {
  switch (s) {
    case 'critical': return 'red'
    case 'high': return 'red'
    case 'medium': return 'amber'
    default: return 'neutral'
  }
}

export function ErrorsPage() {
  const [search, setSearch] = useState('')
  const [severity, setSeverity] = useState<ErrorSeverity | 'all'>('all')
  const [selected, setSelected] = useState<ErrorEntry | null>(null)
  const debouncedSearch = useDebouncedValue(search)

  useEffect(() => {}, [debouncedSearch])

  const listQ = useQuery(
    () => errorsService.list({ search: debouncedSearch, severity }),
    [debouncedSearch, severity],
  )

  const errors = listQ.data ?? []

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <Card>
        <CardHeader
          title="Recent errors"
          subtitle="Grouped operational errors across services"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search message, endpoint, trace…" className="w-72" />
              <Select aria-label="Filter by severity" value={severity} onChange={(e) => setSeverity(e.target.value as ErrorSeverity | 'all')} className="w-36">
                <option value="all">All severities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            </div>
          }
        />
        {listQ.loading ? (
          <CardBody><LoadingBlock rows={8} /></CardBody>
        ) : listQ.error ? (
          <ErrorState message={listQ.error} onRetry={listQ.refetch} />
        ) : errors.length === 0 ? (
          <EmptyState title="No errors match" description="Adjust the search or severity filter." />
        ) : (
          <Collapser total={errors.length} label="errors">
            {(visibleCount) => (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-4 py-2.5">Severity</th>
                  <th scope="col" className="px-3 py-2.5">Service / endpoint</th>
                  <th scope="col" className="px-3 py-2.5">Message</th>
                  <th scope="col" className="px-3 py-2.5">Status</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Count</th>
                  <th scope="col" className="px-3 py-2.5">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {errors.slice(0, visibleCount).map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer border-b border-ink-100 last:border-0 hover:bg-ink-50/70"
                    onClick={() => setSelected(e)}
                  >
                    <td className="px-4 py-2.5"><Badge tone={severityTone(e.severity)}>{titleCase(e.severity)}</Badge></td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink-800">{e.service}</p>
                      <p className="text-xs text-ink-500">{e.method} {e.endpoint}</p>
                    </td>
                    <td className="max-w-[20rem] px-3 py-2.5"><p className="truncate text-ink-700">{e.message}</p></td>
                    <td className="px-3 py-2.5"><code className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-semibold text-ink-700">{e.statusCode}</code></td>
                    <td className="px-3 py-2.5 text-right text-ink-700">{e.count}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-600">{timeAgo(e.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            )}
          </Collapser>
        )}
      </Card>

      <ErrorDetailDrawer error={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function ErrorDetailDrawer({ error, onClose }: { error: ErrorEntry | null; onClose: () => void }) {
  return (
    <Drawer open={error !== null} onClose={onClose} title="Error detail">
      {error ? (
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2">
            <Badge tone={severityTone(error.severity)}>{titleCase(error.severity)}</Badge>
            <StatusBadge tone={error.statusCode >= 500 ? 'red' : 'amber'}>HTTP {error.statusCode}</StatusBadge>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Message</p>
            <p className="mt-1 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 font-mono text-[13px] text-ink-800">{error.message}</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Detail label="Service" value={error.service} />
            <Detail label="Endpoint" value={`${error.method} ${error.endpoint}`} />
            <Detail label="First seen" value={formatDateTime(error.firstSeenAt)} />
            <Detail label="Last seen" value={formatDateTime(error.lastSeenAt)} />
            <Detail label="Occurrences" value={String(error.count)} />
            <Detail label="Trace ID" value={error.traceId ? <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[12px]">{error.traceId}</code> : 'Not recorded'} mono />
          </dl>
        </div>
      ) : null}
    </Drawer>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className={mono ? 'mt-0.5 break-all font-mono text-[12px] text-ink-700' : 'mt-0.5 text-ink-800'}>{value}</dd>
    </div>
  )
}
