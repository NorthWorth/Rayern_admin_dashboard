import { useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { StatusBadge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { TrendLineChart } from '../components/charts'
import { observabilityService } from '../services/observability'
import { useQuery } from '../hooks/useQuery'
import { formatDuration, formatNumber, formatPct, healthLabel, healthTone, timeAgo } from '../lib/utils'
import type { TraceSpan } from '../lib/types'

export function ObservabilityPage() {
  const q = useQuery(() => observabilityService.overview())
  const [traceFilter, setTraceFilter] = useState<string | null>(null)

  const traces = q.data?.recentTraces ?? []
  const visibleTraces = traceFilter ? traces.filter((t) => t.traceId === traceFilter) : traces

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <Card>
        <CardHeader
          title="Service telemetry"
          subtitle="OpenTelemetry-derived metrics from the dashboard backend"
        />
        {q.loading ? (
          <CardBody><LoadingBlock rows={5} /></CardBody>
        ) : q.error ? (
          <ErrorState message={q.error} onRetry={q.refetch} />
        ) : q.data ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-4 py-2.5">Service</th>
                  <th scope="col" className="px-3 py-2.5">Health</th>
                  <th scope="col" className="px-3 py-2.5">Freshness</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Requests</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Error rate</th>
                  <th scope="col" className="px-3 py-2.5 text-right">p50</th>
                  <th scope="col" className="px-3 py-2.5 text-right">p95</th>
                  <th scope="col" className="px-3 py-2.5 text-right">p99</th>
                </tr>
              </thead>
              <tbody>
                {q.data.services.map((s) => (
                  <tr key={s.service} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                    <td className="px-4 py-2.5 font-medium text-ink-900">{s.service}</td>
                    <td className="px-3 py-2.5"><StatusBadge tone={healthTone(s.status)}>{healthLabel(s.status)}</StatusBadge></td>
                    <td className="px-3 py-2.5">
                      {s.freshness.status === 'none' || !s.freshness.lastTelemetryAt ? (
                        <span className="text-xs text-ink-400">No telemetry</span>
                      ) : s.freshness.status === 'stale' ? (
                        <span className="text-xs font-medium text-amber-700" title={`Last telemetry: ${new Date(s.freshness.lastTelemetryAt).toLocaleString()}`}>
                          Stale · {timeAgo(s.freshness.lastTelemetryAt)}
                        </span>
                      ) : (
                        <span className="text-xs text-ink-500" title={`Last telemetry: ${new Date(s.freshness.lastTelemetryAt).toLocaleString()}`}>
                          {timeAgo(s.freshness.lastTelemetryAt)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink-700">{formatNumber(s.requestCount)}</td>
                    <td className={`px-3 py-2.5 text-right font-medium ${s.errorRatePct > 2 ? 'text-red-600' : 'text-ink-700'}`}>{formatPct(s.errorRatePct, 2)}</td>
                    <td className="px-3 py-2.5 text-right text-ink-600">{formatDuration(s.p50)}</td>
                    <td className="px-3 py-2.5 text-right text-ink-600">{formatDuration(s.p95)}</td>
                    <td className="px-3 py-2.5 text-right text-ink-600">{formatDuration(s.p99)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Error rate trend (24h)" subtitle="Hourly error percentage across services — gaps mean no traffic, not 0%" />
          <CardBody>
            {q.loading ? <LoadingBlock rows={5} /> : q.error ? <ErrorState message={q.error} onRetry={q.refetch} /> : q.data ? <TrendLineChart data={q.data.errorRateTrend} dataKey="errorRatePct" name="Error rate" color="#d64545" /> : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent slow operations" subtitle="Highest p95 operations — avg and p99 from the rolling window" />
          {q.loading ? (
            <CardBody><LoadingBlock rows={5} /></CardBody>
          ) : q.error ? (
            <ErrorState message={q.error} onRetry={q.refetch} />
          ) : q.data ? (
            <ul className="divide-y divide-ink-100">
              {q.data.slowOperations.map((op) => (
                <li key={op.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[13px] font-medium text-ink-800">{op.operation}</p>
                    <p className="text-xs text-ink-500">
                      {op.service} · {formatNumber(op.occurrences)}× · avg {formatDuration(op.avgMs)} · {timeAgo(op.lastSeenAt)}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700" title="p95 / p99 from the rolling window">
                    {formatDuration(op.p95)} p95 · {formatDuration(op.p99)} p99
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent traces"
          subtitle={traceFilter ? `Filtered to trace ${traceFilter}` : 'Grouped spans from recent requests — click a trace to filter'}
          actions={traceFilter ? (
            <button type="button" onClick={() => setTraceFilter(null)} className="text-xs font-medium text-emerald-700 hover:text-emerald-800">Clear filter</button>
          ) : undefined}
        />
        {q.loading ? (
          <CardBody><LoadingBlock rows={8} /></CardBody>
        ) : q.error ? (
          <ErrorState message={q.error} onRetry={q.refetch} />
        ) : visibleTraces.length === 0 ? (
          <EmptyState title="No traces" description="Telemetry will appear once the dashboard backend reports traces." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-4 py-2.5">Trace ID</th>
                  <th scope="col" className="px-3 py-2.5">Span</th>
                  <th scope="col" className="px-3 py-2.5">Service</th>
                  <th scope="col" className="px-3 py-2.5">Operation</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Duration</th>
                  <th scope="col" className="px-3 py-2.5">Status</th>
                  <th scope="col" className="px-3 py-2.5">Started</th>
                </tr>
              </thead>
              <tbody>
                {visibleTraces.map((t: TraceSpan) => (
                  <tr
                    key={t.id}
                    className="cursor-pointer border-b border-ink-100 last:border-0 hover:bg-ink-50/70"
                    onClick={() => setTraceFilter((cur) => (cur === t.traceId ? null : t.traceId))}
                  >
                    <td className="px-4 py-2.5"><code className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">{t.traceId.slice(0, 12)}…</code></td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-ink-500">{t.spanId.slice(0, 8)}</td>
                    <td className="px-3 py-2.5 text-ink-700">{t.service}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-800">{t.operation}</td>
                    <td className="px-3 py-2.5 text-right text-ink-700">{formatDuration(t.durationMs)}</td>
                    <td className="px-3 py-2.5">
                      {t.hasError ? <StatusBadge tone="red">Error</StatusBadge> : <StatusBadge tone="green">OK {t.statusCode}</StatusBadge>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-600">{timeAgo(t.startTime)}</td>
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
