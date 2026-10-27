import { useMemo, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { PageHeader, PeriodSelector, REPORTING_TIMEZONE } from '../components/PageHeader'
import { MetricNote } from '../components/UnavailablePanel'
import { Button } from '../components/ui/Button'
import { LoadingBlock, ErrorState } from '../components/ui/states'
import { DataTable, type Column } from '../components/DataTable'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { platformMetricsService } from '../services/platformMetrics'
import { workspacesService } from '../services/workspaces'
import { emailsService } from '../services/emails'
import { revenueService } from '../services/revenue'
import { completeDailySeries, groupByMonth, summariseTrend } from '../lib/period'
import { formatCurrencyMajor, formatNumber } from '../lib/utils'

interface Row {
  metric: string
  current: string
  previous: string | null
  change: string
  comparable: boolean
  note?: string
}

/**
 * Reports — period comparisons over the metrics that have reliable sources,
 * metric definitions and an aggregate-only CSV export. Nothing personal is
 * exported: every row is an aggregate.
 */
export function ReportsPage() {
  const [period, setPeriod] = useState<7 | 30 | 90>(30)

  const metricsQ = useQuery(() => platformMetricsService.overview())
  const wsQ = useQuery(() => workspacesService.stats())
  const emailsQ = useQuery(() => emailsService.stats())
  const revenueQ = useQuery(() => revenueService.state())
  usePageRefresh([metricsQ, wsQ, emailsQ, revenueQ])

  const series = useMemo(() => completeDailySeries(metricsQ.data?.registrationsTrend ?? []), [metricsQ.data])
  const summary = useMemo(() => summariseTrend(series, period), [series, period])
  const cohorts = useMemo(() => groupByMonth(series), [series])

  const billing = revenueQ.data?.kind === 'populated' ? revenueQ.data.billing : null

  const rows: Row[] = [
    {
      metric: 'Registered accounts',
      current: usersValue(metricsQ.data?.registeredAccounts),
      previous: null,
      change: 'n/a',
      comparable: false,
      note: 'Point-in-time total; the trend series carries no earlier total to compare against.',
    },
    {
      metric: `New sign-ups (${period}d)`,
      current: formatNumber(summary.total),
      previous: summary.previousTotal === null ? null : formatNumber(summary.previousTotal),
      change:
        summary.delta === null
          ? 'n/a'
          : `${summary.delta.absolute >= 0 ? '+' : ''}${summary.delta.absolute}${summary.delta.pct === null ? '' : ` (${summary.delta.pct >= 0 ? '+' : ''}${summary.delta.pct.toFixed(1)}%)`}`,
      comparable: summary.delta !== null,
      note: !summary.complete ? `Trend coverage ${summary.coverageDays}/${period} days` : undefined,
    },
    {
      metric: 'Workspaces',
      current: usersValue(wsQ.data?.total),
      previous: null,
      change: 'n/a',
      comparable: false,
      note: `New in last 30d: ${wsQ.data ? formatNumber(wsQ.data.newWorkspaces30d) : '—'}`,
    },
    {
      metric: 'Paying subscribers',
      current: billing ? formatNumber(billing.activePaidSubscribers) : '—',
      previous: null,
      change: 'n/a',
      comparable: false,
      note: 'From Rayern billing records (beta entitlements excluded)',
    },
    {
      metric: 'MRR',
      current: billing ? formatCurrencyMajor(billing.mrr.amountMajor, billing.currency) : '—',
      previous: null,
      change: 'n/a',
      comparable: false,
      note: billing ? `ARR ${formatCurrencyMajor(billing.arr.amountMajor, billing.currency)}` : 'Billing not synchronized',
    },
    {
      metric: 'Emails sent (30d)',
      current: emailsQ.data ? formatNumber(emailsQ.data.totalSent) : '—',
      previous: null,
      change: 'n/a',
      comparable: false,
      note: emailsQ.data ? `${formatNumber(emailsQ.data.failed)} failed` : undefined,
    },
  ]

  const columns: Array<Column<Row>> = [
    { key: 'metric', header: 'Metric', render: (r) => <span className="font-medium text-ink-800">{r.metric}</span> },
    { key: 'current', header: 'Current', align: 'right', render: (r) => <span className="tabular-nums text-ink-900">{r.current}</span> },
    {
      key: 'previous',
      header: `Previous ${period}d`,
      align: 'right',
      render: (r) => <span className="tabular-nums text-ink-600">{r.previous ?? '—'}</span>,
    },
    {
      key: 'change',
      header: 'Change',
      align: 'right',
      render: (r) => (
        <span className={r.comparable ? (r.change.startsWith('-') ? 'text-red-700' : 'text-emerald-700') : 'text-ink-400'}>
          {r.change}
        </span>
      ),
    },
    { key: 'note', header: 'Definition / note', render: (r) => <span className="text-xs text-ink-500">{r.note ?? '—'}</span> },
  ]

  function downloadCsv(): void {
    const header = ['metric', 'current', `previous_${period}d`, 'change', 'note']
    const lines = [header.join(',')]
    for (const r of rows) {
      lines.push(
        [r.metric, r.current, r.previous ?? '', r.comparable ? r.change : '', (r.note ?? '').replace(/,/g, ';')]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      )
    }
    for (const c of cohorts) {
      lines.push([`registrations_cohort_${c.date}`, String(c.count), '', '', 'UTC month, cohort size only'].map((v) => `"${v}"`).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `rayern-report-${period}d.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Reports"
        description="Period comparisons over verified aggregates, with definitions and an aggregate-only export."
        actions={
          <>
            <PeriodSelector value={period} onChange={setPeriod} />
            <Button variant="secondary" onClick={downloadCsv}>
              Export CSV
            </Button>
          </>
        }
        footnote={`Reporting timezone: ${REPORTING_TIMEZONE}. Export contains aggregate values only — no addresses, names or identifiers.`}
      />

      <Card>
        <CardHeader title="KPI comparison" subtitle={`Current window vs the equivalent preceding ${period} days`} />
        <CardBody>
          {metricsQ.loading ? (
            <LoadingBlock rows={4} />
          ) : metricsQ.error ? (
            <ErrorState message={metricsQ.error} onRetry={metricsQ.refetch} />
          ) : (
            <DataTable columns={columns} rows={rows} getRowKey={(r) => r.metric} />
          )}
          <MetricNote>
            A change is only shown when the source carries the preceding window. Totals without history are marked
            not-comparable rather than rendered as 0 %.
          </MetricNote>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Registration cohorts" subtitle="Cohort size by UTC month" />
          <CardBody>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ivory-50 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-3 py-2.5">Cohort (UTC month)</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Registrations</th>
                </tr>
              </thead>
              <tbody>
                {cohorts.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-3 py-6 text-center text-sm text-ink-500">No cohort data available.</td>
                  </tr>
                ) : (
                  cohorts.map((c) => (
                    <tr key={c.date} className="border-b border-ink-100 last:border-0">
                      <td className="px-3 py-2 text-ink-700">{c.date}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-900">{formatNumber(c.count)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <MetricNote>Cohort size only — retention inside a cohort requires activity instrumentation that does not exist.</MetricNote>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Metric definitions" subtitle="The same definition is used wherever a metric appears" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              {[
                ['Registered accounts', 'Distinct non-closed accounts reported by the platform-metrics aggregate.'],
                ['New sign-ups', 'Registrations whose UTC date falls inside the selected window; counted once per account.'],
                ['Paying subscribers', 'Active paid subscriptions in Rayern’s billing block; beta entitlements are not paying.'],
                ['MRR / ARR', 'Rendered exactly as Rayern reports them; never recalculated in the dashboard.'],
                ['Reporting timezone', 'UTC for every date boundary (matches the backend’s date bucketing).'],
              ].map(([term, def]) => (
                <div key={term}>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">{term}</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-ink-600">{def}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function usersValue(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : formatNumber(v)
}
