import { useEffect, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { Badge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { useQuery } from '../hooks/useQuery'
import { billingState, type BillingViewState } from '../services/billing'
import { formatCurrencyMajor, formatNumber, formatDate } from '../lib/utils'

function PlanBreakdownRow({
  entry,
  currency,
}: {
  entry: BillingViewState['billing']['planBreakdown'][0]
  currency: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone={entry.isPaid ? 'green' : 'neutral'}>{entry.plan}</Badge>
        <span className="text-sm text-ink-700">{formatNumber(entry.userCount)} user{entry.userCount === 1 ? '' : 's'}</span>
        {entry.subscriptionCount !== entry.userCount && (
          <span className="text-xs text-ink-500">{formatNumber(entry.subscriptionCount)} subscription{entry.subscriptionCount === 1 ? '' : 's'}</span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        {entry.isPaid ? (
          <span className="font-medium tabular-nums text-ink-900">
            {formatCurrencyMajor(entry.userCount > 0 ? 0 : 0, currency)}
          </span>
        ) : (
          <span className="text-sm text-ink-500">free</span>
        )}
      </div>
    </div>
  )
}

function MrrByPlanRow({
  entry,
  currency,
}: {
  entry: BillingViewState['billing']['mrr']['byPlan'][0]
  currency: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink-800">{entry.plan}</span>
        <span className="text-sm text-ink-600">{formatNumber(entry.subscriberCount)} subscriber{entry.subscriberCount === 1 ? '' : 's'}</span>
      </div>
      <span className="font-medium tabular-nums text-ink-900">
        {formatCurrencyMajor(entry.mrrMinor, currency)}
      </span>
    </div>
  )
}

export function BillingPage() {
  const query = useQuery(() => billingState())
  const [state, setState] = useState<BillingViewState>({ kind: 'loading' })

  useEffect(() => {
    setState(query.data ?? { kind: 'loading' })
  }, [query.data])

  const renderContent = () => {
    switch (state.kind) {
      case 'loading':
        return <LoadingBlock rows={6} />
      case 'unavailable':
        return (
          <EmptyState
            title="Billing metrics unavailable"
            description="No billing data has been synchronized from Rayern yet. The dashboard will show billing once a sync has completed."
          />
        )
      case 'error':
        return <ErrorState message={state.message} onRetry={() => query.refetch()} />
      case 'populated': {
        const billing = state.billing
        return (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                label="MRR"
                value={formatCurrencyMajor(billing.mrr.amountMajor, billing.currency)}
                sub={`${billing.currency} · ${billing.amountUnit}`}
              />
              <KpiCard
                label="ARR"
                value={formatCurrencyMajor(billing.arr.amountMajor, billing.currency)}
                sub={billing.arr.definition}
              />
              <KpiCard
                label="Active paid subscribers"
                value={formatNumber(billing.activePaidSubscribers)}
                sub="distinct owners"
              />
              <KpiCard
                label="Free users"
                value={formatNumber(billing.freeUsers)}
                sub="starter / unpaid"
              />
            </div>

            <Card>
              <CardHeader
                title="Revenue breakdown"
                subtitle={`Generated at ${formatDate(billing.generatedAt)} · ${billing.currency} · ${billing.amountUnit}`}
              />
              <CardBody>
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500">MRR by plan</h3>
                  <div className="space-y-2">
                    {billing.mrr.byPlan.length === 0 ? (
                      <p className="text-sm text-ink-500">No paid subscribers recorded yet.</p>
                    ) : (
                      billing.mrr.byPlan.map((entry) => (
                        <MrrByPlanRow key={entry.plan} entry={entry} currency={billing.currency} />
                      ))
                    )}
                  </div>

                  <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Plan breakdown</h3>
                  <div className="space-y-2">
                    {billing.planBreakdown.length === 0 ? (
                      <p className="text-sm text-ink-500">No plan breakdown recorded yet.</p>
                    ) : (
                      billing.planBreakdown.map((entry) => (
                        <PlanBreakdownRow key={entry.plan} entry={entry} currency={billing.currency} />
                      ))
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Data freshness" subtitle="How recently Rayern last pushed billing data." />
              <CardBody>
                <div className="rounded-lg border border-ink-200 bg-ink-50/60 p-4 text-sm">
                  <dl className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">Billing generated at</dt>
                      <dd className="text-ink-900">{formatDate(billing.generatedAt)}</dd>
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
                      <dt className="text-xs text-ink-500">Active paid subscribers</dt>
                      <dd className="text-ink-900">{formatNumber(billing.activePaidSubscribers)}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">Free users</dt>
                      <dd className="text-ink-900">{formatNumber(billing.freeUsers)}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-ink-500">Total accounts</dt>
                      <dd className="text-ink-900">{formatNumber(billing.totalAccounts)}</dd>
                    </div>
                  </dl>
                </div>
              </CardBody>
            </Card>
          </div>
        )
      }
      default:
        return null
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-6">
      <header className="mb-2">
        <h1 className="text-2xl font-semibold text-ink-900">Billing</h1>
        <p className="mt-1 text-sm text-ink-500">
          Subscribed revenue, subscriber counts, and plan breakdown from Rayern.
        </p>
      </header>
      {renderContent()}
    </div>
  )
}
