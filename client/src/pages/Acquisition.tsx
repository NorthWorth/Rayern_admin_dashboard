import { useMemo, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { PageHeader, PeriodSelector, REPORTING_TIMEZONE } from '../components/PageHeader'
import { MetricNote, UnavailablePanel } from '../components/UnavailablePanel'
import { LoadingBlock, ErrorState, EmptyState } from '../components/ui/states'
import { Badge } from '../components/ui/Badge'
import { TrendLineChart, VolumeBarChart } from '../components/charts'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { platformMetricsService } from '../services/platformMetrics'
import { rayernService } from '../services/rayern'
import { completeDailySeries, groupByMonth, groupByWeek, summariseTrend } from '../lib/period'
import { formatCount, formatNumber, rayernReasonText, timeAgo } from '../lib/utils'

type Grouping = 'daily' | 'weekly' | 'monthly'

/**
 * Acquisition — registrations over time.
 *
 * Only registration counts from the platform-metrics source are shown.
 * Attribution (UTM source/medium/campaign, referrer, channel conversion) has
 * no instrumentation in Rayern or the dashboard, so it is reported as
 * unavailable rather than inferred from unrelated profile data.
 */
export function AcquisitionPage() {
  const [period, setPeriod] = useState<7 | 30 | 90>(30)
  const [grouping, setGrouping] = useState<Grouping>('daily')

  const metricsQ = useQuery(() => platformMetricsService.overview())
  const instQ = useQuery(() => rayernService.blocks())
  usePageRefresh([metricsQ, instQ])

  const funnel = instQ.data?.blocks.funnel ?? null
  const funnelReceived = instQ.data?.received.includes('funnel') ?? false
  const funnelReason = instQ.error
    ? `Instrumentation could not be loaded: ${instQ.error}`
    : funnelReceived && funnel === null
      ? 'Rayern reported this block as unavailable for this period — its aggregation failed upstream.'
      : rayernReasonText('not_reported')

  const series = useMemo(() => completeDailySeries(metricsQ.data?.registrationsTrend ?? []), [metricsQ.data])
  const summary = useMemo(() => summariseTrend(series, period), [series, period])
  const trendDays = series.length

  const windowed = useMemo(() => {
    if (trendDays === 0) return []
    return series.slice(Math.max(0, trendDays - period))
  }, [series, period, trendDays])

  const grouped = useMemo(() => {
    if (grouping === 'daily') return windowed
    if (grouping === 'weekly') return groupByWeek(windowed)
    return groupByMonth(windowed)
  }, [windowed, grouping])

  const unsupported = (['7', '30', '90'] as const).map((d) => Number(d) as 7 | 30 | 90).filter((d) => d > trendDays)
  const previousAvailable = summary.delta !== null

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Acquisition"
        description="Where new registrations come from and how fast the account base is growing."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PeriodSelector value={period} onChange={setPeriod} disabledDays={unsupported} />
            <div role="group" aria-label="Grouping" className="inline-flex rounded-md border border-ink-200 bg-white p-0.5">
              {(['daily', 'weekly', 'monthly'] as Grouping[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={grouping === g}
                  onClick={() => setGrouping(g)}
                  className={
                    'rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors ' +
                    (grouping === g ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100')
                  }
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        }
        footnote={`Reporting timezone: ${REPORTING_TIMEZONE} · boundaries are UTC calendar days.${
          instQ.data?.syncedAt ? ` · instrumentation synced ${timeAgo(instQ.data.syncedAt)}` : ''
        }`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={`Sign-ups · ${period} days`}
          value={metricsQ.loading ? '—' : formatNumber(summary.total)}
          sub={summary.lastDate ? `Through ${summary.lastDate}` : 'No data'}
          note={!summary.complete ? `Coverage: ${summary.coverageDays} of ${period} days` : undefined}
        />
        <KpiCard
          label="Previous period"
          value={summary.previousTotal === null ? '—' : formatNumber(summary.previousTotal)}
          sub={previousAvailable ? `Preceding ${period} days` : 'No preceding-period coverage'}
          note={previousAvailable ? undefined : 'The trend does not reach back far enough for a comparison'}
        />
        <KpiCard
          label="Change"
          value={summary.delta === null ? 'n/a' : `${summary.delta.absolute >= 0 ? '+' : ''}${summary.delta.absolute}`}
          sub={summary.delta === null ? 'Comparison unavailable' : `vs previous ${period} days`}
          delta={summary.delta}
          tone={summary.delta && summary.delta.absolute < 0 ? 'red' : 'default'}
          note={summary.delta && summary.delta.pct === null ? 'Percentage undefined: previous period was 0' : undefined}
        />
        <KpiCard
          label="Daily average"
          value={metricsQ.loading || summary.coverageDays === 0 ? '—' : (summary.total / summary.coverageDays).toFixed(1)}
          sub={`Across ${summary.coverageDays} observed days`}
        />
      </div>

      <Card>
        <CardHeader
          title="Registration trend"
          subtitle={`${grouping} registrations over the last ${Math.min(period, trendDays)} days`}
        />
        <CardBody>
          {metricsQ.loading ? (
            <LoadingBlock rows={5} />
          ) : metricsQ.error ? (
            <ErrorState message={metricsQ.error} onRetry={metricsQ.refetch} />
          ) : grouped.length === 0 ? (
            <EmptyState title="No registration data" description="No registrations have been synchronized for this period." />
          ) : grouping === 'daily' ? (
            <TrendLineChart
              data={grouped.map((d) => ({ time: d.date, count: d.count }))}
              dataKey="count"
              name="Registrations"
              color="#B69A67"
              unit=""
            />
          ) : (
            <VolumeBarChart
              data={grouped.map((d) => ({ time: d.date, count: d.count }))}
              xKey="time"
              series={[{ key: 'count', name: 'Registrations', color: '#B69A67' }]}
            />
          )}
          <MetricNote>
            Source: platform-metrics registration counts ({metricsQ.data?.dataSource === 'rayern-sync' ? 'Rayern sync' : 'local registry'}).
            Each account is counted once, on its registration date.
          </MetricNote>
        </CardBody>
      </Card>

      {/* ---------------- Rayern funnel instrumentation (last 30 days) ------- */}
      <Card>
        <CardHeader
          title="Acquisition funnel"
          subtitle="First-party measurement over the last 30 days: visits → signup intent → registration → activation"
          actions={
            funnel && !funnel.hasVisitorData ? (
              <Badge tone="amber">No visitor data collected yet</Badge>
            ) : funnel === null ? (
              <Badge tone="neutral">Awaiting sync</Badge>
            ) : undefined
          }
        />
        <CardBody className="space-y-5">
          {instQ.loading ? (
            <LoadingBlock rows={4} />
          ) : instQ.error ? (
            <ErrorState message={instQ.error} onRetry={instQ.refetch} />
          ) : funnel === null ? (
            <UnavailablePanel
              title="Acquisition funnel"
              reason={funnelReason}
              required="Rayern’s `funnel` metrics block inside GET /internal/dashboard-metrics, picked up by the dashboard pull-sync."
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard
                  label="Visits · 30d"
                  value={formatCount(funnel.visits30d)}
                  sub={funnel.hasVisitorData ? 'First-party visit beacon' : 'Not collected yet'}
                  note={funnel.hasVisitorData ? undefined : 'No beacon has been received — this is unknown, not zero'}
                />
                <KpiCard
                  label="Signup intents · 30d"
                  value={formatCount(funnel.signupIntents30d)}
                  sub="Sessions that reached the sign-up page"
                />
                <KpiCard
                  label="Registrations · 30d"
                  value={formatCount(funnel.registrations30d)}
                  sub="Completed sign-ups in the window"
                />
                <KpiCard
                  label="Activated · 30d"
                  value={formatCount(funnel.activated30d)}
                  sub="Onboarding completed (provisional definition)"
                />
              </div>

              <div className="rounded-lg border border-ink-200 bg-ivory-50 px-4 py-3">
                <p className="text-sm font-medium text-ink-800">Attributed sign-ups</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-600">
                  <span className="font-semibold text-ink-900">{formatCount(funnel.attributedSignups30d)}</span> of{' '}
                  <span className="font-semibold text-ink-900">{formatCount(funnel.registrations30d)}</span> registrations
                  carried first-touch attribution (
                  {funnel.attributionCoveragePct !== null
                    ? `${funnel.attributionCoveragePct.toFixed(1)}% coverage`
                    : 'coverage not computable'}
                  ). Attributed sign-ups are a subset of total registrations, never a replacement for them.
                </p>
              </div>

              {funnel.daily.length > 0 ? (
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">
                    Daily funnel (30 days)
                  </p>
                  <VolumeBarChart
                    data={funnel.daily.map((d) => ({
                      time: d.date,
                      visits: d.visits,
                      intents: d.signupIntents,
                      registrations: d.registrations,
                      activated: d.activated,
                    }))}
                    xKey="time"
                    series={[
                      { key: 'visits', name: 'Visits', color: '#B69A67' },
                      { key: 'intents', name: 'Signup intents', color: '#D9CBB4' },
                      { key: 'registrations', name: 'Registrations', color: '#20201E' },
                      { key: 'activated', name: 'Activated', color: '#4f8f6d' },
                    ]}
                  />
                </div>
              ) : (
                <EmptyState
                  title="No daily funnel data"
                  description="Rayern returned no daily series for this window. Days with no data are not drawn as zero."
                />
              )}

              <MetricNote>
                Conversion from visits:{' '}
                {funnel.conversion.visitToRegistrationPct !== null
                  ? `${funnel.conversion.visitToRegistrationPct.toFixed(1)}% of visits`
                  : 'unavailable (no visitor data or a zero denominator)'}
                {' · '}
                visit → intent:{' '}
                {funnel.conversion.visitToIntentPct !== null
                  ? `${funnel.conversion.visitToIntentPct.toFixed(1)}% of visits`
                  : 'unavailable'}
                {' · '}intent → registration:{' '}
                {funnel.conversion.intentToRegistrationPct !== null
                  ? `${funnel.conversion.intentToRegistrationPct.toFixed(1)}% of signup intents`
                  : 'unavailable'}
                {' · '}registration → activation:{' '}
                {funnel.conversion.registrationToActivationPct !== null
                  ? `${funnel.conversion.registrationToActivationPct.toFixed(1)}% of registrations`
                  : 'unavailable'}
                .
              </MetricNote>
            </>
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {funnel && funnel.topSources.length > 0 ? (
          <Card>
            <CardHeader
              title="Acquisition sources"
              subtitle="First-touch referrer hostname reported with converted sign-ups"
            />
            <CardBody>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 bg-ivory-50 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                      <th scope="col" className="px-3 py-2.5">Source</th>
                      <th scope="col" className="px-3 py-2.5 text-right">Sign-ups</th>
                      <th scope="col" className="px-3 py-2.5 text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.topSources.map((s) => (
                      <tr key={s.source} className="border-b border-ink-100 last:border-0">
                        <td className="px-3 py-2.5 font-medium text-ink-800">{s.source}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{formatNumber(s.count)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink-600">
                          {funnel.registrations30d !== null && funnel.registrations30d > 0
                            ? `${((s.count / funnel.registrations30d) * 100).toFixed(1)}%`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <MetricNote>
                Share is measured against registrations in the same 30-day window; it is undefined (—) when that
                denominator is zero or unknown. Non-hostname values are bucketed by Rayern as <code>(other)</code>.
              </MetricNote>
            </CardBody>
          </Card>
        ) : (
          <UnavailablePanel
            title="Acquisition source breakdown"
            reason={
              funnel
                ? 'No attributable sources have been recorded for this window — no first-touch referrer or UTM values have arrived with sign-ups yet.'
                : funnelReason
            }
            required="First-touch referrer/UTM captured at registration and reported in Rayern’s `funnel.topSources`."
          />
        )}
        <UnavailablePanel
          title="New vs returning users"
          reason="Rayern now records activity events, but the metrics payload exposes only active-user counts and weekly cohorts — there is no new-versus-returning split to report."
          required="An aggregate that splits DAU/WAU/MAU into first-time and returning owners for each period."
        />
      </div>
    </div>
  )
}
