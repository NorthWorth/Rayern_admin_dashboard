import { useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { StatusBadge } from '../components/ui/Badge'
import { LoadingBlock, EmptyState, ErrorState } from '../components/ui/states'
import { TrendLineChart, VolumeBarChart } from '../components/charts'
import { Collapser } from '../components/Collapser'
import { systemService } from '../services/system'
import { useQuery } from '../hooks/useQuery'
import {
  clsx,
  formatCompact,
  formatDuration,
  formatNumber,
  formatPct,
  healthLabel,
  healthTone,
  timeAgo,
  titleCase,
} from '../lib/utils'
import type { HealthStatus, HistoryRange, RayernSyncStatus, ServiceHealth, SystemOverview } from '../lib/types'

/** KPI accent for the four-state model — `unknown` is neutral, never red. */
function kpiTone(status: HealthStatus | undefined): 'default' | 'green' | 'amber' | 'red' {
  if (!status) return 'default'
  const tone = healthTone(status)
  return tone === 'neutral' ? 'default' : tone
}

const RANGES: HistoryRange[] = ['24h', '7d', '30d']

type MetricKey = 'errorRatePct' | 'p95Ms' | 'requestCount' | 'availabilityPct'

const METRICS: Array<{ key: MetricKey; label: string; unit: string; color: string }> = [
  { key: 'errorRatePct', label: 'Error rate', unit: '%', color: '#d64545' },
  { key: 'p95Ms', label: 'Latency p95', unit: 'ms', color: '#1f6f54' },
  { key: 'requestCount', label: 'Request volume', unit: '', color: '#40464f' },
  { key: 'availabilityPct', label: 'Availability', unit: '%', color: '#1f6f54' },
]

interface DrillTarget {
  key: string
  label: string
}

export function SystemPage() {
  const q = useQuery(() => systemService.overview())

  // Drill-down: Platform → Service → Metric → Time range.
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const [metric, setMetric] = useState<MetricKey>('errorRatePct')
  const [range, setRange] = useState<HistoryRange>('24h')
  const historyQ = useQuery(
    drill ? () => systemService.history(drill.key, range) : null,
    [drill?.key, range],
  )

  const [transitionRange, setTransitionRange] = useState<HistoryRange>('24h')
  const transitionsQ = useQuery(() => systemService.transitions(transitionRange), [transitionRange])

  const overallLabel = q.data ? (q.data.overall === 'unknown' ? 'No data' : titleCase(q.data.overall)) : '—'

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Overall status"
          value={overallLabel}
          tone={kpiTone(q.data?.overall)}
          sub={
            q.data
              ? q.data.overall === 'unknown'
                ? 'No recent telemetry — health unconfirmed'
                : 'Derived from live telemetry + thresholds'
              : undefined
          }
        />
        <KpiCard label="Requests (24h)" value={q.data ? formatCompact(q.data.requestCount24h) : '—'} />
        <KpiCard
          label="Error rate"
          value={q.data ? (q.data.errorRatePct === null ? '—' : formatPct(q.data.errorRatePct, 2)) : '—'}
          tone={q.data && q.data.errorRatePct !== null && q.data.errorRatePct > 1 ? 'red' : 'default'}
          sub="5xx share of requests (24h)"
        />
        <KpiCard
          label="Latency p95"
          value={q.data ? (q.data.latency.p95 === null ? '—' : formatDuration(q.data.latency.p95)) : '—'}
          sub={
            q.data && q.data.latency.p50 !== null && q.data.latency.p99 !== null
              ? `p50 ${formatDuration(q.data.latency.p50)} · p99 ${formatDuration(q.data.latency.p99)} · ${formatCompact(q.data.requestCount24h)} requests`
              : undefined
          }
        />
      </div>

      {q.data ? <OverallSummaryCard summary={q.data.overallSummary} overall={q.data.overall} /> : null}

      <SyncStatusCard sync={q.data?.sync} metricsSync={q.data?.metricsSync} loading={q.loading} error={q.error} onRetry={q.refetch} />

      {/* ------------------------- Service overview + drill-down ------------------------ */}
      <Card>
        <CardHeader
          title="Service overview"
          subtitle="Health, freshness and key metrics per service — computed by the backend. Click a service with history to drill down."
        />
        {q.loading ? (
          <CardBody><LoadingBlock rows={7} /></CardBody>
        ) : q.error ? (
          <ErrorState message={q.error} onRetry={q.refetch} />
        ) : q.data ? (
          <>
            <Collapser total={q.data.services.length} label="services">
              {(visibleCount) => (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Service</th>
                    <th scope="col" className="px-3 py-2.5">Health</th>
                    <th scope="col" className="px-3 py-2.5">Freshness</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Availability</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Requests</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Error rate</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Latency p95</th>
                    <th scope="col" className="px-3 py-2.5">Last change</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data!.services.slice(0, visibleCount).map((s) => (
                    <ServiceRow
                      key={s.id}
                      service={s}
                      active={drill?.key === s.historyKey}
                      onDrill={s.historyKey ? () => setDrill({ key: s.historyKey as string, label: s.name }) : undefined}
                    />
                  ))}
                </tbody>
              </table>
            </div>
              )}
            </Collapser>

            {drill ? (
              <div className="border-t border-ink-200 bg-ink-50/50 px-4 py-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink-900">{drill.label}</span>
                    <span className="text-xs text-ink-500">→ metric & time range</span>
                    <select
                      value={metric}
                      onChange={(e) => setMetric(e.target.value as MetricKey)}
                      aria-label="Metric"
                      className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs text-ink-800 focus:border-ink-400 focus:outline-none focus:ring-2 focus:ring-ink-200"
                    >
                      {METRICS.map((m) => (
                        <option key={m.key} value={m.key}>{m.label}</option>
                      ))}
                    </select>
                    <div className="inline-flex rounded-md border border-ink-200 bg-white p-0.5" role="group" aria-label="Time range">
                      {RANGES.map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setRange(r)}
                          aria-pressed={range === r}
                          className={clsx(
                            'rounded px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300',
                            range === r ? 'bg-ink-900 text-white' : 'text-ink-600 hover:text-ink-900',
                          )}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDrill(null)}
                    className="text-xs font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline"
                  >
                    Close
                  </button>
                </div>
                {historyQ.loading ? (
                  <LoadingBlock rows={4} />
                ) : historyQ.error ? (
                  <ErrorState message={historyQ.error} onRetry={historyQ.refetch} />
                ) : historyQ.data ? (
                  <DrillChart data={historyQ.data.points} metric={metric} range={range} />
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </Card>

      {/* ------------------------------ Dependencies ------------------------------ */}
      <Card>
        <CardHeader
          title="Dependency health"
          subtitle="Real dependencies of the dashboard backend — PostgreSQL, the Rayern metrics endpoint, and Resend"
        />
        {q.loading ? (
          <CardBody><LoadingBlock rows={4} /></CardBody>
        ) : q.error ? (
          <ErrorState message={q.error} onRetry={q.refetch} />
        ) : q.data ? (
          <Collapser total={q.data.dependencies.length} label="dependencies">
            {(visibleCount) => (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-4 py-2.5">Dependency</th>
                  <th scope="col" className="px-3 py-2.5">State</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Availability</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Requests</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Errors</th>
                  <th scope="col" className="px-3 py-2.5 text-right">p95</th>
                  <th scope="col" className="px-3 py-2.5">Last success</th>
                  <th scope="col" className="px-3 py-2.5">Last failure</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.dependencies.slice(0, visibleCount).map((d) => {
                  const active = drill?.key === d.historyKey
                  return (
                    <tr
                      key={d.id}
                      className={clsx(
                        'border-b border-ink-100 last:border-0',
                        d.historyKey ? 'cursor-pointer hover:bg-ink-50/70' : 'hover:bg-ink-50/70',
                        active && 'bg-accent-soft/40',
                      )}
                      onClick={
                        d.historyKey
                          ? () => setDrill(active ? null : { key: d.historyKey as string, label: d.name })
                          : undefined
                      }
                    >
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-ink-900">{d.name}</p>
                        <p className="text-[11px] text-ink-500">
                          {titleCase(d.kind)}
                          {!d.configured ? ' · not configured' : ''} · {d.detail.map((x) => `${x.label}: ${x.value}`).join(' · ')}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusBadge tone={healthTone(d.status)}>{healthLabel(d.status)}</StatusBadge>
                        {d.reason ? (
                          <p className="mt-0.5 max-w-[16rem] truncate text-[11px] text-ink-400" title={d.reason}>{d.reason}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-right text-ink-700">
                        {d.availabilityPct === null ? <span className="text-ink-400">—</span> : formatPct(d.availabilityPct, 2)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-ink-700">{d.requestCount === null ? '—' : formatNumber(d.requestCount)}</td>
                      <td className={clsx('px-3 py-2.5 text-right font-medium', d.errorCount ? 'text-red-600' : 'text-ink-700')}>
                        {d.errorCount === null ? '—' : formatNumber(d.errorCount)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-ink-700">{d.p95Ms === null ? '—' : formatDuration(d.p95Ms)}</td>
                      <td className="px-3 py-2.5 text-ink-600">{d.lastSuccessAt ? timeAgo(d.lastSuccessAt) : <span className="text-ink-400">never</span>}</td>
                      <td className="px-3 py-2.5 text-ink-600">
                        {d.lastFailureAt ? <span className="text-red-600">{timeAgo(d.lastFailureAt)}</span> : <span className="text-ink-400">none on record</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
            )}
          </Collapser>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Request volume (24h)" subtitle="Requests per hour, with 5xx errors" />
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
          <CardHeader title="Latency percentiles" subtitle="Across the dashboard API (24h)" />
          <CardBody className="space-y-3">
            {q.data ? (
              (['p50', 'p90', 'p95', 'p99'] as const).map((k) => {
                // null = no measured requests — show "—" instead of a fake 0ms bar.
                const value = q.data?.latency[k] ?? null
                const max = 500
                const width = value === null ? 0 : Math.min(100, (value / max) * 100)
                return (
                  <div key={k}>
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="font-medium uppercase text-ink-600">{k}</span>
                      <span className="font-semibold text-ink-900">{value === null ? '—' : `${value}ms`}</span>
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

      {/* ---------------------------- Health transitions --------------------------- */}
      <Card>
        <CardHeader
          title="Health transitions"
          subtitle="When a service entered or recovered from an unhealthy state — one row per genuine change"
          actions={
            <div className="inline-flex rounded-md border border-ink-200 bg-white p-0.5" role="group" aria-label="Transition time range">
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setTransitionRange(r)}
                  aria-pressed={transitionRange === r}
                  className={clsx(
                    'rounded px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300',
                    transitionRange === r ? 'bg-ink-900 text-white' : 'text-ink-600 hover:text-ink-900',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          }
        />
        {transitionsQ.loading ? (
          <CardBody><LoadingBlock rows={4} /></CardBody>
        ) : transitionsQ.error ? (
          <ErrorState message={transitionsQ.error} onRetry={transitionsQ.refetch} />
        ) : (transitionsQ.data ?? []).length === 0 ? (
          <EmptyState
            title="No state changes in this range"
            description="Transitions appear when a service crosses a configured health threshold, recovers, or runs out of fresh telemetry."
          />
        ) : (
          <Collapser total={(transitionsQ.data ?? []).length} label="transitions">
            {(visibleCount) => (
          <ul className="divide-y divide-ink-100">
            {(transitionsQ.data ?? []).slice(0, visibleCount).map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="min-w-[9rem] font-medium text-ink-900">{t.service}</span>
                <span className="flex items-center gap-1.5">
                  <StatusBadge tone={healthTone(t.from)}>{healthLabel(t.from)}</StatusBadge>
                  <span className="text-ink-400" aria-hidden="true">→</span>
                  <StatusBadge tone={healthTone(t.to)}>{healthLabel(t.to)}</StatusBadge>
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-600" title={t.reason}>
                  {t.reason}
                  {t.metric && t.metricValue !== null ? (
                    <span className="ml-1 font-mono text-[11px] text-ink-400">({t.metric}={t.metricValue})</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-ink-500">{timeAgo(t.at)}</span>
              </li>
            ))}
          </ul>
            )}
          </Collapser>
        )}
      </Card>

      {/* -------------------------------- Runtime --------------------------------- */}
      <RuntimeCard overview={q.data} loading={q.loading} />

      <Card>
        <CardHeader title="Recent failures" subtitle="Aggregated failures across services (24h) — first/last seen, normalized routes" />
        {q.loading ? (
          <CardBody><LoadingBlock rows={3} /></CardBody>
        ) : q.error ? (
          <ErrorState message={q.error} onRetry={q.refetch} />
        ) : q.data ? (
          q.data.recentFailures.length === 0 ? (
            <EmptyState title="No failures recorded" description="High-severity errors and 5xx responses will appear here." />
          ) : (
          <Collapser total={q.data!.recentFailures.length} label="failures">
            {(visibleCount) => (
          <ul className="divide-y divide-ink-100">
            {q.data!.recentFailures.slice(0, visibleCount).map((f) => (
              <li key={f.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">{f.service}</p>
                  {f.route ? (
                    <p className="truncate font-mono text-xs text-ink-700" title={f.route}>{f.route}</p>
                  ) : null}
                  <p className="truncate text-xs text-ink-600" title={f.message}>{f.message}</p>
                  <p className="mt-0.5 text-[11px] text-ink-400">
                    First seen: {timeAgo(f.firstSeenAt)} · Last seen: {timeAgo(f.lastSeenAt)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-medium text-red-600">
                    {f.statusCategory} · {formatNumber(f.count)} occurrence{f.count === 1 ? '' : 's'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
            )}
          </Collapser>
          )
        ) : null}
      </Card>
    </div>
  )
}

/* --------------------------- Overall summary card -------------------------- */

/** Spec §21: overall status is explainable — the backend supplies the rollup. */
function OverallSummaryCard({
  summary,
  overall,
}: {
  summary: { failing: string[]; degraded: string[]; healthy: number; unknown: number }
  overall: HealthStatus
}) {
  const parts: string[] = []
  if (summary.failing.length > 0) parts.push(`${summary.failing.length} failing`)
  if (summary.degraded.length > 0) parts.push(`${summary.degraded.length} degraded`)
  if (summary.healthy > 0) parts.push(`${summary.healthy} healthy`)
  if (summary.unknown > 0) parts.push(`${summary.unknown} no data`)
  const headline = summary.failing.length > 0
    ? `Failing — ${summary.failing.join(', ')} ${summary.failing.length === 1 ? 'is' : 'are'} failing.`
    : summary.degraded.length > 0
      ? `Degraded — ${summary.degraded.join(', ')} ${summary.degraded.length === 1 ? 'is' : 'are'} degraded.`
      : overall === 'unknown'
        ? 'No recent telemetry — health unconfirmed.'
        : 'All monitored signals within thresholds.'
  return (
    <Card>
      <CardBody className="py-3">
        <p className="text-sm text-ink-700">
          <span className="font-semibold text-ink-900">{healthLabel(overall)}</span>
          <span className="mx-2 text-ink-300" aria-hidden="true">·</span>
          {parts.join(' · ') || 'no signals'}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">{headline}</p>
      </CardBody>
    </Card>
  )
}

/* ------------------------------- Service row ------------------------------- */

function ServiceRow({
  service: s,
  active,
  onDrill,
}: {
  service: ServiceHealth
  active: boolean
  onDrill?: () => void
}) {
  return (
    <tr
      className={clsx(
        'border-b border-ink-100 last:border-0 hover:bg-ink-50/70',
        onDrill && 'cursor-pointer',
        active && 'bg-accent-soft/40',
      )}
      onClick={onDrill}
    >
      <td className="px-4 py-2.5">
        <p className="font-medium text-ink-900">{s.name}</p>
        <p className="text-[11px] text-ink-400">
          {titleCase(s.kind)} · {s.dataSource === 'self' ? 'observed directly' : 'from Rayern sync'}
        </p>
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge tone={healthTone(s.status)}>{healthLabel(s.status)}</StatusBadge>
        {s.reportedStatus ? (
          <p className="mt-0.5 text-[11px] text-ink-400">Rayern reported {healthLabel(s.reportedStatus).toLowerCase()}</p>
        ) : null}
        {s.reason ? <p className="mt-0.5 max-w-[14rem] truncate text-[11px] text-ink-400" title={s.reason}>{s.reason}</p> : null}
      </td>
      <td className="px-3 py-2.5">
        <FreshnessCell status={s.freshness.status} lastAt={s.freshness.lastTelemetryAt} />
      </td>
      <td className="px-3 py-2.5 text-right text-ink-700">
        {s.uptimePct30d === null ? <span className="text-ink-400">—</span> : formatPct(s.uptimePct30d, 2)}
      </td>
      <td className="px-3 py-2.5 text-right text-ink-700">
        {s.requestCount === null ? <span className="text-ink-400">—</span> : `${formatCompact(s.requestCount)}${s.rpm ? ` · ${s.rpm}/m` : ''}`}
      </td>
      <td className={clsx('px-3 py-2.5 text-right font-medium', s.errorRatePct !== null && s.errorRatePct >= 1 ? 'text-red-600' : 'text-ink-700')}>
        {s.errorRatePct === null ? <span className="font-normal text-ink-400">—</span> : formatPct(s.errorRatePct, 2)}
      </td>
      <td className="px-3 py-2.5 text-right text-ink-700">
        {s.latencyMsP95 === null ? <span className="text-ink-400">—</span> : formatDuration(s.latencyMsP95)}
      </td>
      <td className="px-3 py-2.5">
        {s.lastChange ? (
          <div className="text-xs">
            <span className="font-medium text-ink-700">{healthLabel(s.lastChange.from)} → {healthLabel(s.lastChange.to)}</span>
            <p className="text-[11px] text-ink-500">{timeAgo(s.lastChange.at)}</p>
          </div>
        ) : (
          <span className="text-xs text-ink-400">—</span>
        )}
      </td>
    </tr>
  )
}

function FreshnessCell({ status, lastAt }: { status: 'fresh' | 'stale' | 'none'; lastAt: string | null }) {
  if (status === 'none' || !lastAt) {
    return <span className="text-xs text-ink-400">No telemetry</span>
  }
  if (status === 'stale') {
    return (
      <span className="text-xs font-medium text-amber-700" title={`Last telemetry: ${new Date(lastAt).toLocaleString()}`}>
        Stale · {timeAgo(lastAt)}
      </span>
    )
  }
  return (
    <span className="text-xs text-ink-500" title={`Last telemetry: ${new Date(lastAt).toLocaleString()}`}>
      {timeAgo(lastAt)}
    </span>
  )
}

/* -------------------------------- Drill chart ------------------------------ */

function DrillChart({
  data,
  metric,
  range,
}: {
  data: Array<{ time: string; requestCount: number; errorRatePct: number | null; availabilityPct: number | null; p95Ms: number | null }>
  metric: MetricKey
  range: HistoryRange
}) {
  const hasAny = data.some((p) => p[metric] !== null && p[metric] !== undefined)
  if (!hasAny) {
    return (
      <EmptyState
        title="No telemetry in this range"
        description="History appears once the backend has observed traffic for this service. Absence of data is never shown as 0."
      />
    )
  }
  if (metric === 'requestCount') {
    return (
      <VolumeBarChart
        data={data.map((p) => ({
          time: range === '30d' ? p.time.slice(5, 10) : `${new Date(p.time).getHours()}:00`,
          count: p.requestCount,
        }))}
        xKey="time"
        series={[{ key: 'count', name: 'Requests', color: '#40464f' }]}
      />
    )
  }
  const cfg = METRICS.find((m) => m.key === metric) ?? { label: 'Metric', unit: '', color: '#1f6f54' }
  return (
    <TrendLineChart
      data={data.map((p) => ({
        time: range === '30d' ? p.time.slice(0, 10) : p.time,
        value: p[metric],
      }))}
      dataKey="value"
      name={cfg.label}
      color={cfg.color}
      unit={cfg.unit}
    />
  )
}

/* -------------------------------- Runtime card ----------------------------- */

function RuntimeCard({ overview, loading }: { overview: SystemOverview | null; loading: boolean }) {
  const meta = overview?.meta
  const fmtBytes = (b: number): string => `${(b / (1024 * 1024)).toFixed(1)} MB`
  const items: Array<{ label: string; value: string }> = meta
    ? [
        { label: 'Process uptime', value: formatDuration(meta.processUptimeSec * 1000) },
        { label: 'CPU (60s avg)', value: meta.cpuPercent === null ? '—' : formatPct(meta.cpuPercent, 1) },
        { label: 'Event loop p95', value: meta.eventLoopDelayP95Ms === null ? '—' : formatDuration(meta.eventLoopDelayP95Ms) },
        { label: 'Memory (RSS)', value: fmtBytes(meta.rssBytes) },
        { label: 'Heap', value: `${fmtBytes(meta.heapUsedBytes)} / ${fmtBytes(meta.heapTotalBytes)}` },
        { label: 'DB probe', value: `${meta.dbLatencyMs}ms` },
        { label: 'DB pool', value: `${meta.pool.total} open · ${meta.pool.idle} idle · ${meta.pool.waiting} waiting` },
        { label: 'Telemetry stale after', value: formatDuration(meta.telemetryStaleMs) },
        {
          label: 'Thresholds (error rate)',
          value: `degraded ≥ ${meta.healthThresholds.errorRateDegradedPct}% · failing ≥ ${meta.healthThresholds.errorRateFailingPct}%`,
        },
        {
          label: 'Thresholds (p95 latency)',
          value: `degraded ≥ ${meta.healthThresholds.latencyP95DegradedMs}ms · failing ≥ ${meta.healthThresholds.latencyP95FailingMs}ms`,
        },
      ]
    : []
  return (
    <Card>
      <CardHeader title="Runtime & health thresholds" subtitle="Process health and the configured values every status is derived from" />
      <CardBody>
        {!overview && loading ? (
          <LoadingBlock rows={3} />
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-500">Runtime telemetry unavailable.</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((it) => (
              <div key={it.label} className="flex items-baseline justify-between gap-3 rounded-md border border-ink-100 bg-ink-50/60 px-3 py-2">
                <dt className="text-xs text-ink-500">{it.label}</dt>
                <dd className="text-xs font-semibold text-ink-800">{it.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardBody>
    </Card>
  )
}

/* ------------------------------- Sync status ------------------------------- */

function SyncStatusCard({
  sync,
  metricsSync,
  loading,
  error,
  onRetry,
}: {
  sync: RayernSyncStatus | undefined
  metricsSync: { status: HealthStatus; reason: string; dataAgeMs: number | null } | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  return (
    <Card>
      <CardHeader
        title="Rayern synchronization"
        subtitle="The dashboard periodically pulls approved aggregates from the Rayern API — Rayern never calls the dashboard"
      />
      <CardBody>
        {loading ? (
          <LoadingBlock rows={2} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !sync ? (
          <p className="text-sm text-ink-500">Sync status unavailable.</p>
        ) : !sync.enabled ? (
          <p className="text-sm text-ink-500">
            Synchronization is not configured yet. Set <code className="rounded bg-ink-100 px-1 text-xs">RAYERN_SYNC_ENDPOINT</code> and
            <code className="ml-1 rounded bg-ink-100 px-1 text-xs">RAYERN_MONITORING_TOKEN</code> on the dashboard backend to enable
            periodic pulls of approved aggregate data.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <StatusBadge tone={healthTone(sync.status)}>{healthLabel(sync.status)}</StatusBadge>
              <span className="text-ink-600">
                Last successful pull:{' '}
                <span className="font-medium text-ink-800">{sync.lastSuccessAt ? timeAgo(sync.lastSuccessAt) : 'never'}</span>
              </span>
              <span className="text-ink-600">
                Last attempt: <span className="font-medium text-ink-800">{sync.lastAttemptAt ? timeAgo(sync.lastAttemptAt) : 'never'}</span>
              </span>
              {sync.consecutiveFailures > 0 ? (
                <span className="font-medium text-red-600">{sync.consecutiveFailures} consecutive failures</span>
              ) : null}
              {sync.stale ? <span className="font-medium text-amber-600">Data may be stale</span> : null}
              {sync.rateLimitedUntil ? (
                <span className="font-medium text-amber-600" title="HTTP 429 back-off — the next pull waits for the scheduled interval">
                  Rate limited until {new Date(sync.rateLimitedUntil).toLocaleTimeString()}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-600">
              <span>Interval: <span className="font-medium text-ink-800">{Math.round(sync.intervalMs / 60_000)}m</span></span>
              <span>Last pull duration: <span className="font-medium text-ink-800">{sync.lastDurationMs === null ? '—' : `${sync.lastDurationMs}ms`}</span></span>
              <span>Last HTTP status: <span className={clsx('font-medium', sync.lastHttpStatus !== null && sync.lastHttpStatus >= 400 ? 'text-red-600' : 'text-ink-800')}>{sync.lastHttpStatus ?? '—'}</span></span>
              <span title="Last time valid aggregate data was written — failed pulls never move it">
                Data updated: <span className="font-medium text-ink-800">{sync.dataUpdatedAt ? timeAgo(sync.dataUpdatedAt) : 'never'}</span>
              </span>
            </div>
            {sync.lastError ? (
              <p className="truncate text-xs text-red-600" title={sync.lastError}>Last error: {sync.lastError}</p>
            ) : null}
            {sync.stale && sync.dataUpdatedAt ? (
              <p className="text-xs text-amber-700">
                Showing the last known good data ({timeAgo(sync.dataUpdatedAt)}) — not a live confirmation of health.
              </p>
            ) : null}
            {/* Spec §17: the metrics-pull process as its OWN signal — a 429
                means Rayern is reachable but rate-limiting THIS pull; it says
                nothing about Rayern API health (see the services table). */}
            {metricsSync ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ink-100 pt-2.5 text-xs">
                <span className="font-semibold text-ink-700">Metrics sync:</span>
                <StatusBadge tone={healthTone(metricsSync.status)}>{healthLabel(metricsSync.status)}</StatusBadge>
                <span className="text-ink-600" title={metricsSync.reason}>{metricsSync.reason}</span>
                {metricsSync.dataAgeMs !== null ? (
                  <span className="text-ink-500">Data age: {formatDuration(metricsSync.dataAgeMs)}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
