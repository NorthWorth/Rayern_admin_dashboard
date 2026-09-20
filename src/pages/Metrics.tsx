import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { LoadingBlock, ErrorState } from '../components/ui/states'
import { VolumeBarChart } from '../components/charts'
import { TrendLineChart } from '../components/charts'
import { platformMetricsService } from '../services/platformMetrics'
import { useQuery } from '../hooks/useQuery'
import { formatNumber, titleCase } from '../lib/utils'

export function MetricsPage() {
  const q = useQuery(() => platformMetricsService.overview())

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Registered accounts" value={q.data ? formatNumber(q.data.registeredAccounts) : '—'} />
        <KpiCard label="New accounts (30d)" value={q.data ? formatNumber(q.data.newAccounts30d) : '—'} tone="green" />
        <KpiCard label="Total workspaces" value={q.data ? formatNumber(q.data.totalWorkspaces) : '—'} />
        <KpiCard label="Deletions (30d)" value={q.data ? formatNumber(q.data.deletedAccounts30d) : '—'} tone="amber" sub={q.data && q.data.deletionRequestsPending > 0 ? `${q.data.deletionRequestsPending} requests pending` : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="New registrations" subtitle="New accounts created per day (90 days)" />
          <CardBody>
            {q.loading ? (
              <LoadingBlock rows={6} />
            ) : q.error ? (
              <ErrorState message={q.error} onRetry={q.refetch} />
            ) : q.data ? (
              <TrendLineChart
                data={q.data.registrationsTrend.map((d) => ({ time: d.date, count: d.count }))}
                dataKey="count"
                name="Registrations"
                unit=""
              />
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Account verification" subtitle="Verified vs unverified accounts" />
          <CardBody className="space-y-3">
            {q.loading ? (
              <LoadingBlock rows={3} />
            ) : q.error ? (
              <ErrorState message={q.error} onRetry={q.refetch} />
            ) : q.data ? (
              <>
                <VerificationBar
                  label="Verified"
                  count={q.data.verifiedAccounts}
                  total={q.data.registeredAccounts}
                  color="bg-emerald-600"
                />
                <VerificationBar
                  label="Unverified"
                  count={q.data.unverifiedAccounts}
                  total={q.data.registeredAccounts}
                  color="bg-amber-500"
                />
              </>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Workspace plans" subtitle="Aggregate count of workspaces per plan tier" />
        <CardBody>
          {q.loading ? (
            <LoadingBlock rows={4} />
          ) : q.error ? (
            <ErrorState message={q.error} onRetry={q.refetch} />
          ) : q.data ? (
            <VolumeBarChart
              data={q.data.planBreakdown.map((p) => ({ plan: titleCase(p.plan), count: p.count }))}
              xKey="plan"
              series={[{ key: 'count', name: 'Workspaces', color: '#40464f' }]}
            />
          ) : null}
        </CardBody>
      </Card>
    </div>
  )
}

function VerificationBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink-600">{label}</span>
        <span className="text-ink-500">
          <span className="font-semibold text-ink-900">{formatNumber(count)}</span> · {pct.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-ink-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
