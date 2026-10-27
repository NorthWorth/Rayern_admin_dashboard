import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { KpiCard } from '../components/KpiCard'
import { LoadingBlock, ErrorState } from '../components/ui/states'
import { StatusBadge } from '../components/ui/Badge'
import { TrendLineChart } from '../components/charts'
import { useQuery, type QueryState } from '../hooks/useQuery'
import { platformMetricsService } from '../services/platformMetrics'
import { emailsService } from '../services/emails'
import { systemService } from '../services/system'
import { usersService } from '../services/users'
import { workspacesService } from '../services/workspaces'
import { formatDateTime, formatNumber, titleCase } from '../lib/utils'
import type { EmailMessage, HealthStatus } from '../lib/types'

function healthTone(s: HealthStatus): 'green' | 'amber' | 'red' {
  return s === 'healthy' ? 'green' : s === 'degraded' ? 'amber' : 'red'
}

export function OverviewPage() {
  const usersQ = useQuery(() => usersService.stats())
  const wsQ = useQuery(() => workspacesService.stats())
  const metricsQ = useQuery(() => platformMetricsService.overview())
  const emailsQ = useQuery(() => emailsService.list())
  const emailStatsQ = useQuery(() => emailsService.stats())
  const systemQ = useQuery(() => systemService.overview())

  const emails = emailsQ.data ?? []
  const recentEmails = emails.slice(0, 6)
  const registrations = (metricsQ.data?.registrationsTrend ?? []).slice(-30)

  /* -------------------------- Manual data refresh ------------------------- */
  // One entry per request this page makes. The Update button re-runs exactly
  // these fetchers through the normal API path — no dedicated endpoint, no
  // cache-busting, so every backend rate-limit rule applies unchanged.
  const sources: Array<[label: string, q: QueryState<unknown>]> = [
    ['Accounts', usersQ],
    ['Workspaces', wsQ],
    ['Platform metrics', metricsQ],
    ['Emails', emailsQ],
    ['Email stats', emailStatsQ],
    ['System health', systemQ],
  ]
  const busy = sources.some(([, q]) => q.loading)
  const failed = sources.filter(([, q]) => q.error !== null)
  const allLoaded = sources.every(([, q]) => q.data !== null)

  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)

  // Last successful update = every source settled without an error.
  useEffect(() => {
    if (!busy && allLoaded && failed.length === 0) setLastSuccessAt(Date.now())
  }, [busy, allLoaded, failed.length])

  // A manual refresh ends once its requests have started and settled — this
  // also keeps the button disabled for the whole flight, so a second click
  // (or a double-mounted effect) can never start duplicate requests.
  useEffect(() => {
    if (!refreshing) return
    if (busy) {
      inFlight.current = true
      return
    }
    if (!inFlight.current) return // requests have not started yet
    inFlight.current = false
    setRefreshing(false)
    if (failed.length === 0) setLastSuccessAt(Date.now())
  }, [refreshing, busy, failed.length])

  function handleUpdate(): void {
    if (busy || refreshing) return
    inFlight.current = false
    setRefreshing(true)
    for (const [, q] of sources) q.refetch()
  }

  const retryHint = useMemo(() => {
    const secs = failed
      .map(([, q]) => q.errorInfo?.retryAfterSec)
      .filter((n): n is number => typeof n === 'number')
    if (secs.length === 0) return null
    const wait = Math.max(...secs)
    return {
      sec: wait,
      at: new Date(Date.now() + wait * 1000).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }),
    }
    // Recomputed only when the retry information itself changes, so the shown
    // clock time does not drift on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed.map(([, q]) => q.errorInfo?.retryAfterSec ?? -1).join(',')])

  const statusText = busy || refreshing
    ? 'Loading the latest data…'
    : lastSuccessAt
      ? `Last updated ${new Date(lastSuccessAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
      : 'No successful update yet'

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      {/* Data status bar — loading state, last successful update, error detail */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-200 bg-white px-4 py-3">
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-semibold text-ink-900">Dashboard data</p>
          <p className="text-xs text-ink-500" data-testid="refresh-status">
            {statusText}
          </p>
          {failed.length > 0 ? (
            <div role="alert" className="max-w-3xl rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <p className="font-semibold">
                {failed.length} of {sources.length} data sources failed to update
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {failed.map(([label, q]) => (
                  <li key={label}>
                    {label}: {q.errorInfo?.status ? `HTTP ${q.errorInfo.status}` : 'Request failed'}
                    {q.errorInfo?.code ? ` (${q.errorInfo.code})` : ''} — {q.error}
                  </li>
                ))}
              </ul>
              {retryHint ? (
                <p className="mt-1 font-medium">
                  Rate limited — another attempt may be appropriate in about {retryHint.sec}s (at {retryHint.at}).
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={handleUpdate}
          disabled={busy || refreshing}
          aria-busy={busy || refreshing}
        >
          {busy || refreshing ? (
            <>
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
                <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Updating…
            </>
          ) : (
            'Update data'
          )}
        </Button>
      </div>

      {/* KPI grid — aggregate platform state only */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Registered accounts" value={usersQ.data ? formatNumber(usersQ.data.totalUsers) : '—'} sub={usersQ.data ? `${formatNumber(usersQ.data.newUsers7d)} new in 7d` : undefined} />
        <KpiCard label="Workspaces" value={wsQ.data ? formatNumber(wsQ.data.total) : '—'} sub={wsQ.data ? `${formatNumber(wsQ.data.newWorkspaces30d)} new in 30d` : undefined} />
        <KpiCard label="New accounts (30d)" value={metricsQ.data ? formatNumber(metricsQ.data.newAccounts30d) : '—'} />
        <KpiCard label="Deletions (30d)" value={metricsQ.data ? formatNumber(metricsQ.data.deletedAccounts30d) : '—'} />
        <KpiCard label="Emails sent (30d)" value={emailStatsQ.data ? formatNumber(emailStatsQ.data.totalSent) : '—'} sub={emailStatsQ.data ? `${formatNumber(emailStatsQ.data.failed)} failed` : undefined} />
        <KpiCard
          label="System status"
          value={systemQ.data ? titleCase(systemQ.data.overall) : '—'}
          tone={systemQ.data?.overall === 'healthy' ? 'green' : systemQ.data?.overall === 'degraded' ? 'amber' : 'red'}
          sub={systemQ.data ? `${systemQ.data.errorRatePct.toFixed(2)}% error rate · p95 ${systemQ.data.latency.p95}ms` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Registrations trend */}
        <Card className="xl:col-span-2">
          <CardHeader
            title="New registrations"
            subtitle="Aggregate account registrations per day (30 days)"
            actions={<Link to="/metrics" className="text-xs font-medium text-emerald-700 hover:text-emerald-800">Platform metrics →</Link>}
          />
          <CardBody>
            {metricsQ.loading ? (
              <LoadingBlock rows={6} />
            ) : metricsQ.error ? (
              <ErrorState message={metricsQ.error} onRetry={metricsQ.refetch} />
            ) : metricsQ.data ? (
              <TrendLineChart
                data={registrations.map((d) => ({ time: d.date, count: d.count }))}
                dataKey="count"
                name="Registrations"
                unit=""
              />
            ) : null}
          </CardBody>
        </Card>

        {/* System health summary */}
        <Card>
          <CardHeader
            title="System health"
            subtitle="Services as reported by the dashboard backend"
            actions={<Link to="/system" className="text-xs font-medium text-emerald-700 hover:text-emerald-800">Details →</Link>}
          />
          <CardBody className="space-y-2.5">
            {systemQ.loading ? (
              <LoadingBlock rows={6} />
            ) : systemQ.error ? (
              <ErrorState message={systemQ.error} onRetry={systemQ.refetch} />
            ) : systemQ.data ? (
              systemQ.data.services.slice(0, 8).map((s) => (
                <div key={s.id} className="flex items-center justify-between text-sm">
                  <span className="truncate text-ink-700">{s.name}</span>
                  <StatusBadge tone={healthTone(s.status)}>{titleCase(s.status)}</StatusBadge>
                </div>
              ))
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Recent email activity */}
        <Card>
          <CardHeader
            title="Recent email activity"
            subtitle="Admin-sent messages tracked by the dashboard backend"
            actions={<Link to="/emails" className="text-xs font-medium text-emerald-700 hover:text-emerald-800">All emails →</Link>}
          />
          {emailsQ.loading ? (
            <CardBody><LoadingBlock rows={5} /></CardBody>
          ) : emailsQ.error ? (
            <ErrorState message={emailsQ.error} onRetry={emailsQ.refetch} />
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {recentEmails.map((e: EmailMessage) => (
                  <tr key={e.id} className="border-b border-ink-100 last:border-0">
                    <td className="max-w-0 px-4 py-2.5">
                      <p className="truncate font-medium text-ink-800">{e.subject}</p>
                      <p className="truncate text-xs text-ink-500">{e.to.join(', ')} · {formatDateTime(e.sentAt)}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <StatusBadge tone={emailStatusTone(e.status)}>{titleCase(e.status)}</StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Quick links */}
        <Card>
          <CardHeader title="Operations shortcuts" subtitle="Common admin destinations" />
          <CardBody className="grid grid-cols-2 gap-3">
            <ShortcutLink to="/users" title="Users" desc="Account administration" />
            <ShortcutLink to="/workspaces" title="Workspaces" desc="Aggregate registrations" />
            <ShortcutLink to="/metrics" title="Platform metrics" desc="Privacy-safe aggregates" />
            <ShortcutLink to="/emails" title="Send email" desc="Compose admin broadcast" />
            <ShortcutLink to="/errors" title="Errors" desc="Recent failures and traces" />
            <ShortcutLink to="/observability" title="Observability" desc="Traces, latency, slow ops" />
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function ShortcutLink({ to, title, desc }: { to: string; title: string; desc: string }) {
  return (
    <Link
      to={to}
      className="rounded-md border border-ink-200 px-3.5 py-3 transition-colors hover:border-ink-300 hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300"
    >
      <p className="text-sm font-medium text-ink-900">{title}</p>
      <p className="mt-0.5 text-xs text-ink-500">{desc}</p>
    </Link>
  )
}

export function emailStatusTone(status: EmailMessage['status']): 'green' | 'amber' | 'red' | 'blue' {
  switch (status) {
    case 'delivered':
    case 'sent':
      return 'green'
    case 'queued':
      return 'blue'
    case 'failed':
    case 'bounced':
      return 'red'
    default:
      return 'amber'
  }
}
