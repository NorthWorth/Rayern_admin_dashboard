import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { StatusBadge } from '../components/ui/Badge'
import { LoadingBlock, ErrorState } from '../components/ui/states'
import { UnavailablePanel } from '../components/UnavailablePanel'
import { VolumeBarChart } from '../components/charts'
import { systemService } from '../services/system'
import { rayernService } from '../services/rayern'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { clsx, formatCompact, formatNumber, formatPct, rayernReasonText, timeAgo, titleCase } from '../lib/utils'
import type {
  DependencyConfigBlock,
  HealthStatus,
  RayernSyncStatus,
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
  usePageRefresh([q, blocksQ, syntheticQ])

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
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <StatusBadge tone={sync.status === 'healthy' ? 'green' : sync.status === 'degraded' ? 'amber' : 'red'}>
              {titleCase(sync.status)}
            </StatusBadge>
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
            {sync.lastError ? <span className="w-full truncate text-xs text-red-600" title={sync.lastError}>Last error: {sync.lastError}</span> : null}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
