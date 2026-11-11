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
import { rayernService } from '../services/rayern'
import { formatNumber, rayernReasonText, timeAgo } from '../lib/utils'

type StageState = 'measured' | 'unavailable'

interface Stage {
  name: string
  definition: string
  state: StageState
  value: string
  detail?: string
  reason?: string
  required?: string
  /** How the stage's conversion denominator is described in the UI. */
  denomLabel?: string
}

/**
 * Funnels — Website visitor → Signup intent → Registered → Onboarding →
 * Activated → Retained → Paid customer.
 *
 * Stages 1–4 come from Rayern's `funnel` metrics block when it has been
 * synchronized; every other stage is explicitly unavailable with the reason it
 * cannot be measured. No stage is invented and no conversion rate is
 * fabricated: a percentage only appears when both stages are measured and the
 * denominator is a non-zero count.
 */
export function FunnelsPage() {
  const usersQ = useQuery(() => usersService.stats())
  const revenueQ = useQuery(() => revenueService.state())
  const instQ = useQuery(() => rayernService.blocks())
  usePageRefresh([usersQ, revenueQ, instQ])

  const funnel = instQ.data?.blocks.funnel ?? null
  const funnelReceived = instQ.data?.received.includes('funnel') ?? false
  /** Why the funnel block itself is missing — never rendered as zeroes. */
  const funnelBlockReason = instQ.error
    ? `Instrumentation could not be loaded: ${instQ.error}`
    : funnelReceived && funnel === null
      ? 'Rayern reported this block as unavailable for this period — its aggregation failed upstream, so no values exist.'
      : rayernReasonText('not_reported')
  const visitorNoDataReason =
    funnel && !funnel.hasVisitorData
      ? 'Visitor tracking has not collected any data yet — no first-party visit beacon has been received, so no visit count exists.'
      : funnelBlockReason

  const totalRegistered = usersQ.data?.totalUsers ?? null
  const paid = revenueQ.data?.kind === 'populated' ? revenueQ.data.billing.activePaidSubscribers : null

  const registeredValue = funnel?.registrations30d ?? totalRegistered

  const stages: Stage[] = [
    {
      name: 'Website visitor',
      definition: 'Unique visitor to the Rayern marketing site or app entry point (first-party beacon, deduplicated per browser per UTC day).',
      state: funnel !== null && funnel.visits30d !== null ? 'measured' : 'unavailable',
      value: funnel?.visits30d != null ? formatNumber(funnel.visits30d) : '—',
      detail: funnel?.visits30d != null ? 'Rayern funnel block · visits over the last 30 days' : undefined,
      reason: funnel?.visits30d != null ? undefined : visitorNoDataReason,
      required:
        funnel?.visits30d != null
          ? undefined
          : 'The landing-page and SPA visit beacon reported in Rayern’s funnel block.',
      denomLabel: 'visits',
    },
    {
      name: 'Signup intent',
      definition: 'Sessions that reached the sign-up page (fired once per session when it mounts).',
      state: funnel !== null && funnel.signupIntents30d !== null ? 'measured' : 'unavailable',
      value: funnel?.signupIntents30d != null ? formatNumber(funnel.signupIntents30d) : '—',
      detail: funnel?.signupIntents30d != null ? 'Rayern funnel block · last 30 days' : undefined,
      reason: funnel?.signupIntents30d != null ? undefined : funnelBlockReason,
      required: funnel?.signupIntents30d != null ? undefined : 'The signup-intent beacon reported in Rayern’s funnel block.',
      denomLabel: 'signup intents',
    },
    {
      name: 'Registered',
      definition: 'Distinct accounts that exist (status not closed), counted once.',
      state: registeredValue === null ? 'unavailable' : 'measured',
      value: registeredValue === null ? '—' : formatNumber(registeredValue),
      detail:
        funnel?.registrations30d != null
          ? 'Rayern funnel block · last 30 days'
          : totalRegistered !== null
            ? 'All-time total from the platform-metrics accounts aggregate (30-day window not yet synchronized)'
            : 'Loading',
      denomLabel: 'registrations',
    },
    {
      name: 'Onboarding completed',
      definition: 'Accounts that finished Rayern’s onboarding checklist (email verified, first client, first project, first task).',
      state: 'unavailable',
      value: '—',
      reason:
        'Rayern’s onboarding endpoint is self-service (the caller’s own state only), so no administrator-facing aggregate of onboarding completion exists.',
      required: 'An onboarding-completion aggregate in the metrics payload, derived server-side from `onboarding.completedAt`.',
    },
    {
      name: 'Activated',
      definition:
        'Accounts whose onboarding completedAt is set — Rayern’s activation definition (email verified, first client, first project, first task). Provisional pending product sign-off.',
      state: funnel !== null && funnel.activated30d !== null ? 'measured' : 'unavailable',
      value: funnel?.activated30d != null ? formatNumber(funnel.activated30d) : '—',
      detail: funnel?.activated30d != null ? 'Rayern funnel block · activated in the last 30 days' : undefined,
      reason: funnel?.activated30d != null ? undefined : funnelBlockReason,
      required: funnel?.activated30d != null ? undefined : 'The activation count in Rayern’s funnel block.',
      denomLabel: 'registrations',
    },
    {
      name: 'Retained',
      definition: 'Accounts still performing meaningful activity after a fixed horizon (e.g. day-30).',
      state: 'unavailable',
      value: '—',
      reason:
        'The funnel block carries no retained-stage count. Weekly cohort retention is a different measurement and lives on the Retention page.',
      required: 'A retained-count field in the funnel block, or an agreed funnel-level retention definition.',
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
      denomLabel: 'registered accounts',
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
        footnote={`Reporting timezone: ${REPORTING_TIMEZONE} · each account is deduplicated inside a stage.${
          instQ.data?.syncedAt ? ` · instrumentation synced ${timeAgo(instQ.data.syncedAt)}` : ''
        }`}
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
                const prevCount = prev?.state === 'measured' ? Number(prev.value.replace(/,/g, '')) : null
                const stageCount = stage.state === 'measured' ? Number(stage.value.replace(/,/g, '')) : null
                // A percentage needs a measured, non-zero denominator. A zero or
                // unknown denominator produces no figure at all — never Infinity,
                // NaN or a misleading 0%.
                const conversion =
                  stageCount !== null && prevCount !== null && prevCount > 0
                    ? (stageCount / prevCount) * 100
                    : null
                const denominatorIsZero = stageCount !== null && prevCount === 0
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
                          <p className="mt-1 text-xs text-ink-600">
                            {conversion.toFixed(1)}% of {prev?.denomLabel ?? 'previous stage'}
                          </p>
                        ) : denominatorIsZero ? (
                          <p className="mt-1 text-xs text-ink-400">Conversion undefined — denominator is 0</p>
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
            Each conversion is the stage divided by the stage named beneath it; funnel-stage counts cover the last 30
            days. Registered → paid conversion:{' '}
            {registeredToPaid !== null ? `${registeredToPaid.toFixed(1)}%` : 'unavailable (a stage is missing data)'}.
            {funnel === null
              ? ' Funnel-stage conversions appear once Rayern’s funnel block has been synchronized.'
              : ' Stages without data show “—” and are never counted as zero.'}
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
