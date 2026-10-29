import { useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { UnavailablePanel, MetricNote } from '../components/UnavailablePanel'
import { Select } from '../components/ui/Input'
import { TrendLineChart } from '../components/charts'
import { observabilityService } from '../services/observability'
import { rayernService } from '../services/rayern'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPct,
  rayernReasonText,
  timeAgo,
  titleCase,
} from '../lib/utils'
import type { HealthStatus, RayernLogEntry, TraceSpan } from '../lib/types'

function tone(s: HealthStatus): 'green' | 'amber' | 'red' {
  return s === 'healthy' ? 'green' : s === 'degraded' ? 'amber' : 'red'
}

/** Maps a Rayern log level onto the badge tone used elsewhere in the UI. */
function levelTone(level: string | null): 'neutral' | 'amber' | 'red' {
  const value = (level ?? '').toLowerCase()
  if (value === 'error' || value === 'fatal' || value === 'critical') return 'red'
  if (value === 'warn' || value === 'warning') return 'amber'
  return 'neutral'
}

/** ISO timestamp for a bounded log range, or undefined for “all time”. */
function sinceIso(range: '24h' | '7d' | 'all'): string | undefined {
  const days = range === '24h' ? 1 : range === '7d' ? 7 : 0
  return days === 0 ? undefined : new Date(Date.now() - days * 86_400_000).toISOString()
}

/** Copies a request id so an operator can correlate it with Rayern's own logs. */
function RequestIdChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Copy request id ${value}`}
      onClick={() => {
        if (!navigator.clipboard?.writeText) return
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => undefined)
      }}
      className="inline-flex items-center gap-1.5 rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-[11px] text-ink-700 hover:border-ink-300 hover:bg-ink-100"
      title="Copy request id"
    >
      {value.slice(0, 12)}…
      <span className="font-sans text-[10px] font-semibold uppercase tracking-wide text-ink-500">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}

export function ObservabilityPage() {
  const q = useQuery(() => observabilityService.overview())
  const instQ = useQuery(() => rayernService.blocks())
  const [logLevel, setLogLevel] = useState<'all' | 'error' | 'warn'>('all')
  const [logRange, setLogRange] = useState<'24h' | '7d' | 'all'>('7d')
  const logsQ = useQuery(
    () => rayernService.logs({ limit: 200, level: logLevel === 'all' ? undefined : logLevel, since: sinceIso(logRange) }),
    [logLevel, logRange],
  )
  usePageRefresh([q, instQ, logsQ])
  const [traceFilter, setTraceFilter] = useState<string | null>(null)

  const endpointHealth = instQ.data?.blocks.endpointHealth ?? null
  const endpointReason = instQ.error
    ? `Instrumentation could not be loaded: ${instQ.error}`
    : rayernReasonText(endpointHealth === null ? 'not_reported' : endpointHealth.reason)

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
                    <td className="px-3 py-2.5"><StatusBadge tone={tone(s.status)}>{titleCase(s.status)}</StatusBadge></td>
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
          <CardHeader title="Error rate trend (24h)" subtitle="Hourly error percentage across services" />
          <CardBody>
            {q.loading ? <LoadingBlock rows={5} /> : q.error ? <ErrorState message={q.error} onRetry={q.refetch} /> : q.data ? <TrendLineChart data={q.data.errorRateTrend} dataKey="errorRatePct" name="Error rate" color="#d64545" /> : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent slow operations" subtitle="Highest p95 operations in the last hour" />
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
                    <p className="text-xs text-ink-500">{op.service} · {formatNumber(op.occurrences)}× · {timeAgo(op.lastSeenAt)}</p>
                  </div>
                  <span className="shrink-0 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">{formatDuration(op.p95)} p95</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>

      {/* ------------------ Rayern endpoint health (per route) ---------------- */}
      <Card>
        <CardHeader
          title="Endpoint health"
          subtitle="Rayern’s per-route request volume and latency over its telemetry window"
          actions={
            endpointHealth !== null && endpointHealth.available ? (
              <Badge tone="green">
                {endpointHealth.routes.length} route{endpointHealth.routes.length === 1 ? '' : 's'}
              </Badge>
            ) : (
              <Badge tone="neutral">Unavailable</Badge>
            )
          }
        />
        {instQ.loading ? (
          <CardBody>
            <LoadingBlock rows={5} />
          </CardBody>
        ) : instQ.error ? (
          <ErrorState message={instQ.error} onRetry={instQ.refetch} />
        ) : endpointHealth === null || !endpointHealth.available ? (
          <CardBody>
            <UnavailablePanel title="Endpoint health" reason={endpointReason} required="Rayern’s `endpointHealth` metrics block with OTEL_ENABLED set and enough samples." />
          </CardBody>
        ) : (
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Method</th>
                    <th scope="col" className="px-3 py-2.5">Route template</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Requests</th>
                    <th scope="col" className="px-3 py-2.5 text-right">2xx</th>
                    <th scope="col" className="px-3 py-2.5 text-right">4xx</th>
                    <th scope="col" className="px-3 py-2.5 text-right">5xx</th>
                    <th scope="col" className="px-3 py-2.5 text-right">p50</th>
                    <th scope="col" className="px-3 py-2.5 text-right">p95</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {endpointHealth.routes.map((r) => (
                    <tr
                      key={r.key}
                      className={`border-b border-ink-100 last:border-0 hover:bg-ink-50/70 ${
                        r.unmatched ? 'bg-amber-50/40' : ''
                      }`}
                    >
                      <td className="px-4 py-2.5">
                        <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-700">
                          {r.method || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[13px] text-ink-800">
                        {r.unmatched ? <span className="text-amber-700">{r.route}</span> : r.route}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{formatNumber(r.requests)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{formatNumber(r.ok2xx)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${r.err4xx > 0 ? 'text-amber-700' : 'text-ink-500'}`}>
                        {formatNumber(r.err4xx)}
                      </td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${r.err5xx > 0 ? 'text-red-600' : 'text-ink-500'}`}>
                        {formatNumber(r.err5xx)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-600">
                        {r.p50Ms !== null ? formatDuration(r.p50Ms) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-600">
                        {r.p95Ms !== null ? formatDuration(r.p95Ms) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-500">
                        {r.samples !== null ? formatCount(r.samples) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <MetricNote>
              {endpointHealth.windowMinutes !== null
                ? `Telemetry window: ${endpointHealth.windowMinutes} minutes. `
                : 'Telemetry window not reported. '}
              “UNMATCHED” buckets paths that matched no route template and is shown deliberately for diagnostics.
              Latency is “—” below the sample minimum — never a fabricated 0ms. This is internal telemetry, not proof of
              external availability or uptime; independent uptime evidence comes from the synthetic checks on System.
            </MetricNote>
          </CardBody>
        )}
      </Card>

      {/* --------------------------- Server log ------------------------------ */}
      <Card>
        <CardHeader
          title="Server log"
          subtitle="Sanitized 5xx and warning entries from Rayern’s bounded in-process log store"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Filter log level"
                value={logLevel}
                onChange={(e) => setLogLevel(e.target.value as 'all' | 'error' | 'warn')}
                className="w-32"
              >
                <option value="all">All levels</option>
                <option value="error">error</option>
                <option value="warn">warn</option>
              </Select>
              <Select
                aria-label="Filter log range"
                value={logRange}
                onChange={(e) => setLogRange(e.target.value as '24h' | '7d' | 'all')}
                className="w-32"
              >
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="all">All stored</option>
              </Select>
            </div>
          }
        />
        {logsQ.loading ? (
          <CardBody>
            <LoadingBlock rows={6} />
          </CardBody>
        ) : logsQ.error ? (
          <ErrorState message={logsQ.error} onRetry={logsQ.refetch} />
        ) : (logsQ.data?.entries.length ?? 0) === 0 ? (
          <CardBody>
            <EmptyState
              title="No log entries"
              description="The store only holds 5xx failures and explicit warnings over the last 7 days — an empty result means none matched, not that nothing was recorded."
            />
          </CardBody>
        ) : (
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-4 py-2.5">Timestamp</th>
                    <th scope="col" className="px-3 py-2.5">Level</th>
                    <th scope="col" className="px-3 py-2.5">Code</th>
                    <th scope="col" className="px-3 py-2.5">Request</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Status</th>
                    <th scope="col" className="px-3 py-2.5">Route</th>
                    <th scope="col" className="px-3 py-2.5">Message</th>
                    <th scope="col" className="px-3 py-2.5">Request ID</th>
                  </tr>
                </thead>
                <tbody>
                  {(logsQ.data?.entries ?? []).map((entry: RayernLogEntry, index: number) => (
                    <tr key={`${entry.requestId ?? 'log'}-${index}`} className="border-b border-ink-100 last:border-0 align-top">
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-600">
                        {entry.at ? formatDateTime(entry.at) : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={levelTone(entry.level)}>{entry.level ?? '—'}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-700">
                          {entry.code ?? '—'}
                        </code>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-ink-700">
                        {entry.method ?? '—'} <span className="text-ink-500">{entry.route ?? ''}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <code
                          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                            entry.status !== null && entry.status >= 500
                              ? 'bg-red-50 text-red-700'
                              : 'bg-ink-100 text-ink-700'
                          }`}
                        >
                          {entry.status ?? '—'}
                        </code>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-ink-700">{entry.route ?? '—'}</td>
                      <td className="max-w-[24rem] px-3 py-2.5">
                        <p className="text-ink-700">{entry.message ?? '—'}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        {entry.requestId ? (
                          <RequestIdChip value={entry.requestId} />
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <MetricNote>
              {logsQ.data?.meta.note}
              {' '}Message text is scrubbed by Rayern before storage and allow-listed by the dashboard proxy — no tokens,
              headers or request bodies are ever returned. Fetched {logsQ.data ? timeAgo(logsQ.data.meta.fetchedAt) : '—'}
              {logsQ.data?.meta.requestId ? ` (request ${logsQ.data.meta.requestId})` : ''}.
            </MetricNote>
          </CardBody>
        )}
      </Card>

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
