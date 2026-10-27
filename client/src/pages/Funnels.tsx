import { Link } from 'react-router-dom'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { PageHeader, REPORTING_TIMEZONE } from '../components/PageHeader'
import { MetricNote, UnavailablePanel } from '../components/UnavailablePanel'
import { LoadingBlock, ErrorState } from '../components/ui/states'
import { Badge } from '../components/ui/Badge'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { usersService } from '../services/users'
import { revenueService } from '../services/revenue'
import { formatNumber } from '../lib/utils'

type StageState = 'measured' | 'unavailable'

interface Stage {
  name: string
  definition: string
  state: StageState
  value: string
  detail?: string
  reason?: string
  required?: string
}

/**
 * Funnels — Website visitor → Registered → Onboarding completed → Activated →
 * Retained → Paid customer.
 *
 * Only stages with an authoritative source are counted. Every other stage is
 * explicitly unavailable with the instrumentation it needs: no stage is
 * invented and no conversion rate is fabricated.
 */
export function FunnelsPage() {
  const usersQ = useQuery(() => usersService.stats())
  const revenueQ = useQuery(() => revenueService.state())
  usePageRefresh([usersQ, revenueQ])

  const totalRegistered = usersQ.data?.totalUsers ?? null
  const paid = revenueQ.data?.kind === 'populated' ? revenueQ.data.billing.activePaidSubscribers : null

  const stages: Stage[] = [
    {
      name: 'Website visitor',
      definition: 'Unique visitor to the Rayern marketing site or app entry point.',
      state: 'unavailable',
      value: '—',
      reason: 'No analytics instrumentation exists for site visitors; counting them would be a guess.',
      required: 'First-party aggregated page-view analytics, exposed as a daily unique-visitor count.',
    },
    {
      name: 'Registered',
      definition: 'Distinct accounts that exist (status not closed), counted once.',
      state: totalRegistered === null ? 'unavailable' : 'measured',
      value: totalRegistered === null ? '—' : formatNumber(totalRegistered),
      detail: totalRegistered === null ? 'Loading' : 'From the platform-metrics accounts aggregate',
    },
    {
      name: 'Onboarding completed',
      definition: 'Accounts that finished Rayern’s first-run onboarding checklist.',
      state: 'unavailable',
      value: '—',
      reason: 'Rayern has no onboarding completion record available to the dashboard.',
      required: 'An onboarding-completed flag or event on the account, synchronized with the aggregates.',
    },
    {
      name: 'Activated',
      definition: 'Accounts that performed a defined meaningful product outcome (proposed: created a first client and completed its first project step).',
      state: 'unavailable',
      value: '—',
      reason: 'Activation requires product-outcome events that are not instrumented; no activation count exists.',
      required: 'Agreed activation definition plus first-use events (e.g. client created) reported per account, without exposing workspace content.',
    },
    {
      name: 'Retained',
      definition: 'Accounts still performing meaningful activity after a fixed horizon (e.g. day-30).',
      state: 'unavailable',
      value: '—',
      reason: 'There is no activity instrumentation, so returning usage cannot be measured.',
      required: 'A privacy-preserving activity signal aggregated per account and per day.',
    },
    {
      name: 'Paid customer',
      definition: 'Accounts with an active paid subscription in Rayern’s billing records (beta entitlements excluded).',
      state: paid === null ? 'unavailable' : 'measured',
      value: paid === null ? '—' : formatNumber(paid),
      detail: paid === null
        ? revenueQ.data?.kind === 'unavailable'
          ? 'No billing data synchronized yet'
          : 'Loading'
        : 'From Rayern’s billing block',
    },
  ]

  const measured = stages.filter((s) => s.state === 'measured')
  const registeredToPaid =
    totalRegistered !== null && paid !== null && totalRegistered > 0 ? (paid / totalRegistered) * 100 : null

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Conversion funnels"
        description="Visitor to paid, stage by stage — with unavailable stages named rather than estimated."
        footnote={`Reporting timezone: ${REPORTING_TIMEZONE} · each account is deduplicated inside a stage.`}
      />

      <Card>
        <CardHeader title="Funnel stages" subtitle={`${measured.length} of ${stages.length} stages measurable today`} />
        <CardBody className="space-y-4">
          {usersQ.loading ? (
            <LoadingBlock rows={4} />
          ) : usersQ.error ? (
            <ErrorState message={usersQ.error} onRetry={usersQ.refetch} />
          ) : (
            <ol className="space-y-3">
              {stages.map((stage, i) => {
                const prev = i > 0 ? stages[i - 1] : null
                const conversion =
                  stage.state === 'measured' && prev?.state === 'measured' && prev.value !== '—'
                    ? (Number(stage.value.replace(/,/g, '')) / Number(prev.value.replace(/,/g, ''))) * 100
                    : null
                const prevCount = prev?.state === 'measured' ? Number(prev.value.replace(/,/g, '')) : null
                const stageCount = stage.state === 'measured' ? Number(stage.value.replace(/,/g, '')) : null
                const dropOff = prevCount !== null && stageCount !== null ? prevCount - stageCount : null

                return (
                  <li
                    key={stage.name}
                    className={
                      'rounded-lg border px-4 py-3 ' +
                      (stage.state === 'measured' ? 'border-ink-200 bg-white' : 'border-dashed border-ink-300 bg-ivory-50')
                    }
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                          <span className="tabular-nums text-ink-400">{i + 1}.</span> {stage.name}
                          <Badge tone={stage.state === 'measured' ? 'green' : 'neutral'}>
                            {stage.state === 'measured' ? 'Measured' : 'Not measured'}
                          </Badge>
                        </p>
                        <p className="mt-1 text-xs text-ink-600">{stage.definition}</p>
                        {stage.detail ? <p className="mt-1 text-[11px] text-ink-400">{stage.detail}</p> : null}
                        {stage.reason ? (
                          <p className="mt-1.5 text-xs text-ink-600">{stage.reason}</p>
                        ) : null}
                        {stage.required ? (
                          <p className="mt-1 text-[11px] text-ink-500">
                            <span className="font-medium text-ink-600">To measure it: </span>
                            {stage.required}
                          </p>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-display text-2xl leading-none tabular-nums text-ink-900">{stage.value}</p>
                        {conversion !== null ? (
                          <p className="mt-1 text-xs text-ink-600">{conversion.toFixed(1)}% of previous stage</p>
                        ) : null}
                        {dropOff !== null && dropOff > 0 ? (
                          <p className="text-xs text-red-700">{formatNumber(dropOff)} dropped off</p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

          <MetricNote>
            Registered → paid conversion:{' '}
            {registeredToPaid !== null ? `${registeredToPaid.toFixed(1)}%` : 'unavailable (a stage is missing data)'}.
            Intermediate conversions cannot be computed because their stages are not measured.
          </MetricNote>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <UnavailablePanel
          title="Stage definitions are provisional"
          reason="Activation and retention definitions must be agreed with the product before they are treated as authoritative business KPIs. The proposed activation definition above is a proposal, not a measurement."
          required="Sign-off on the activation definition, then the event instrumentation described on each unavailable stage."
        />
        <div className="rounded-lg border border-ink-200 bg-white px-4 py-4">
          <p className="text-sm font-medium text-ink-800">Related data</p>
          <ul className="mt-2 space-y-1.5 text-sm text-ink-600">
            <li>
              <Link to="/users" className="font-medium text-champagne-700 hover:text-champagne-800">
                Users →
              </Link>{' '}
              registration and verification detail
            </li>
            <li>
              <Link to="/revenue" className="font-medium text-champagne-700 hover:text-champagne-800">
                Revenue →
              </Link>{' '}
              subscription and billing detail
            </li>
            <li>
              <Link to="/acquisition" className="font-medium text-champagne-700 hover:text-champagne-800">
                Acquisition →
              </Link>{' '}
              registration trend feeding the top of the funnel
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
