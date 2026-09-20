import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { StatusBadge } from '../components/ui/Badge'
import { LoadingBlock, ErrorState } from '../components/ui/states'
import { VolumeBarChart } from '../components/charts'
import { systemService } from '../services/system'
import { useQuery } from '../hooks/useQuery'
import { formatCompact, formatNumber, formatPct, timeAgo, titleCase } from '../lib/utils'
import type { HealthStatus } from '../lib/types'

function tone(s: HealthStatus): 'green' | 'amber' | 'red' {
  return s === 'healthy' ? 'green' : s === 'degraded' ? 'amber' : 'red'
}

export function SystemPage() {
  const q = useQuery(() => systemService.overview())

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Overall status"
          value={q.data ? titleCase(q.data.overall) : '—'}
          tone={q.data?.overall === 'healthy' ? 'green' : q.data?.overall === 'degraded' ? 'amber' : 'red'}
        />
        <KpiCard label="Requests (24h)" value={q.data ? formatCompact(q.data.requestCount24h) : '—'} />
        <KpiCard label="Error rate" value={q.data ? formatPct(q.data.errorRatePct, 2) : '—'} tone={q.data && q.data.errorRatePct > 1 ? 'red' : 'default'} />
        <KpiCard label="Latency p95" value={q.data ? `${q.data.latency.p95}ms` : '—'} sub={q.data ? `p50 ${q.data.latency.p50}ms · p99 ${q.data.latency.p99}ms` : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Request volume (24h)" subtitle="Requests per 30-minute window, with errors" />
          <CardBody>
            {q.loading ? (
              <LoadingBlock rows={6} />
            ) : q.error ? (
              <ErrorState message={q.error} onRetry={q.refetch} />
            ) : q.data ? (
              <VolumeBarChart
                data={q.data.requestVolume.map((p) => ({ time: `${new Date(p.time).getHours()}:00`, count: p.count, errors: p.errors }))}
                xKey="time"
                series={[
                  { key: 'count', name: 'Requests', color: '#40464f' },
                  { key: 'errors', name: 'Errors', color: '#d64545' },
                ]}
              />
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Latency percentiles" subtitle="Across the dashboard and Rayern APIs" />
          <CardBody className="space-y-3">
            {q.data ? (
              (['p50', 'p90', 'p95', 'p99'] as const).map((k) => {
                const value = q.data?.latency[k] ?? 0
                const max = 500
                const width = Math.min(100, (value / max) * 100)
                return (
                  <div key={k}>
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="font-medium uppercase text-ink-600">{k}</span>
                      <span className="font-semibold text-ink-900">{value}ms</span>
                    </div>
                    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-ink-100">
                      <div className={`h-full rounded-full ${k === 'p99' ? 'bg-amber-500' : 'bg-emerald-600'}`} style={{ width: `${width}%` }} />
                    </div>
                  </div>
                )
              })
            ) : (
              <LoadingBlock rows={4} />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Service availability" subtitle="Reported by the dashboard backend" />
        {q.loading ? (
          <CardBody><LoadingBlock rows={7} /></CardBody>
        ) : q.error ? (
          <ErrorState message={q.error} onRetry={q.refetch} />
        ) : q.data ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-4 py-2.5">Service</th>
                  <th scope="col" className="px-3 py-2.5">Kind</th>
                  <th scope="col" className="px-3 py-2.5">Status</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Uptime (30d)</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Latency p50</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Latency p95</th>
                  <th scope="col" className="px-3 py-2.5">Last incident</th>
                </tr>
              </thead>
              <tbody>
                {q.data.services.map((s) => (
                  <tr key={s.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                    <td className="px-4 py-2.5 font-medium text-ink-900">{s.name}</td>
                    <td className="px-3 py-2.5 text-ink-600">{titleCase(s.kind)}</td>
                    <td className="px-3 py-2.5"><StatusBadge tone={tone(s.status)}>{titleCase(s.status)}</StatusBadge></td>
                    <td className="px-3 py-2.5 text-right text-ink-700">{formatPct(s.uptimePct30d, 2)}</td>
                    <td className="px-3 py-2.5 text-right text-ink-700">{s.latencyMsP50}ms</td>
                    <td className="px-3 py-2.5 text-right text-ink-700">{s.latencyMsP95}ms</td>
                    <td className="px-3 py-2.5 text-ink-600">{s.lastIncidentAt ? timeAgo(s.lastIncidentAt) : <span className="text-ink-400">None on record</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Recent failures" subtitle="Aggregated failures across services (24h)" />
        {q.loading ? (
          <CardBody><LoadingBlock rows={3} /></CardBody>
        ) : q.error ? (
          <ErrorState message={q.error} onRetry={q.refetch} />
        ) : q.data ? (
          <ul className="divide-y divide-ink-100">
            {q.data.recentFailures.map((f) => (
              <li key={f.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">{f.service}</p>
                  <p className="truncate text-xs text-ink-600">{f.message}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-medium text-red-600">{formatNumber(f.count)}× recent</p>
                  <p className="text-xs text-ink-500">{timeAgo(f.time)}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  )
}
