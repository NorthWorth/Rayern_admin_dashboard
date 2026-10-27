import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { PageHeader, REPORTING_TIMEZONE } from '../components/PageHeader'
import { LoadingBlock } from '../components/ui/states'
import { StatusBadge } from '../components/ui/Badge'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { systemService } from '../services/system'
import { platformMetricsService } from '../services/platformMetrics'
import { DEMO_MODE, session } from '../lib/api'
import { titleCase } from '../lib/utils'

/**
 * Settings — a read-only configuration surface.
 *
 * The dashboard has no settings-write API: everything here is derived from
 * live backend state (sync worker, data source, session) or from documented
 * server configuration. Nothing is editable from the UI by design — server
 * configuration lives in environment variables on the backend host.
 */
export function SettingsPage() {
  const systemQ = useQuery(() => systemService.overview())
  const metricsQ = useQuery(() => platformMetricsService.overview())
  usePageRefresh([systemQ, metricsQ])

  const operator = session.operator()
  const sync = systemQ.data?.sync ?? null

  const rows: Array<{ label: string; value: string; note?: string }> = [
    { label: 'Environment', value: DEMO_MODE ? 'Demo data (no backend connected)' : 'Connected to dashboard API' },
    { label: 'Signed in as', value: operator ? `${operator.name} · ${operator.email}` : 'Not signed in' },
    { label: 'Reporting timezone', value: REPORTING_TIMEZONE, note: 'Used for every date boundary in the dashboard' },
    {
      label: 'Reporting periods',
      value: '7 / 30 / 90 days',
      note: 'Comparisons use the equivalent preceding window when the source covers it',
    },
    {
      label: 'Rayern pull-sync',
      value: sync ? (sync.enabled ? 'Enabled' : 'Disabled') : 'Unknown',
      note: sync?.enabled ? 'Dashboard pulls aggregates from Rayern; Rayern never calls the dashboard' : 'Set RAYERN_SYNC_ENDPOINT on the backend to enable',
    },
    {
      label: 'Sync status',
      value: sync ? titleCase(sync.status) : 'Unknown',
      note: sync?.lastSuccessAt ? `Last successful pull recorded by the backend` : undefined,
    },
    {
      label: 'Aggregated metrics source',
      value: metricsQ.data?.dataSource === 'rayern-sync' ? 'Rayern sync' : metricsQ.data ? 'Local registry' : 'Loading',
      note: 'Determines whether counts come from synchronized aggregates or the local fallback',
    },
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Settings"
        description="Dashboard configuration, data sources and access model."
        footnote="Read-only: server configuration is applied through environment variables on the backend host."
      />

      <Card>
        <CardHeader title="Current configuration" subtitle="Derived from live backend state" />
        <CardBody>
          {systemQ.loading ? (
            <LoadingBlock rows={4} />
          ) : (
            <dl className="divide-y divide-ink-100 text-sm">
              {rows.map((r) => (
                <div key={r.label} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                  <dt className="text-ink-600">{r.label}</dt>
                  <dd className="text-right">
                    <span className="font-medium text-ink-900">
                      {r.label === 'Sync status' && sync ? (
                        <span className="inline-flex items-center gap-2">
                          {titleCase(sync.status)}
                          <StatusBadge tone={sync.status === 'healthy' ? 'green' : sync.status === 'degraded' ? 'amber' : 'red'}>
                            {sync.status === 'healthy' ? 'fresh' : sync.stale ? 'stale' : 'attention'}
                          </StatusBadge>
                        </span>
                      ) : (
                        r.value
                      )}
                    </span>
                    {r.note ? <p className="mt-0.5 text-xs text-ink-500">{r.note}</p> : null}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Rate limits in force" subtitle="Applied by the dashboard backend — never relaxed by the UI" />
        <CardBody>
          <ul className="space-y-2 text-sm text-ink-600">
            <li className="flex items-center justify-between gap-3">
              <span>Global API limit</span>
              <span className="font-medium text-ink-900">300 requests / minute / IP</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>Login attempts</span>
              <span className="font-medium text-ink-900">10 / 15 minutes / IP</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>Rayern pull-sync window</span>
              <span className="font-medium text-ink-900">30 minutes between pulls</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>429 responses</span>
              <span className="font-medium text-ink-900">Carry Retry-After for the client</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-ink-500">
            The manual Update control issues ordinary requests through the normal API path — it cannot bypass, reset or
            shorten any of these windows.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Access model" subtitle="Who can see what" />
        <CardBody>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-ink-600">
            <li>Every data route requires an authenticated dashboard administrator.</li>
            <li>Workspace contents are never accessible from this dashboard — only registration metadata.</li>
            <li>Billing values are rendered exactly as Rayern reports them; the dashboard never recomputes revenue.</li>
            <li>Campaign consent is revalidated server-side at send time, never only in the browser.</li>
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}
