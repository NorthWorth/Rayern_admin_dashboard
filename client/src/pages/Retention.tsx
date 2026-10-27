import { useMemo, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { PageHeader, PeriodSelector, REPORTING_TIMEZONE } from '../components/PageHeader'
import { MetricNote, UnavailablePanel } from '../components/UnavailablePanel'
import { LoadingBlock, EmptyState, ErrorState } from '../components/ui/states'
import { VolumeBarChart } from '../components/charts'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { platformMetricsService } from '../services/platformMetrics'
import { groupByMonth, summariseTrend, completeDailySeries } from '../lib/period'
import { formatNumber, titleCase } from '../lib/utils'

/**
 * Retention & engagement.
 *
 * Meaningful activity is not instrumented in Rayern or the dashboard, so
 * DAU/WAU/MAU, day-N retention and returning-user rates are reported as
 * unavailable with the exact instrumentation they need. The page shows what
 * *is* verifiable — registration cohort sizes — clearly labelled as cohort
 * size, never as retention.
 */
export function RetentionPage() {
  const [period, setPeriod] = useState<7 | 30 | 90>(30)
  const metricsQ = useQuery(() => platformMetricsService.overview())
  usePageRefresh([metricsQ])

  const series = useMemo(() => completeDailySeries(metricsQ.data?.registrationsTrend ?? []), [metricsQ.data])
  const summary = useMemo(() => summariseTrend(series, period), [series, period])
  const monthly = useMemo(() => groupByMonth(series), [series])

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Retention & engagement"
        description="Returning usage, active-user counts and cohort durability."
        actions={<PeriodSelector value={period} onChange={setPeriod} />}
        footnote={`Reporting timezone: ${REPORTING_TIMEZONE} · cohorts are UTC registration months.`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'DAU', reason: 'Daily active users require per-day activity events, which do not exist.' },
          { label: 'WAU', reason: 'Weekly active users require per-day activity events, which do not exist.' },
          { label: 'MAU', reason: 'Monthly active users require per-day activity events, which do not exist.' },
          { label: 'Day-7 retention', reason: 'Retention needs returning-activity records per cohort; none are collected.' },
        ].map((m) => (
          <div key={m.label} className="rounded-lg border border-dashed border-ink-300 bg-ivory-50 px-4 py-3.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">{m.label}</p>
            <p className="mt-1.5 font-display text-3xl leading-none text-ink-300">—</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-600">Not measured. {m.reason}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Registration cohorts"
            subtitle="Accounts registered per UTC month — cohort size only, not retention"
            actions={
              <span className="rounded border border-sand-300 bg-sand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-700">
                Size only
              </span>
            }
          />
          <CardBody>
            {metricsQ.loading ? (
              <LoadingBlock rows={5} />
            ) : metricsQ.error ? (
              <ErrorState message={metricsQ.error} onRetry={metricsQ.refetch} />
            ) : monthly.length === 0 ? (
              <EmptyState title="No cohort data" description="Registration data has not been synchronized." />
            ) : (
              <>
                <VolumeBarChart
                  data={monthly.map((m) => ({ time: m.date, count: m.count }))}
                  xKey="time"
                  series={[{ key: 'count', name: 'Registrations', color: '#B69A67' }]}
                />
                <MetricNote>
                  These are cohort sizes from registration dates. Retention inside a cohort (how many came back) is not
                  measurable, so no survival percentage is shown.
                </MetricNote>
              </>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <KpiCard
            label={`New registrations · ${period}d`}
            value={metricsQ.loading ? '—' : formatNumber(summary.total)}
            sub={summary.previousTotal === null ? 'No preceding-period coverage' : `Previous: ${formatNumber(summary.previousTotal)}`}
            delta={summary.delta}
          />
          <UnavailablePanel
            title="New vs returning active users"
            reason="There is no activity stream to separate accounts returning from accounts acting for the first time."
            required="A daily, deduplicated meaningful-activity count per account, aggregated server-side."
          />
          <UnavailablePanel
            title="Time to first meaningful activity"
            reason="Requires both a registration timestamp and a first-activity timestamp; only the former exists."
            required="A first-activation event with a timestamp, joined to the registration date."
          />
        </div>
      </div>

      <Card>
        <CardHeader title="Metric definitions" subtitle="How each metric on this page is (or would be) defined" />
        <CardBody>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {[
              ['Meaningful activity (proposed)', 'A product outcome such as creating a client or advancing a project — not a login and not a page view.'],
              ['DAU / WAU / MAU', 'Distinct accounts with ≥1 meaningful activity in the last 1/7/30 UTC days.'],
              ['Day-N retention', 'Share of a registration cohort with meaningful activity on day N; immature cohorts are excluded until the window elapses.'],
              ['Reporting timezone', 'UTC for every boundary, matching how the backend buckets dates.'],
            ].map(([term, def]) => (
              <div key={term} className="rounded-md border border-ink-200 bg-ivory-50 px-3 py-2.5">
                <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">{term}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-ink-600">{def}</dd>
              </div>
            ))}
          </dl>
          <MetricNote>
            The proposed definitions are documented here deliberately: no active-user or retention figure is presented
            as authoritative until the underlying events exist and the definition is agreed.
          </MetricNote>
        </CardBody>
      </Card>

      <div className="rounded-lg border border-ink-200 bg-white px-4 py-3 text-xs text-ink-500">
        Known-good proxy for growth (not retention): {titleCase(series.length > 0 ? 'registrations' : 'no data')} over the
        selected window is shown on the <span className="font-medium text-ink-700">Acquisition</span> page.
      </div>
    </div>
  )
}
