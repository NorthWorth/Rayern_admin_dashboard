import { useEffect, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { SearchInput } from '../components/SearchInput'
import { Pagination } from '../components/Pagination'
import { Badge } from '../components/ui/Badge'
import { Select } from '../components/ui/Input'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { workspacesService } from '../services/workspaces'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useQuery } from '../hooks/useQuery'
import { formatDate, formatNumber, titleCase } from '../lib/utils'
import type { Paged, Workspace, WorkspaceFilters } from '../lib/types'

const PAGE_SIZE = 12

/**
 * Workspace registrations: administrative metadata only (name, member count,
 * plan, creation date). No per-workspace activity, owners' personal inboxes,
 * or workspace contents are shown.
 */
export function WorkspacesPage() {
  const [search, setSearch] = useState('')
  const [plan, setPlan] = useState<WorkspaceFilters['plan']>('all')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search)

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, plan])

  const statsQ = useQuery(() => workspacesService.stats())
  const listQ = useQuery(
    () => workspacesService.list({ search: debouncedSearch, plan, page, pageSize: PAGE_SIZE }),
    [debouncedSearch, plan, page],
  )

  const data: Paged<Workspace> | null = listQ.data

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Total" value={statsQ.data ? formatNumber(statsQ.data.total) : '—'} />
        <KpiCard label="New (30d)" value={statsQ.data ? formatNumber(statsQ.data.newWorkspaces30d) : '—'} tone="green" />
        <KpiCard label="Avg members" value={statsQ.data ? String(statsQ.data.avgMembersPerWorkspace) : '—'} />
        <KpiCard label="Pro" value={statsQ.data ? formatNumber(statsQ.data.proWorkspaces) : '—'} tone="default" />
        <KpiCard label="Team" value={statsQ.data ? formatNumber(statsQ.data.teamWorkspaces) : '—'} />
      </div>

      <Card>
        <CardHeader
          title="Workspace registrations"
          subtitle="Administrative overview — workspace contents and activity are never shown here"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search workspace name…" className="w-64" />
              <Select aria-label="Filter by plan" value={plan} onChange={(e) => setPlan(e.target.value as WorkspaceFilters['plan'])} className="w-36">
                <option value="all">All plans</option>
                <option value="free">Free</option>
                <option value="pro">Pro</option>
                <option value="team">Team</option>
              </Select>
            </div>
          }
        />
        {listQ.loading ? (
          <CardBody><LoadingBlock rows={8} /></CardBody>
        ) : listQ.error ? (
          <ErrorState message={listQ.error} onRetry={listQ.refetch} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No workspaces found" description="Try adjusting your search or filters." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Workspace</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Members</th>
                    <th scope="col" className="px-3 py-2.5">Created</th>
                    <th scope="col" className="px-3 py-2.5">Plan</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((w) => (
                    <tr key={w.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                      <td className="px-4 py-2.5 font-medium text-ink-900">{w.name}</td>
                      <td className="px-3 py-2.5 text-right text-ink-700">{formatNumber(w.memberCount)}</td>
                      <td className="px-3 py-2.5 text-ink-600">{formatDate(w.createdAt)}</td>
                      <td className="px-3 py-2.5"><Badge tone={w.plan === 'free' ? 'neutral' : w.plan === 'pro' ? 'blue' : 'green'}>{titleCase(w.plan)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  )
}
