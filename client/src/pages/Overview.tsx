import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { PageHeader, PeriodSelector, REPORTING_TIMEZONE } from '../components/PageHeader'
import { MetricNote, UnavailablePanel } from '../components/UnavailablePanel'
import { StatusBadge } from '../components/ui/Badge'
import { LoadingBlock, ErrorState } from '../components/ui/states'
import { TrendLineChart } from '../components/charts'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { platformMetricsService } from '../services/platformMetrics'
import { usersService } from '../services/users'
import { workspacesService } from '../services/workspaces'
import { systemService } from '../services/system'
import { auditService } from '../services/audit'
import { errorsService } from '../services/errors'
import { marketingService } from '../services/marketing'
import { revenueService } from '../services/revenue'
import { completeDailySeries, summariseTrend } from '../lib/period'
import { formatCurrencyMajor, formatDate, formatDateTime, formatNumber, titleCase } from '../lib/utils'
import type { HealthStatus } from '../lib/types'

function healthTone(s: HealthStatus): 'green' | 'amber' | 'red' {
  return s === 'healthy' ? 'green' : s === 'degraded' ? 'amber' : 'red'
}

/** Compact section shell with a link to the corresponding detailed page. */
function SummarySection({
  title,
  subtitle,
  to,
  linkLabel,
  children,
}: {
  title: string
  subtitle?: string
  to: string
  linkLabel: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        actions={
          <Link to={to} className="text-xs font-medium text-champagne-700 hover:text-champagne-800">
            {linkLabel} →
          </Link>
        }
      />
      <CardBody>{children}</CardBody>
    </Card>
  )
}

/**
 * Overview — the founder snapshot.
 *
 * Answers, from verified sources only: how large the user base is, whether it
 * is growing, whether the business earns recurring revenue, and what needs
 * attention. Metrics that cannot be measured reliably are shown as unavailable
 * with the reason — never as zeros or look-alike substitutes.
 */
export function OverviewPage() {
  const [period, setPeriod] = useState<7 | 30 | 90>(30)

  const metricsQ = useQuery(() => platformMetricsService.overview())
  const usersQ = useQuery(() => usersService.stats())
  const wsQ = useQuery(() => workspacesService.stats())
  const revenueQ = useQuery(() => revenueService.state())
  const systemQ = useQuery(() => systemService.overview())
  const auditQ = useQuery(() => auditService.list())
  const errorsQ = useQuery(() => errorsService.list())
  const marketingQ = useQuery(() => marketingService.metrics())
  const recentUsersQ = useQuery(() => usersService.list({ page: 1, pageSize: 5 }))

  // The navbar refreshes exactly these queries, preserving the selected period.
  usePageRefresh([metricsQ, usersQ, wsQ, revenueQ, systemQ, auditQ, errorsQ, marketingQ, recentUsersQ])

  const trend = metricsQ.data?.registrationsTrend ?? []
  const series = useMemo(() => completeDailySeries(trend), [trend])
  const signups = useMemo(() => summariseTrend(series, period), [series, period])
  // The trend the backend serves is bounded by REGISTRATION_TREND_DAYS
  // (default 30), so a 90-day window cannot be covered honestly.
  const trendDays = series.length
  const unsupportedPeriods: Array<7 | 30 | 90> = (['7', '30', '90'] as const)
    .map((d) => Number(d) as 7 | 30 | 90)
    .filter((d) => d > trendDays)

  const totalUsers = usersQ.data?.totalUsers ?? metricsQ.data?.registeredAccounts ?? null
  const billing = revenueQ.data?.kind === 'populated' ? revenueQ.data.billing : null
  const sync = systemQ.data?.sync ?? null
  const recentEvents = (auditQ.data ?? []).slice(0, 6)
  const openErrors = errorsQ.data ?? []
  const consent = marketingQ.data?.consent ?? null

  const alerts: Array<{ tone: 'amber' | 'red'; text: string; to: string }> = []
  if (sync?.stale) {
    alerts.push({
      tone: 'amber',
      text: `Rayern data may be stale — last successful sync ${sync.lastSuccessAt ? formatDateTime(sync.lastSuccessAt) : 'never'}.`,
      to: '/system',
    })
  }
  if (sync && sync.consecutiveFailures > 0) {
    alerts.push({
      tone: 'red',
      text: `${sync.consecutiveFailures} consecutive sync failures${sync.lastError ? ` — ${sync.lastError}` : ''}.`,
      to: '/system',
    })
  }
  if (openErrors.length > 0) {
    const critical = openErrors.filter((e) => e.severity === 'critical' || e.severity === 'high').length
    alerts.push({
      tone: critical > 0 ? 'red' : 'amber',
      text: `${formatNumber(openErrors.length)} grouped errors recorded${critical > 0 ? ` (${critical} high or critical)` : ''}.`,
      to: '/errors',
    })
  }

  const loading = metricsQ.loading || usersQ.loading
  const failed = [metricsQ, usersQ, wsQ, revenueQ, systemQ, recentUsersQ].filter((q) => q.error !== null)

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Overview"
        description="Growth, monetisation and operational health at a glance."
        actions={<PeriodSelector value={period} onChange={setPeriod} disabledDays={unsupportedPeriods} />}
        footnote={
          <>
            Reporting timezone: {REPORTING_TIMEZONE} · period comparisons use the equivalent preceding window.
            {series.length > 0 ? ` Registration trend covers ${trendDays} days.` : ''}
          </>
        }
      />

      {failed.length > 0 ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          <p className="font-semibold">
            {failed.length} data source{failed.length === 1 ? '' : 's'} failed to load — showing what is available.
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {failed.map((q, i) => (
              <li key={i}>
                {q.errorInfo?.status ? `HTTP ${q.errorInfo.status}` : 'Request failed'}
                {q.errorInfo?.code ? ` (${q.errorInfo.code})` : ''} — {q.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* KPI hierarchy: one featured card, three quieter supporting cards. */}
      {/* 5 tracks at xl: the featured card spans 2, the three supporting
          cards 1 each — all four KPIs sit on one balanced row. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <div className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
          <KpiCard
            variant="primary"
            label="Total registered users"
            value={loading && totalUsers === null ? '—' : formatNumber(totalUsers ?? 0)}
            sub={
              usersQ.data
                ? `${formatNumber(usersQ.data.verified)} verified · ${formatNumber(usersQ.data.unverified)} unverified`
                : 'All accounts recorded to date'
            }
            note={
              metricsQ.data
                ? `Source: ${metricsQ.data.dataSource === 'rayern-sync' ? 'Rayern sync' : 'local registry'}`
                : undefined
            }
          >
            <Link
              to="/users"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-champagne-300 hover:text-champagne-200"
            >
              View users →
            </Link>
          </KpiCard>
        </div>

        <KpiCard
          label="New sign-ups"
          value={metricsQ.loading ? '—' : formatNumber(signups.total)}
          sub={`Last ${period} days`}
          delta={signups.delta}
          note={
            !signups.complete
              ? `Trend covers ${signups.coverageDays} of ${period} days`
              : signups.delta === null
                ? 'No preceding-period data for comparison'
                : undefined
          }
        >
          <Link to="/acquisition" className="mt-2 inline-block text-xs font-medium text-champagne-700 hover:text-champagne-800">
            Acquisition report →
          </Link>
        </KpiCard>

        <KpiCard label="Activated users" value="—">
          <p className="mt-2 text-xs leading-relaxed text-ink-600">
            Not measured — activation is not instrumented, so no activation count exists. Total users are not used as a
            substitute.
          </p>
          <Link to="/funnels" className="mt-2 inline-block text-xs font-medium text-champagne-700 hover:text-champagne-800">
            What would be needed →
          </Link>
        </KpiCard>

        <KpiCard label="Active users" value="—">
          <p className="mt-2 text-xs leading-relaxed text-ink-600">
            Not measured — there is no daily-activity instrumentation, so DAU/WAU/MAU cannot be computed.
          </p>
          <Link to="/retention" className="mt-2 inline-block text-xs font-medium text-champagne-700 hover:text-champagne-800">
            Retention detail →
          </Link>
        </KpiCard>
      </div>

      {/* Operational alerts */}
      {alerts.length > 0 ? (
        <Card>
          <CardHeader title="Needs attention" subtitle="Conditions defined by the platform's own health signals" />
          <CardBody className="space-y-2">
            {alerts.map((a, i) => (
              <div
                key={i}
                className={
                  'flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ' +
                  (a.tone === 'red' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800')
                }
              >
                <span className="min-w-0">{a.text}</span>
                <Link to={a.to} className="shrink-0 text-xs font-medium underline underline-offset-2">
                  Open
                </Link>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <SummarySection title="Registrations" subtitle={`New accounts per day (UTC), last ${trendDays || period} days`} to="/acquisition" linkLabel="Acquisition">
          {metricsQ.loading ? (
            <LoadingBlock rows={4} />
          ) : metricsQ.error ? (
            <ErrorState message={metricsQ.error} onRetry={metricsQ.refetch} />
          ) : series.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-500">No registration data has been synchronized yet.</p>
          ) : (
            <>
              <TrendLineChart
                data={series.map((d) => ({ time: d.date, count: d.count }))}
                dataKey="count"
                name="Registrations"
                color="#B69A67"
                unit=""
              />
              <MetricNote>
                {signups.total} registrations in the last {period} days
                {signups.delta
                  ? `, ${signups.delta.absolute >= 0 ? '+' : ''}${signups.delta.absolute} vs the preceding ${period} days`
                  : ' (no preceding-period coverage for a comparison)'}
                .
              </MetricNote>
            </>
          )}
        </SummarySection>

        <SummarySection title="Conversion funnel" subtitle="Only stages with a verified source are counted" to="/funnels" linkLabel="Funnel detail">
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-600">Registered accounts</dt>
              <dd className="font-medium tabular-nums text-ink-900">
                {usersQ.data ? formatNumber(usersQ.data.totalUsers) : '—'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-600">Paying subscriptions</dt>
              <dd className="font-medium tabular-nums text-ink-900">
                {billing ? formatNumber(billing.activePaidSubscribers) : revenueQ.data?.kind === 'unavailable' ? 'No billing data' : '—'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-ink-100 pt-3">
              <dt className="text-ink-600">Registered → paid</dt>
              <dd className="font-medium tabular-nums text-ink-900">
                {billing && usersQ.data && usersQ.data.totalUsers > 0
                  ? `${((billing.activePaidSubscribers / usersQ.data.totalUsers) * 100).toFixed(1)}%`
                  : 'n/a'}
              </dd>
            </div>
          </dl>
          <MetricNote>
            Visitor, onboarding, activation and retention stages are not instrumented and are shown as unavailable on
            the funnel page.
          </MetricNote>
        </SummarySection>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <SummarySection title="Plans & monetisation" subtitle="Plan distribution and reported billing" to="/revenue" linkLabel="Revenue">
          {(metricsQ.data?.planBreakdown ?? []).length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-500">No plan data yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(metricsQ.data?.planBreakdown ?? []).map((p) => (
                <li key={p.plan} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-ink-700">
                    <span className="h-2 w-2 rounded-sm bg-champagne-400" aria-hidden="true" />
                    {titleCase(p.plan)}
                  </span>
                  <span className="tabular-nums text-ink-900">{formatNumber(p.count)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 border-t border-ink-100 pt-3 text-sm">
            {revenueQ.data?.kind === 'populated' && billing ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink-600">MRR (reported by Rayern)</span>
                <span className="font-medium tabular-nums text-ink-900">
                  {formatCurrencyMajor(billing.mrr.amountMajor, billing.currency)}
                </span>
              </div>
            ) : revenueQ.data?.kind === 'unavailable' ? (
              <p className="text-xs text-ink-500">Billing data has not been synchronized yet — revenue is not estimated.</p>
            ) : (
              <p className="text-xs text-ink-500">Billing data loading…</p>
            )}
          </div>
        </SummarySection>

        <SummarySection title="Workspaces & adoption" subtitle="Registrations and module usage" to="/adoption" linkLabel="Adoption">
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-600">Total workspaces</dt>
              <dd className="font-medium tabular-nums text-ink-900">{wsQ.data ? formatNumber(wsQ.data.total) : '—'}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-600">New in the last 30 days</dt>
              <dd className="font-medium tabular-nums text-ink-900">
                {wsQ.data ? formatNumber(wsQ.data.newWorkspaces30d) : '—'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-600">Average members per workspace</dt>
              <dd className="font-medium tabular-nums text-ink-900">
                {wsQ.data ? String(wsQ.data.avgMembersPerWorkspace) : '—'}
              </dd>
            </div>
          </dl>
          <MetricNote>Per-module usage (clients, leads, projects…) is not instrumented — see the adoption page.</MetricNote>
        </SummarySection>

        <SummarySection title="Email & consent" subtitle="Consent-gated messaging health" to="/emails" linkLabel="Email">
          {consent ? (
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-600">Marketable accounts (opted in)</dt>
                <dd className="font-medium tabular-nums text-ink-900">{formatNumber(marketingQ.data?.mailable ?? 0)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-600">Opted out</dt>
                <dd className="font-medium tabular-nums text-ink-900">{formatNumber(consent.optedOut)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-600">No consent recorded</dt>
                <dd className="font-medium tabular-nums text-ink-900">{formatNumber(consent.unknown)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-ink-100 pt-2">
                <dt className="text-ink-600">Campaigns sent (30d)</dt>
                <dd className="font-medium tabular-nums text-ink-900">
                  {formatNumber(marketingQ.data?.campaigns.sent30d ?? 0)}
                </dd>
              </div>
            </dl>
          ) : (
            <LoadingBlock rows={3} />
          )}
          <MetricNote>Consent is revalidated server-side at send time; only explicit opt-ins are ever mailable.</MetricNote>
        </SummarySection>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <SummarySection title="Recent registrations" subtitle="Newest accounts on record" to="/users" linkLabel="All users">
          {recentUsersQ.loading ? (
            <LoadingBlock rows={3} />
          ) : recentUsersQ.error ? (
            <ErrorState message={recentUsersQ.error} onRetry={recentUsersQ.refetch} />
          ) : (recentUsersQ.data?.items ?? []).length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-500">No accounts recorded yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100 text-sm">
              {(recentUsersQ.data?.items ?? []).map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-800">{u.name}</p>
                    <p className="truncate text-xs text-ink-500">{u.email}</p>
                  </div>
                  <span className="shrink-0 text-xs text-ink-500">{formatDate(u.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </SummarySection>

        <SummarySection title="Recent activity" subtitle="Administrative and system events" to="/activity" linkLabel="Activity">
          {auditQ.loading ? (
            <LoadingBlock rows={3} />
          ) : recentEvents.length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-500">No recorded events yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100 text-sm">
              {recentEvents.map((ev) => (
                <li key={ev.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-800">{ev.action}</p>
                    <p className="truncate text-xs text-ink-500">
                      {ev.actor} · {ev.target || '—'}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-ink-500">{formatDateTime(ev.timestamp)}</span>
                </li>
              ))}
            </ul>
          )}
        </SummarySection>

        <SummarySection title="System health" subtitle="As reported by the dashboard backend" to="/system" linkLabel="System">
          {systemQ.loading ? (
            <LoadingBlock rows={3} />
          ) : systemQ.error ? (
            <ErrorState message={systemQ.error} onRetry={systemQ.refetch} />
          ) : systemQ.data ? (
            <>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-ink-600">Overall status</span>
                <StatusBadge tone={healthTone(systemQ.data.overall)}>{titleCase(systemQ.data.overall)}</StatusBadge>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {systemQ.data.services.slice(0, 5).map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3">
                    <span className="truncate text-ink-700">{s.name}</span>
                    <StatusBadge tone={healthTone(s.status)}>{titleCase(s.status)}</StatusBadge>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </SummarySection>
      </div>

      <UnavailablePanel
        title="Feedback inbox"
        reason="No feedback data source is connected to the dashboard, so an unreviewed-feedback count cannot be shown here."
        required="A feedback table plus a Rayern endpoint that returns aggregate counts for administrators."
      />
    </div>
  )
}
