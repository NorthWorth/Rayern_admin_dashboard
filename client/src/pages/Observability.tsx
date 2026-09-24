import { useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { StatusBadge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { TrendLineChart } from '../components/charts'
import { Collapser } from '../components/Collapser'
import { observabilityService } from '../services/observability'
import { useQuery } from '../hooks/useQuery'
import { formatDuration, formatNumber, formatPct, healthLabel, healthTone, timeAgo } from '../lib/utils'
import type { TraceSpan } from '../lib/types'

/**
 * Fills unobserved (null) buckets inside the observed window with 0 so the
 * error-rate trend is a continuous line instead of a broken one.
 *
 * The backend sends `null` for buckets with NO traffic ("no traffic ≠ 0%",
 * asserted by the telemetry tests) and `0` for buckets that had traffic and
 * no errors. Rendering nulls literally breaks the line into segments — the
 * reported graph gap. This transformation keeps the no-traffic semantics at
 * the EDGES of the chart (buckets before the first observation and after the
 * last one are left null → not rendered, no fabricated observations) while
 * interior gaps become explicit 0 values, which is the honest reading: an
 * interior bucket between two observed ones with no recorded traffic cannot
 * hide an error rate from the viewer.
 */
export function continuousTrend(data: Array<{ time: string; errorRatePct: number | null }>): Array<{ time: string; errorRatePct: number | null }> {
  let first = -1
  let last = -1
  for (let i = 0; i < data.length; i++) {
    if (data[i]?.errorRatePct !== null && data[i]?.errorRatePct !== undefined) {
      if (first === -1) first = i
      last = i
    }
  }
  if (first === -1) return data // no observations at all → nothing to fill
  return data.map((p, i) => (i >= first && i <= last && p.errorRatePct === null ? { ...p, errorRatePct: 0 } : p))
}

export function ObservabilityPage() {
  const q = useQuery(() => observabilityService.overview())
  const [traceFilter, setTraceFilter] = useState<string | null>(null)

  const traces = q.data?.recentTraces ?? []
  const visibleTraces = traceFilter ? traces.filter((t) => t.traceId === traceFilter) : traces
  const trend = continuousTrend(q.data?.errorRateTrend ?? [])

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
          <Collapser total={q.data.services.length} label="services">
            {(visibleCount) => (
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
                {q.data!.services.slice(0, visibleCount).map((s) => (
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
            )}
          </Collapser>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Error rate trend (24h)" subtitle="Hourly error percentage across services — interior gaps render as 0%" />
          <CardBody>
            {q.loading ? <LoadingBlock rows={5} /> : q.error ? <ErrorState message={q.error} onRetry={q.refetch} /> : q.data ? <TrendLineChart data={trend} dataKey="errorRatePct" name="Error rate" color="#d64545" /> : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent slow operations" subtitle="Highest p95 operations — avg and p99 from the rolling window" />
          {q.loading ? (
            <CardBody><LoadingBlock rows={5} /></CardBody>
          ) : q.error ? (
            <ErrorState message={q.error} onRetry={q.refetch} />
          ) : q.data ? (
            <Collapser total={q.data.slowOperations.length} label="operations">
              {(visibleCount) => (
                <ul className="divide-y divide-ink-100">
                  {q.data!.slowOperations.slice(0, visibleCount).map((op) => (
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
              )}
            </Collapser>
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
          <Collapser total={visibleTraces.length} label="traces">
            {(visibleCount) => (
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
                    {visibleTraces.slice(0, visibleCount).map((t: TraceSpan) => (
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
          </Collapser>
        )}
      </Card>
    </div>
  )
}
