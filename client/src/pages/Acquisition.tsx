import { useMemo, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { PageHeader, PeriodSelector, REPORTING_TIMEZONE } from '../components/PageHeader'
import { MetricNote, UnavailablePanel } from '../components/UnavailablePanel'
import { LoadingBlock, ErrorState, EmptyState } from '../components/ui/states'
import { TrendLineChart, VolumeBarChart } from '../components/charts'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { platformMetricsService } from '../services/platformMetrics'
import { completeDailySeries, groupByMonth, groupByWeek, summariseTrend } from '../lib/period'
import { formatNumber } from '../lib/utils'

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
  usePageRefresh([metricsQ])

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
        footnote={`Reporting timezone: ${REPORTING_TIMEZONE} · boundaries are UTC calendar days.`}
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <UnavailablePanel
          title="Acquisition source breakdown"
          reason="Rayern does not record where a user came from, and the dashboard has no referrer or channel data, so source attribution cannot be reported."
          required="Capture a first-touch attribution (referrer or UTM parameters) at registration time in Rayern, persist it on the account, and expose an aggregate counts endpoint."
        />
        <UnavailablePanel
          title="New vs returning users"
          reason="Registration records only exist once per account, and there is no login or session instrumentation, so returning visitors cannot be distinguished from first-time ones."
          required="A session/login event stream aggregated server-side into new-versus-returning counts per day."
        />
      </div>

      <UnavailablePanel
        title="Visitor → registration conversion"
        reason="Website visitor counts require analytics instrumentation on the marketing site, which is not connected to this dashboard. No visitor numbers are estimated."
        required="Privacy-conscious page-view analytics (first-party, aggregated) plus a shared date range so visitors and registrations can be compared."
      />
    </div>
  )
}
