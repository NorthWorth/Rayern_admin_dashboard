import { useMemo, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { PageHeader, PeriodSelector, REPORTING_TIMEZONE } from '../components/PageHeader'
import { MetricNote, UnavailablePanel } from '../components/UnavailablePanel'
import { LoadingBlock, EmptyState, ErrorState } from '../components/ui/states'
import { Badge } from '../components/ui/Badge'
import { TrendLineChart, VolumeBarChart } from '../components/charts'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { platformMetricsService } from '../services/platformMetrics'
import { rayernService } from '../services/rayern'
import { groupByMonth, summariseTrend, completeDailySeries } from '../lib/period'
import { formatDate, formatCount, formatNumber, rayernReasonText, timeAgo, titleCase } from '../lib/utils'

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
  const instQ = useQuery(() => rayernService.blocks())
  usePageRefresh([metricsQ, instQ])

  const engagement = instQ.data?.blocks.engagement ?? null
  const engagementReceived = instQ.data?.received.includes('engagement') ?? false
  const engagementReason = instQ.error
    ? `Instrumentation could not be loaded: ${instQ.error}`
    : engagementReceived && engagement === null
      ? 'Rayern reported this block as unavailable for this period — its aggregation failed upstream.'
      : rayernReasonText(engagement === null ? 'not_reported' : engagement.reason)

  const matureCohorts = engagement?.cohorts.filter((c) => c.mature) ?? []
  const latestMature = matureCohorts.length > 0 ? matureCohorts[matureCohorts.length - 1] : null

  const series = useMemo(() => completeDailySeries(metricsQ.data?.registrationsTrend ?? []), [metricsQ.data])
  const summary = useMemo(() => summariseTrend(series, period), [series, period])
  const monthly = useMemo(() => groupByMonth(series), [series])

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Retention & engagement"
        description="Returning usage, active-user counts and cohort durability."
        actions={<PeriodSelector value={period} onChange={setPeriod} />}
        footnote={`Reporting timezone: ${REPORTING_TIMEZONE} · cohorts are UTC registration months.${
          instQ.data?.syncedAt ? ` · instrumentation synced ${timeAgo(instQ.data.syncedAt)}` : ''
        }`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {engagement !== null && engagement.available ? (
          <>
            <KpiCard label="DAU" value={formatCount(engagement.dau)} sub="Distinct active owners · last UTC day" />
            <KpiCard label="WAU" value={formatCount(engagement.wau)} sub="Distinct active owners · rolling 7 days" />
            <KpiCard label="MAU" value={formatCount(engagement.mau)} sub="Distinct active owners · rolling 30 days" />
            <KpiCard
              label="Latest matured cohort"
              value={latestMature?.retentionPct != null ? `${latestMature.retentionPct.toFixed(1)}%` : '—'}
              sub={
                latestMature
                  ? `Week of ${formatDate(latestMature.weekStart)} · next-week retention`
                  : 'No weekly cohort has fully elapsed yet'
              }
              note={
                latestMature
                  ? undefined
                  : `Only ${matureCohorts.length} of ${engagement.cohorts.length} cohorts matured — the rest are not 0%`
              }
            />
          </>
        ) : (
          <>
            {[
              { label: 'DAU', reason: 'Daily active users need per-day activity events.' },
              { label: 'WAU', reason: 'Weekly active users need per-day activity events.' },
              { label: 'MAU', reason: 'Monthly active users need per-day activity events.' },
              { label: 'Day-7 retention', reason: 'Retention needs returning-activity records per cohort.' },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-dashed border-ink-300 bg-ivory-50 px-4 py-3.5">
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">{m.label}</p>
                <p className="mt-1.5 font-display text-3xl leading-none text-ink-300">—</p>
                <p className="mt-2 text-xs leading-relaxed text-ink-600">
                  Not measured. {instQ.loading ? 'Loading instrumentation…' : engagementReason}
                </p>
              </div>
            ))}
          </>
        )}
      </div>

      {engagement !== null && engagement.available ? (
        <>
          {engagement.dailyActiveUsers.length > 0 ? (
            <Card>
              <CardHeader
                title="Daily active users"
                subtitle="Distinct owners with at least one activity event per UTC day — 30-day series"
              />
              <CardBody>
                <TrendLineChart
                  data={engagement.dailyActiveUsers.map((d) => ({ time: d.date, count: d.count }))}
                  dataKey="count"
                  name="DAU"
                  color="#B69A67"
                  unit=""
                />
                <MetricNote>
                  Days with no recorded activity render as a gap, never as zero — Rayern’s instrumentation coverage
                  starts when events began being emitted, so earlier history does not exist.
                </MetricNote>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Weekly retention cohorts"
              subtitle="Monday-start registration cohorts with next-week retention"
              actions={
                <Badge tone={matureCohorts.length > 0 ? 'green' : 'neutral'}>
                  {matureCohorts.length} of {engagement.cohorts.length} matured
                </Badge>
              }
            />
            <CardBody>
              {engagement.cohorts.length === 0 ? (
                <EmptyState title="No cohorts" description="No weekly registration cohorts were returned." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-200 bg-ivory-50 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                        <th scope="col" className="px-3 py-2.5">Cohort week</th>
                        <th scope="col" className="px-3 py-2.5 text-right">Registered</th>
                        <th scope="col" className="px-3 py-2.5 text-right">Returned next week</th>
                        <th scope="col" className="px-3 py-2.5 text-right">Retention</th>
                        <th scope="col" className="px-3 py-2.5">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {engagement.cohorts.map((c) => (
                        <tr key={c.weekStart} className="border-b border-ink-100 last:border-0">
                          <td className="px-3 py-2.5 font-medium text-ink-800">{formatDate(c.weekStart)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{formatCount(c.size)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">
                            {formatCount(c.retainedNextWeek)}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-ink-800">
                            {c.retentionPct !== null ? `${c.retentionPct.toFixed(1)}%` : '—'}
                          </td>
                          <td className="px-3 py-2.5">
                            {c.mature ? (
                              <Badge tone="green">Observed</Badge>
                            ) : (
                              <Badge tone="neutral">Immature</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <MetricNote>
                Retention is next-week return within the cohort. An immature cohort shows “—” because its observation
                window has not elapsed — that is missing data, not a 0% result.
              </MetricNote>
            </CardBody>
          </Card>
        </>
      ) : instQ.loading ? (
        <Card>
          <CardBody>
            <LoadingBlock rows={5} />
          </CardBody>
        </Card>
      ) : (
        <UnavailablePanel
          title="Engagement (DAU / WAU / MAU and cohort retention)"
          reason={engagementReason}
          required="Rayern’s `engagement` metrics block, built from the activity stream, synchronized by the pull-sync worker."
        />
      )}

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
            reason="Rayern’s activity stream powers DAU/WAU/MAU and weekly cohorts, but the payload exposes no new-versus-returning split within those windows."
            required="An active-user aggregate that separates first-time actors from returning actors per period."
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
              ['DAU / WAU / MAU', 'Distinct owners with ≥1 activity event in the last 1/7/30 UTC days (Rayern `engagement` block).'],
              ['Day-N retention', 'Share of a registration cohort returning the following week; immature cohorts show “—” until the window elapses.'],
              ['Reporting timezone', 'UTC for every boundary, matching how the backend buckets dates.'],
            ].map(([term, def]) => (
              <div key={term} className="rounded-md border border-ink-200 bg-ivory-50 px-3 py-2.5">
                <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">{term}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-ink-600">{def}</dd>
              </div>
            ))}
          </dl>
          <MetricNote>
            Active-user and cohort figures come from Rayern’s activity events (best-effort emission, 180-day retention),
            so they cover only the period since instrumentation began. Historical values before that do not exist and are
            never estimated.
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
