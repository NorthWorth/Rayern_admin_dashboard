import { useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { Pagination } from '../components/Pagination'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { Select } from '../components/ui/Input'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { usersService } from '../services/users'
import { formatCount, formatDate, formatNumber, initialsOf } from '../lib/utils'
import {
  RAYERN_PLANS,
  SUBSCRIPTION_STATUSES,
  type AdminUserFilters,
  type AdminUserRecord,
  type ConsentFilter,
  type RayernPlan,
  type SubscriptionStatus,
} from '../lib/types'

/**
 * Accounts directory, read from the Rayern admin-users API through the
 * dashboard's existing proxy (`GET /api/v1/admin/users`).
 *
 * The previous implementation read the dashboard's local `accounts` table,
 * which nothing populates in production, so totals were non-zero while the list
 * was always empty. Rayern is the authoritative source of accounts; this page
 * asks it directly (server-side, paginated) instead of maintaining a second,
 * empty directory.
 *
 * Only filters Rayern's contract actually supports are offered — plan,
 * subscription status and marketing consent. Free-text search and
 * verification-status filtering are NOT part of that contract, so they are
 * deliberately absent rather than filtering just the current page and implying
 * a whole-directory result.
 *
 * Privacy: account-level administration fields only. There is no drill-down
 * into workspace content, and no password/token field is ever rendered.
 */
const PAGE_SIZE = 25

function fullName(user: AdminUserRecord): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return name || user.email
}

function verificationBadge(user: AdminUserRecord) {
  if (user.emailVerified === true) return <StatusBadge tone="green">Verified</StatusBadge>
  if (user.emailVerified === false) return <StatusBadge tone="red">Unverified</StatusBadge>
  // Absent is unknown, not "unverified".
  return <Badge tone="neutral">Not reported</Badge>
}

function accountStatusBadge(user: AdminUserRecord) {
  switch ((user.accountStatus ?? '').toLowerCase()) {
    case 'active':
      return <StatusBadge tone="green">Active</StatusBadge>
    case 'suspended':
      return <StatusBadge tone="amber">Suspended</StatusBadge>
    case 'closed':
      return <Badge tone="neutral">Closed</Badge>
    default:
      return <span className="text-ink-500">—</span>
  }
}

function subscriptionBadge(user: AdminUserRecord) {
  const status = user.subscription?.status ?? null
  if (status === null) return <Badge tone="neutral">Free</Badge>
  const tone = status === 'active' ? 'green' : status === 'past_due' ? 'amber' : status === 'none' ? 'neutral' : 'amber'
  return <Badge tone={tone}>{status.replace(/_/g, ' ')}</Badge>
}

export function UsersPage() {
  const [plan, setPlan] = useState<RayernPlan | 'all'>('all')
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | 'all'>('all')
  const [consent, setConsent] = useState<ConsentFilter | 'all'>('all')
  const [page, setPage] = useState(1)

  // Reset to page 1 when a filter changes, during render so the directory query
  // runs once with (new filters, page 1) instead of twice.
  const filterKey = `${plan}\u0000${subscriptionStatus}\u0000${consent}`
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey)
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey)
    setPage(1)
  }

  const filters: AdminUserFilters = {
    page,
    limit: PAGE_SIZE,
    plan,
    subscriptionStatus,
    consent,
  }

  // KPIs come from the synchronized Rayern snapshot aggregates; the directory
  // itself comes live from the admin-users API. Both are Rayern-sourced.
  const statsQ = useQuery(() => usersService.stats())
  const listQ = useQuery(() => usersService.directory(filters), [plan, subscriptionStatus, consent, page])
  usePageRefresh([statsQ, listQ])

  const pageData = listQ.data
  const users = pageData?.users ?? []
  const totalResults = pageData?.pagination.totalResults ?? 0
  const currentPage = pageData?.pagination.page ?? page
  const pageSize = pageData?.pagination.limit ?? PAGE_SIZE

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Total accounts" value={statsQ.data ? formatNumber(statsQ.data.totalUsers) : '—'} />
        <KpiCard label="New (7d)" value={statsQ.data ? formatNumber(statsQ.data.newUsers7d) : '—'} />
        <KpiCard label="Verified" value={statsQ.data ? formatNumber(statsQ.data.verified) : '—'} tone="green" />
        <KpiCard label="Unverified" value={statsQ.data ? formatNumber(statsQ.data.unverified) : '—'} tone="amber" />
        <KpiCard
          label="Deletions (30d)"
          value={statsQ.data ? formatCount(statsQ.data.deleted30d) : '—'}
          sub={statsQ.data && statsQ.data.deleted30d === null ? 'not measured by Rayern' : undefined}
        />
      </div>

      <Card>
        <CardHeader
          title="Accounts"
          subtitle="Live directory from Rayern's admin API — account-level administration data only, no workspace content"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Filter by plan"
                value={plan}
                onChange={(e) => setPlan(e.target.value as RayernPlan | 'all')}
                className="w-36"
              >
                <option value="all">All plans</option>
                {RAYERN_PLANS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Filter by subscription status"
                value={subscriptionStatus}
                onChange={(e) => setSubscriptionStatus(e.target.value as SubscriptionStatus | 'all')}
                className="w-44"
              >
                <option value="all">All subscription states</option>
                {SUBSCRIPTION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Filter by marketing consent"
                value={consent}
                onChange={(e) => setConsent(e.target.value as ConsentFilter | 'all')}
                className="w-40"
              >
                <option value="all">All consent</option>
                <option value="opted_in">Opted in</option>
                <option value="opted_out">Opted out</option>
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
        ) : users.length === 0 ? (
          <EmptyState
            title="No accounts match"
            description={
              totalResults === 0 && plan === 'all' && subscriptionStatus === 'all' && consent === 'all'
                ? 'Rayern returned no accounts for this directory. If this is unexpected, check the Rayern admin API configuration on the backend.'
                : 'Rayern returned no accounts for these filters. Adjust the plan, subscription or consent filter.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Account</th>
                    <th scope="col" className="px-3 py-2.5">Verification</th>
                    <th scope="col" className="px-3 py-2.5">Status</th>
                    <th scope="col" className="px-3 py-2.5">Plan</th>
                    <th scope="col" className="px-3 py-2.5">Subscription</th>
                    <th scope="col" className="px-3 py-2.5">Registered</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={String(u.id)} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">
                            {initialsOf(fullName(u))}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink-900">{fullName(u)}</p>
                            <p className="truncate text-xs text-ink-500">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">{verificationBadge(u)}</td>
                      <td className="px-3 py-2.5">{accountStatusBadge(u)}</td>
                      <td className="px-3 py-2.5 capitalize text-ink-700">
                        {u.workspace?.plan ?? u.subscription?.plan ?? '—'}
                      </td>
                      <td className="px-3 py-2.5">{subscriptionBadge(u)}</td>
                      <td className="px-3 py-2.5 text-ink-600">{u.createdAt ? formatDate(u.createdAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={currentPage}
              pageSize={pageSize}
              total={totalResults}
              onPageChange={setPage}
            />
          </>
        )}
        <div className="border-t border-ink-100 px-4 py-2.5">
          <p className="text-xs text-ink-500">
            Source: Rayern <code className="rounded bg-ink-100 px-1">GET /api/v1/admin/users</code>, proxied
            server-side. Filters are applied by Rayern, not in the browser. Free-text search and verification-status
            filtering are not part of that API, so they are not offered here.
          </p>
        </div>
      </Card>
    </div>
  )
}
