import { useEffect, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { SearchInput } from '../components/SearchInput'
import { Pagination } from '../components/Pagination'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { Select } from '../components/ui/Input'
import { usersService } from '../services/users'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useQuery } from '../hooks/useQuery'
import { formatDate, formatNumber, initialsOf } from '../lib/utils'
import type { AccountStatus, Paged, User, VerificationStatus } from '../lib/types'

const PAGE_SIZE = 12

/**
 * Account administration: basic account-level info only.
 * A user record is never a gateway into a customer's workspace content —
 * there are no drill-downs into clients, projects, tasks, or activity.
 */
export function UsersPage() {
  const [search, setSearch] = useState('')
  const [verification, setVerification] = useState<VerificationStatus | 'all'>('all')
  const [status, setStatus] = useState<AccountStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search)

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, verification, status])

  const statsQ = useQuery(() => usersService.stats())
  const listQ = useQuery(
    () => usersService.list({ search: debouncedSearch, verification, status, page, pageSize: PAGE_SIZE }),
    [debouncedSearch, verification, status, page],
  )

  const data: Paged<User> | null = listQ.data

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Total accounts" value={statsQ.data ? formatNumber(statsQ.data.totalUsers) : '—'} />
        <KpiCard label="New (7d)" value={statsQ.data ? formatNumber(statsQ.data.newUsers7d) : '—'} />
        <KpiCard label="Verified" value={statsQ.data ? formatNumber(statsQ.data.verified) : '—'} tone="green" />
        <KpiCard label="Unverified" value={statsQ.data ? formatNumber(statsQ.data.unverified) : '—'} tone="amber" />
        <KpiCard label="Deletions (30d)" value={statsQ.data ? formatNumber(statsQ.data.deleted30d) : '—'} />
      </div>

      <Card>
        <CardHeader
          title="Accounts"
          subtitle="Basic account information for platform administration — no workspace content access"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search name or email…" className="w-64" />
              <Select
                aria-label="Filter by verification status"
                value={verification}
                onChange={(e) => setVerification(e.target.value as VerificationStatus | 'all')}
                className="w-40"
              >
                <option value="all">All verification</option>
                <option value="verified">Verified</option>
                <option value="unverified">Unverified</option>
                <option value="pending">Pending</option>
              </Select>
              <Select
                aria-label="Filter by account status"
                value={status}
                onChange={(e) => setStatus(e.target.value as AccountStatus | 'all')}
                className="w-40"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="closed">Closed</option>
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
          <EmptyState title="No accounts found" description="Try adjusting your search or filters." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Account</th>
                    <th scope="col" className="px-3 py-2.5">Verification</th>
                    <th scope="col" className="px-3 py-2.5">Status</th>
                    <th scope="col" className="px-3 py-2.5">Registered</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((u) => (
                    <tr key={u.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">
                            {initialsOf(u.name)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink-900">{u.name}</p>
                            <p className="truncate text-xs text-ink-500">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {u.verification === 'verified' ? (
                          <StatusBadge tone="green">Verified</StatusBadge>
                        ) : u.verification === 'unverified' ? (
                          <StatusBadge tone="red">Unverified</StatusBadge>
                        ) : (
                          <Badge tone="amber">Pending</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {u.status === 'active' ? (
                          <StatusBadge tone="green">Active</StatusBadge>
                        ) : u.status === 'suspended' ? (
                          <StatusBadge tone="amber">Suspended</StatusBadge>
                        ) : (
                          <Badge tone="neutral">Closed</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-ink-600">{formatDate(u.createdAt)}</td>
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
