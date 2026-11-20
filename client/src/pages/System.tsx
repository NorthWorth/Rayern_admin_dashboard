import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { StatusBadge } from '../components/ui/Badge'
import { EmptyState, LoadingBlock, ErrorState } from '../components/ui/states'
import { UnavailablePanel } from '../components/UnavailablePanel'
import { RequestIdChip } from '../components/RequestIdChip'
import { VolumeBarChart } from '../components/charts'
import { systemService } from '../services/system'
import { rayernService } from '../services/rayern'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import {
  clsx,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPct,
  rayernReasonText,
  timeAgo,
  titleCase,
} from '../lib/utils'
import type {
  DependencyConfigBlock,
  HealthStatus,
  RayernSyncStatus,
  SchedulerStatusResponse,
  SyncDiagnostic,
  SyncDiagnosticsResponse,
  SyntheticMonitoringBlock,
} from '../lib/types'

function tone(s: HealthStatus): 'green' | 'amber' | 'red' {
  return s === 'healthy' ? 'green' : s === 'degraded' ? 'amber' : 'red'
}

export function SystemPage() {
  const q = useQuery(() => systemService.overview())
  // Rayern instrumentation blocks + on-demand synthetic probe results, both
  // proxied by the dashboard backend (the browser never calls Rayern).
  const blocksQ = useQuery(() => rayernService.blocks())
  const syntheticQ = useQuery(() => rayernService.syntheticMonitoring())
  // Failures this backend hit while calling Rayern — captured at the outbound
  // HTTP layer, which is the only place a server-to-server failure is visible.
  const diagnosticsQ = useQuery(() => rayernService.syncDiagnostics(50))
  // Independent scheduler status, proxied server-side (no browser credential).
  const schedulerQ = useQuery(() => systemService.scheduler())
  usePageRefresh([q, blocksQ, syntheticQ, diagnosticsQ, schedulerQ])

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

      <SyncStatusCard sync={q.data?.sync} loading={q.loading} error={q.error} onRetry={q.refetch} />

      <SchedulerCard
        data={schedulerQ.data ?? undefined}
        loading={schedulerQ.loading}
        error={schedulerQ.error}
        onRetry={schedulerQ.refetch}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <DependencyConfigCard
          config={blocksQ.data?.blocks.dependencyConfig ?? null}
          received={blocksQ.data?.received ?? []}
          loading={blocksQ.loading}
          error={blocksQ.error}
          onRetry={blocksQ.refetch}
        />
        <SyntheticCard
          data={syntheticQ.data?.synthetic ?? null}
          note={syntheticQ.data?.meta.note ?? null}
          loading={syntheticQ.loading}
          error={syntheticQ.error}
          onRetry={syntheticQ.refetch}
        />
      </div>

      <SyncDiagnosticsCard
        data={diagnosticsQ.data ?? null}
        loading={diagnosticsQ.loading}
        error={diagnosticsQ.error}
        onRetry={diagnosticsQ.refetch}
      />

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

/**
 * Rayern dependency configuration — presence flags only. Configuration
 * presence is deliberately NOT presented as operational health: a service
 * with an API key set can still be down, and a service without one is simply
 * not wired up yet.
 */
function DependencyConfigCard({
  config,
  received,
  loading,
  error,
  onRetry,
}: {
  config: DependencyConfigBlock | null
  received: string[]
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  return (
    <Card>
      <CardHeader
        title="Dependency configuration"
        subtitle="Whether Rayern has each integration configured — presence only, never secret values, and not a health check"
      />
      <CardBody>
        {loading ? (
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !config || !config.available ? (
          <UnavailablePanel
            title="Dependency configuration not reported"
            reason={
              !config
                ? received.length > 0
                  ? 'Rayern has not sent a `dependencyConfig` block in the last synchronized payload, so nothing is displayed.'
                  : 'No instrumentation payload has been synchronized yet — the pull-sync has not run against a Rayern endpoint that returns these blocks.'
                : 'Rayern reported this block as unavailable (its aggregation failed upstream), so no configuration flags are shown.'
            }
            required="The `dependencyConfig` metrics block inside GET /internal/dashboard-metrics, synchronized by the pull-sync worker."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {config.items.map((item) => (
              <li key={`${item.group}:${item.name}`} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-ink-800">{item.label}</p>
                  <p className="text-xs text-ink-500">
                    {titleCase(item.group)}
                    {item.detail ? ` · ${item.detail}` : ''}
                  </p>
                </div>
                <span
                  className={clsx(
                    'inline-flex shrink-0 items-center gap-1.5 text-xs font-medium',
                    item.configured === true ? 'text-ink-700' : 'text-ink-400',
                  )}
                >
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 rounded-full',
                      item.configured === true ? 'bg-champagne-500' : 'bg-ink-300',
                    )}
                    aria-hidden="true"
                  />
                  {item.configured === null ? 'Unknown' : item.configured ? 'Configured' : 'Not configured'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {config?.available ? (
          <p className="mt-3 text-xs text-ink-500">
            Configured means an environment value exists — it does not prove the integration is reachable or working, and no
            secret values are ever retrieved or displayed.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}

/**
 * External synthetic probe results (recorded by scripts/synthetic-monitor.mjs,
 * which must be scheduled externally). "No checks yet" is never reported as
 * healthy, and no uptime percentage is invented from missing history.
 */
function SyntheticCard({
  data,
  note,
  loading,
  error,
  onRetry,
}: {
  data: SyntheticMonitoringBlock | null
  note: string | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  return (
    <Card>
      <CardHeader
        title="Synthetic monitoring"
        subtitle="Independent external probes of public endpoints — recorded by a separately scheduled script"
      />
      <CardBody className="space-y-4">
        {loading ? (
          <LoadingBlock rows={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !data ? (
          <p className="text-sm text-ink-500">Synthetic check results are not available yet.</p>
        ) : !data.available ? (
          <UnavailablePanel
            title="No synthetic checks recorded"
            reason={
              data.reason === 'no_checks_run'
                ? 'The external probe script has not run against this environment yet, so there is nothing to report. Missing checks are not treated as healthy.'
                : rayernReasonText(data.reason)
            }
            required="Schedule scripts/synthetic-monitor.mjs with cron/CI and set RAYERN_API_BASE_URL (plus the database URI) in that environment."
          />
        ) : (
          <>
            <ul className="divide-y divide-ink-100">
              {data.checks.map((c) => (
                <li key={c.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs font-medium text-ink-800">{c.name}</p>
                    <p className="text-xs text-ink-500">
                      {c.lastSuccessAt ? `Last success ${timeAgo(c.lastSuccessAt)}` : 'No successful check yet'}
                      {c.lastFailureAt ? ` · last failure ${timeAgo(c.lastFailureAt)}` : ''}
                      {c.lastRecoveredAt ? ` · recovered ${timeAgo(c.lastRecoveredAt)}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs">
                    {typeof c.httpStatus === 'number' ? <span className="text-ink-600">HTTP {c.httpStatus}</span> : null}
                    {typeof c.latencyMs === 'number' ? <span className="text-ink-600">{c.latencyMs}ms</span> : null}
                    <StatusBadge tone={c.status === 'up' ? 'green' : 'red'}>
                      {titleCase(c.status || 'unknown')}
                    </StatusBadge>
                    {(c.consecutiveFailures ?? 0) > 0 ? (
                      <span className="font-medium text-red-600">{c.consecutiveFailures}× in a row</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
              <span>
                Last check: <span className="font-medium text-ink-800">{data.lastCheckedAt ? timeAgo(data.lastCheckedAt) : '—'}</span>
              </span>
              <span>
                Last successful check:{' '}
                <span className="font-medium text-ink-800">
                  {data.lastSuccessfulCheckAt ? timeAgo(data.lastSuccessfulCheckAt) : '—'}
                </span>
              </span>
            </div>
            <p className="text-xs leading-relaxed text-ink-500">
              {note ?? 'Results come from an external scheduler running the probe script — the dashboard only displays what it recorded.'}{' '}
              Until that scheduler is configured and verified, these checks are not continuous monitoring, and no historical
              uptime percentage is claimed.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  )
}

/** Tone/label for an outbound failure class. Colour never carries the meaning alone. */
function diagnosticTone(outcome: SyncDiagnostic['outcome']): 'red' | 'amber' | 'neutral' {
  if (outcome === 'http_error') return 'red'
  if (outcome === 'timeout' || outcome === 'network_error') return 'amber'
  return 'neutral'
}

function diagnosticLabel(outcome: SyncDiagnostic['outcome']): string {
  switch (outcome) {
    case 'http_error':
      return 'HTTP error'
    case 'network_error':
      return 'Network error'
    case 'timeout':
      return 'Timeout'
    default:
      return 'Invalid response'
  }
}

/**
 * Server-side Rayern sync diagnostics.
 *
 * These records come from the outbound HTTP call itself, so they show what the
 * browser cannot: the upstream status, the response excerpt, `Retry-After` /
 * `Server` / `X-*` headers and the correlation id of a failed pull. They are
 * sanitized before storage — no token, cookie or authorization header.
 */
function SyncDiagnosticsCard({
  data,
  loading,
  error,
  onRetry,
}: {
  data: SyncDiagnosticsResponse | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const diagnostics = data?.diagnostics ?? []

  return (
    <Card>
      <CardHeader
        title="Rayern sync diagnostics"
        subtitle="Failed outbound requests captured on the dashboard backend — the attempts a browser-side error can never show"
        actions={
          data ? (
            <span className="whitespace-nowrap text-xs text-ink-500">
              newest {diagnostics.length} of {data.meta.maxEntries} retained
            </span>
          ) : null
        }
      />
      <CardBody>
        {loading ? (
          <LoadingBlock rows={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !data ? (
          <p className="text-sm text-ink-500">Sync diagnostics are not available.</p>
        ) : diagnostics.length === 0 ? (
          <EmptyState
            title="No failed Rayern requests recorded"
            description="Nothing has failed since this diagnostic store was last cleared. Only failures are stored — successful pulls are not logged here."
          />
        ) : (
          <>
            <ul className="divide-y divide-ink-100">
              {diagnostics.map((d) => (
                <li key={d.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <StatusBadge tone={diagnosticTone(d.outcome)}>{diagnosticLabel(d.outcome)}</StatusBadge>
                    <span className="font-mono text-xs font-medium text-ink-800">
                      {d.method} {d.endpoint}
                    </span>
                    <span className="text-xs text-ink-500">
                      {d.status !== null ? `HTTP ${d.status}` : 'no response'} · {formatDuration(d.durationMs)} · {d.host}
                      {d.reachedApplication === null
                        ? ''
                        : d.reachedApplication
                          ? ' · reached Express app'
                          : ' · did NOT reach Express app (edge/proxy)'}
                    </span>
                    <span className="ml-auto whitespace-nowrap text-xs text-ink-500" title={formatDateTime(d.occurredAt)}>
                      {timeAgo(d.occurredAt)}
                    </span>
                  </div>

                  <p className="mt-1 text-xs leading-relaxed text-ink-700">
                    <span className="font-mono text-[11px] text-ink-500">{d.errorCode ?? 'ERROR'}</span> · {d.message}
                  </p>

                  {d.responseBody ? (
                    <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-200 bg-ink-50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-700">
                      {d.responseBody}
                    </pre>
                  ) : null}

                  {d.finalUrl ? (
                    <p className="mt-1 font-mono text-[11px] text-ink-500 break-all">final URL: {d.finalUrl}</p>
                  ) : null}
                  {d.startedAt ? (
                    <p className="font-mono text-[11px] text-ink-500">request started: {formatDateTime(d.startedAt)}</p>
                  ) : null}

                  {(Object.keys(d.headers).length > 0 || d.requestId) ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {Object.entries(d.headers).map(([name, value]) => (
                        <span
                          key={name}
                          className="rounded border border-ink-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-ink-600"
                        >
                          {name}: {value}
                        </span>
                      ))}
                      {d.requestId ? <RequestIdChip value={d.requestId} /> : null}
                      <span className="text-[11px] uppercase tracking-wide text-ink-400">{[d.source === 'sync' ? 'pull-sync' : 'internal proxy']}</span>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-ink-500">
              These are outbound attempts against Rayern, not browser API failures. Bodies and headers are sanitized
              server-side before storage, the monitoring token and authorization headers are never recorded, and only the
              newest {data.meta.maxEntries} failures are kept.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function SyncStatusCard({
  sync,
  loading,
  error,
  onRetry,
}: {
  sync: RayernSyncStatus | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  return (
    <Card>
      <CardHeader
        title="Rayern synchronization"
        subtitle="Rayern generates aggregate snapshots and pushes them here; this dashboard stores and serves them. The transport actually configured is shown below."
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
            No snapshot transport is configured. Set <code className="rounded bg-ink-100 px-1 text-xs">RAYERN_SNAPSHOT_TOKEN</code> to accept
            pushed snapshots, <code className="ml-1 rounded bg-ink-100 px-1 text-xs">RAYERN_WAKEUP_ENDPOINT</code> so the external scheduler can
            wake Rayern, or <code className="rounded bg-ink-100 px-1 text-xs">RAYERN_SYNC_ENDPOINT</code> for the legacy pull fallback.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <StatusBadge tone={sync.status === 'healthy' ? 'green' : sync.status === 'degraded' ? 'amber' : 'red'}>
              {titleCase(sync.status)}
            </StatusBadge>
            <span className="text-ink-600">
              Last successful sync:{' '}
              <span className="font-medium text-ink-800">
                {sync.lastSuccessAt ? timeAgo(sync.lastSuccessAt) : 'never'}
                {sync.lastSuccessTransport && <> · transport: {sync.lastSuccessTransport}</>}
              </span>
            </span>
            <span className="text-ink-600">
              Last attempt: <span className="font-medium text-ink-800">{sync.lastAttemptAt ? timeAgo(sync.lastAttemptAt) : 'never'}</span>
            </span>
            {sync.consecutiveFailures > 0 ? (
              <span className="font-medium text-red-600">{sync.consecutiveFailures} consecutive failures</span>
            ) : null}
            {sync.stale ? <span className="font-medium text-amber-600">Data may be stale</span> : null}
            {sync.lastError ? <span className="w-full truncate text-xs text-red-600" title={sync.lastError}>Last error: {sync.lastError}</span> : null}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/**
 * Independent scheduler status.
 *
 * The scheduler is a separate service: it wakes Rayern on a fixed cadence and
 * owns its own execution history. `configured` / `reachable` / `status` are
 * three distinct states, so an absent scheduler is never shown as healthy.
 * An edge challenge is called out explicitly — it is not a successful wake.
 */
function SchedulerCard({
  data,
  loading,
  error,
  onRetry,
}: {
  data: SchedulerStatusResponse | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const status = data?.status ?? null
  const stateTone =
    !data || !data.configured || !data.reachable
      ? 'amber'
      : status?.edgeChallenge
        ? 'red'
        : status?.state === 'ok'
          ? 'green'
          : status?.state === 'failing'
            ? 'red'
            : 'amber'

  return (
    <Card>
      <CardHeader
        title="Snapshot scheduler"
        subtitle="Independent service that wakes Rayern every interval; it stores no customer data and generates no snapshots itself"
        actions={
          data?.configured ? (
            <StatusBadge tone={stateTone}>{titleCase(status?.state ?? (data.reachable ? 'unknown' : 'unreachable'))}</StatusBadge>
          ) : (
            <StatusBadge tone="amber">Not configured</StatusBadge>
          )
        }
      />
      <CardBody>
        {loading ? (
          <LoadingBlock rows={2} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !data || !data.configured ? (
          <p className="text-sm text-ink-500">
            {data?.reason ?? 'The external scheduler is not configured for this deployment.'} The dashboard cannot confirm the
            wake schedule; snapshot freshness above remains the authoritative signal.
          </p>
        ) : !data.reachable || !status ? (
          <p className="text-sm text-amber-700">{data.reason ?? 'Scheduler status is unavailable.'}</p>
        ) : (
          <div className="space-y-4">
            {status.edgeChallenge ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                The scheduler is paused: Rayern's edge answered the wake request with a browser human-verification challenge.
                That is not a successful wake and cannot be solved by a server. Resolve it with the hosting provider, then
                restart the scheduler.
              </p>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Cadence</dt>
                <dd className="mt-0.5 font-medium text-ink-800">
                  {status.intervalMs ? `${Math.round(status.intervalMs / 60_000)}m` : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Last attempt</dt>
                <dd className="mt-0.5 font-medium text-ink-800">{status.lastAttemptAt ? timeAgo(status.lastAttemptAt) : 'never'}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Last success</dt>
                <dd className="mt-0.5 font-medium text-ink-800">{status.lastSuccessAt ? timeAgo(status.lastSuccessAt) : 'never'}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Next scheduled</dt>
                <dd className="mt-0.5 font-medium text-ink-800">
                  {status.nextScheduledAt ? formatDateTime(status.nextScheduledAt) : 'paused'}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Last outcome</dt>
                <dd className="mt-0.5 font-medium text-ink-800">
                  {status.lastOutcome ? titleCase(status.lastOutcome) : '—'}
                  {status.lastHttpStatus !== null ? ` · HTTP ${status.lastHttpStatus}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Consecutive failures</dt>
                <dd className="mt-0.5 font-medium text-ink-800">{status.consecutiveFailures ?? 0}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Last error category</dt>
                <dd className="mt-0.5 font-medium text-ink-800">{status.lastErrorCategory ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Reached Rayern app</dt>
                <dd className="mt-0.5 font-medium text-ink-800">
                  {status.reachedApplication === null ? 'unknown' : status.reachedApplication ? 'yes' : 'no'}
                </dd>
              </div>
            </dl>

            {status.history.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                      <th scope="col" className="px-2 py-2">Started</th>
                      <th scope="col" className="px-2 py-2">Trigger</th>
                      <th scope="col" className="px-2 py-2">Outcome</th>
                      <th scope="col" className="px-2 py-2">HTTP</th>
                      <th scope="col" className="px-2 py-2">Attempts</th>
                      <th scope="col" className="px-2 py-2">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.history.slice(0, 6).map((entry, index) => (
                      <tr key={entry.id ?? index} className="border-b border-ink-100 last:border-0">
                        <td className="whitespace-nowrap px-2 py-2 text-ink-600">
                          {entry.startedAt ? formatDateTime(entry.startedAt) : '—'}
                        </td>
                        <td className="px-2 py-2 text-ink-700">{entry.trigger ?? '—'}</td>
                        <td className="px-2 py-2 font-medium text-ink-800">{entry.outcome ?? '—'}</td>
                        <td className="px-2 py-2 text-ink-700">{entry.httpStatus ?? '—'}</td>
                        <td className="px-2 py-2 text-ink-700">{entry.attempts ?? '—'}</td>
                        <td className="max-w-[22rem] truncate px-2 py-2 text-xs text-ink-600" title={entry.message ?? ''}>
                          {entry.message ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
