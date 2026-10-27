import type { ReactNode } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { Badge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { revenueService, type RevenueState } from '../services/revenue'
import { systemService } from '../services/system'
import type { SystemOverview } from '../lib/types'
import { formatCurrencyMajor, formatDate, formatDateTime, formatNumber, titleCase } from '../lib/utils'

/**
 * Revenue — financial and subscription metrics from Rayern.
 *
 * Every figure on this page comes from the `billing` block of
 * `GET /api/v1/admin/metrics` (contract §2.3) exactly as Rayern reported it.
 * Nothing is recalculated client-side, and a missing block renders an explicit
 * "unavailable" state instead of zeros.
 */
export function RevenuePage() {
  const query = useQuery(() => revenueService.state())
  // Optional freshness signal: the dashboard-side pull-sync status (System
  // page source). Failure only hides the sync row — revenue data still renders.
  const syncQ = useQuery<SystemOverview | null>(() =>
    Promise.resolve()
      .then(() => systemService.overview())
      .catch(() => null),
  )
  // Navbar refresh re-runs exactly these two queries.
  usePageRefresh([query, syncQ])

  const state: RevenueState = query.data ?? { kind: 'loading' }

  const renderBody = (): ReactNode => {
    switch (state.kind) {
      case 'loading':
        return <LoadingBlock rows={6} />
      case 'unavailable':
        return (
          <EmptyState
            title="Revenue metrics unavailable"
            description="No billing data has been synchronized from Rayern yet. The dashboard never estimates MRR or ARR — this page fills in as soon as the Rayern sync delivers a billing block."
          />
        )
      case 'error':
        return <ErrorState message={state.message} onRetry={() => query.refetch()} />
      case 'populated': {
        const billing = state.billing
        const sync = syncQ.data?.sync ?? null
        return (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                label="MRR"
                value={formatCurrencyMajor(billing.mrr.amountMajor, billing.currency)}
                sub={`${billing.currency} · monthly recurring`}
              />
              <KpiCard
                label="ARR"
                value={formatCurrencyMajor(billing.arr.amountMajor, billing.currency)}
                sub={`${billing.currency} · ${billing.arr.definition}`}
              />
              <KpiCard
                label="Active paid subscribers"
                value={formatNumber(billing.activePaidSubscribers)}
                sub="distinct paying accounts"
                tone="green"
              />
              <KpiCard
                label="Free users"
                value={formatNumber(billing.freeUsers)}
                sub="no paid subscription"
              />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <Card>
                <CardHeader
                  title="MRR by plan"
                  subtitle={`Reported by Rayern in ${billing.currency}`}
                />
                <CardBody>
                  {billing.mrr.byPlan.length === 0 ? (
                    <p className="text-sm text-ink-500">No paid subscriptions reported yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {billing.mrr.byPlan.map((entry) => (
                        <div
                          key={entry.plan}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3"
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge tone="blue">{entry.plan}</Badge>
                            <span className="text-sm text-ink-700">
                              {formatNumber(entry.subscriberCount)} subscriber
                              {entry.subscriberCount === 1 ? '' : 's'}
                            </span>
                          </div>
                          <span className="font-medium tabular-nums text-ink-900">
                            {formatCurrencyMajor(entry.mrrMinor / 100, billing.currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Plan breakdown"
                  subtitle="Subscribers and subscription documents per plan"
                />
                <CardBody>
                  {billing.planBreakdown.length === 0 ? (
                    <p className="text-sm text-ink-500">No plan breakdown reported yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {billing.planBreakdown.map((entry) => (
                        <div
                          key={entry.plan}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3"
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge tone={entry.isPaid ? 'green' : 'neutral'}>{entry.plan}</Badge>
                            <span className="text-sm text-ink-700">
                              {formatNumber(entry.userCount)} user{entry.userCount === 1 ? '' : 's'}
                            </span>
                            <span className="text-xs text-ink-500">
                              {formatNumber(entry.subscriptionCount)} subscription
                              {entry.subscriptionCount === 1 ? '' : 's'}
                            </span>
                          </div>
                          <span className="text-xs font-medium text-ink-500">
                            {entry.isPaid ? 'paid' : 'free'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>

            <Card>
              <CardHeader
                title="Data freshness"
                subtitle="When Rayern generated these figures and when the dashboard last synced"
              />
              <CardBody>
                <div className="rounded-lg border border-ink-200 bg-ink-50/60 p-4 text-sm">
                  <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">Rayern billing generated at</dt>
                      <dd className="text-ink-900">{formatDateTime(billing.generatedAt)}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">Last successful dashboard sync</dt>
                      <dd className="text-ink-900">
                        {sync ? (
                          sync.lastSuccessAt ? (
                            <span className="inline-flex items-center gap-2">
                              {formatDateTime(sync.lastSuccessAt)}
                              {sync.stale ? <Badge tone="amber">stale</Badge> : <Badge tone="green">fresh</Badge>}
                            </span>
                          ) : (
                            'No successful sync yet'
                          )
                        ) : (
                          'Unknown'
                        )}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">Currency</dt>
                      <dd className="text-ink-900">{billing.currency}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">Amount unit</dt>
                      <dd className="text-ink-900">{billing.amountUnit}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">MRR (minor units)</dt>
                      <dd className="tabular-nums text-ink-900">{formatNumber(billing.mrr.amountMinor)}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">ARR (minor units)</dt>
                      <dd className="tabular-nums text-ink-900">{formatNumber(billing.arr.amountMinor)}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">Total accounts</dt>
                      <dd className="text-ink-900">{formatNumber(billing.totalAccounts)}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">ARR definition</dt>
                      <dd className="text-ink-900">{billing.arr.definition}</dd>
                    </div>
                  </dl>
                </div>

                {Object.keys(billing.definitions ?? {}).length > 0 ? (
                  <div className="mt-4">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                      Metric definitions (from Rayern)
                    </h4>
                    <dl className="mt-2 space-y-1">
                      {Object.entries(billing.definitions).map(([key, value]) => (
                        <div key={key} className="flex flex-wrap gap-2 text-xs text-ink-600">
                          <dt className="font-medium text-ink-700">{titleCase(key)}:</dt>
                          <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : null}
              </CardBody>
            </Card>

            <p className="text-xs text-ink-500">
              Source: Rayern backend via the dashboard pull-sync · generated {formatDate(billing.generatedAt)} ·
              values are rendered exactly as reported (no client-side recalculation).
            </p>
          </div>
        )
      }
      default:
        return null
    }
  }

  return <div className="mx-auto max-w-7xl space-y-6 p-6">{renderBody()}</div>
}
