import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { KpiCard } from '../components/KpiCard'
import { PageHeader, REPORTING_TIMEZONE } from '../components/PageHeader'
import { MetricNote, UnavailablePanel } from '../components/UnavailablePanel'
import { LoadingBlock, ErrorState } from '../components/ui/states'
import { Badge } from '../components/ui/Badge'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { workspacesService } from '../services/workspaces'
import { platformMetricsService } from '../services/platformMetrics'
import { formatNumber, titleCase } from '../lib/utils'

/**
 * Core Rayern modules. Workspace-level usage is measured per module (share of
 * workspaces that have used it at least once) — deliberately distinct from
 * event volumes such as "number of projects created".
 */
const MODULES: Array<{ name: string; level: 'workspace' | 'workspace-events'; note: string }> = [
  { name: 'Clients', level: 'workspace', note: 'Workspaces with at least one client record.' },
  { name: 'Leads', level: 'workspace', note: 'Workspaces with at least one lead record.' },
  { name: 'Projects', level: 'workspace', note: 'Workspaces with at least one project.' },
  { name: 'Tasks', level: 'workspace', note: 'Workspaces with at least one task.' },
  { name: 'Deliverables & reviews', level: 'workspace', note: 'Workspaces with a deliverable or review action.' },
  { name: 'Follow-ups', level: 'workspace', note: 'Workspaces with at least one follow-up.' },
  { name: 'Meetings', level: 'workspace', note: 'Workspaces with at least one meeting.' },
  { name: 'Notifications', level: 'workspace', note: 'Workspaces with generated notifications.' },
]

/**
 * Product adoption — which modules workspaces actually use.
 *
 * The dashboard aggregates workspace *registrations* only; Rayern exposes no
 * per-module usage data, so every adoption percentage is reported as
 * unavailable with the minimal instrumentation required instead of being
 * inferred from unrelated counts.
 */
export function AdoptionPage() {
  const wsQ = useQuery(() => workspacesService.stats())
  const metricsQ = useQuery(() => platformMetricsService.overview())
  usePageRefresh([wsQ, metricsQ])

  const total = wsQ.data?.total ?? null

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Product adoption"
        description="Which of Rayern's core modules workspaces are actually using."
        footnote={`Reporting timezone: ${REPORTING_TIMEZONE} · adoption is measured at workspace level unless stated otherwise.`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Workspaces"
          value={wsQ.loading ? '—' : formatNumber(total ?? 0)}
          sub="Registered workspaces"
        />
        <KpiCard
          label="New workspaces · 30d"
          value={wsQ.loading ? '—' : formatNumber(wsQ.data?.newWorkspaces30d ?? 0)}
          sub="Registration window fixed at 30 days by the source"
        />
        <KpiCard
          label="Avg members / workspace"
          value={wsQ.loading ? '—' : String(wsQ.data?.avgMembersPerWorkspace ?? '—')}
          sub="From the workspace aggregate"
        />
        <KpiCard label="Modules with usage data" value="0" sub="of 8 core modules instrumented" tone="amber" />
      </div>

      <Card>
        <CardHeader
          title="Module adoption"
          subtitle="Share of workspaces that have used each module at least once"
          actions={
            <Badge tone="neutral">Awaiting instrumentation</Badge>
          }
        />
        <CardBody>
          {wsQ.loading ? (
            <LoadingBlock rows={5} />
          ) : wsQ.error ? (
            <ErrorState message={wsQ.error} onRetry={wsQ.refetch} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 bg-ivory-50 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-3 py-2.5">Module</th>
                    <th scope="col" className="px-3 py-2.5">Measurement level</th>
                    <th scope="col" className="px-3 py-2.5">Definition</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Workspaces using it</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {MODULES.map((m) => (
                    <tr key={m.name} className="border-b border-ink-100 last:border-0">
                      <td className="px-3 py-2.5 font-medium text-ink-800">{m.name}</td>
                      <td className="px-3 py-2.5 text-ink-600">{m.level === 'workspace' ? 'Workspace-level' : 'Event-level'}</td>
                      <td className="px-3 py-2.5 text-xs text-ink-500">{m.note}</td>
                      <td className="px-3 py-2.5 text-right text-ink-400">Not measured</td>
                      <td className="px-3 py-2.5 text-right text-ink-400">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <MetricNote>
            Workspaces registered: {total === null ? '—' : formatNumber(total)}. A module's *usage* count is a different
            metric from the number of records created (e.g. projects) and is never substituted for it.
          </MetricNote>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <UnavailablePanel
          title="Adoption by registration cohort"
          reason="Cohort adoption needs first-use timestamps per module per workspace; neither exists in the aggregated data the dashboard receives."
          required="A per-workspace first-used-at timestamp per module, aggregated to counts before it leaves Rayern (no record-level content)."
        />
        <UnavailablePanel
          title="Workspaces with no meaningful usage"
          reason="Determining inactive workspaces requires activity data; only registration metadata is available today."
          required="A per-workspace activity heartbeat (e.g. last meaningful action date) exposed as an aggregate count."
        />
      </div>

      <div className="rounded-lg border border-ink-200 bg-white px-4 py-3 text-sm text-ink-600">
        <p className="font-medium text-ink-800">Related</p>
        <p className="mt-1 text-xs">
          Workspace registrations and plan mix live on the <span className="font-medium text-ink-700">Workspaces</span> page
          ({wsQ.data ? formatNumber(wsQ.data.total) : '—'} total, plans:{' '}
          {(metricsQ.data?.planBreakdown ?? []).map((p) => titleCase(p.plan)).join(', ') || 'none recorded'}).
        </p>
      </div>
    </div>
  )
}
