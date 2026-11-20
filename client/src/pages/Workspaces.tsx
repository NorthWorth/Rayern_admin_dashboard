import { PageHeader } from '../components/PageHeader'
import { UnavailablePanel } from '../components/UnavailablePanel'
import { Card, CardBody, CardHeader } from '../components/ui/Card'

/**
 * Workspaces — Rayern exposes no administrative workspace directory.
 *
 * The dashboard's local `workspaces` table has no writer: no ingestion path,
 * no sync section and no Rayern endpoint ever populates it, so the previous
 * "Workspace registrations" table could only ever render an empty page (or, in
 * demo mode, invented rows). A directory built from aggregate counts would be
 * fabrication, so the page states exactly what is missing instead.
 *
 * Workspace *aggregates* (total, new in 30 days, plan mix, average members) do
 * exist and are authoritative — they arrive in Rayern's synced metrics payload
 * and are shown on Overview, Adoption and Revenue.
 */
export function WorkspacesPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Workspaces"
        description="Per-workspace directory — name, plan, creation date and owner."
        footnote="No workspace records are listed because no authoritative workspace directory exists to list."
      />

      <UnavailablePanel
        title="Workspace directory"
        reason="Rayern has no administrator workspace endpoint. Its workspace routes (/api/v1/workspace/*) are scoped to the caller's own membership and expose nothing administrative, and the dashboard's local workspaces table is never written — it is a leftover of the original scaffold, not a source of workspace records. Showing its (always empty) rows, or splitting an aggregate total into invented rows, would misrepresent both the feature and the data."
        required="An admin-only, paginated workspace directory in Rayern, for example GET /api/v1/admin/workspaces?page&limit&search&plan returning { id, name, plan, status?, createdAt, memberCount, owner: { id, email }? } for administrators only, with plan counts computed in the same query so the plan aggregation cannot drift from the list."
      >
        <div className="mt-3 rounded-md border border-ink-200 bg-white px-3 py-2.5">
          <p className="text-xs font-semibold text-ink-800">Required upstream contract (not implemented)</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-ink-600">
            <li>
              <code className="rounded bg-ivory-100 px-1">GET /api/v1/admin/workspaces</code> — <code>requireAuth</code> +{' '}
              <code>requireAdmin</code>, paginated, server-side search over name, plan filter, deterministic sort.
            </li>
            <li>Owner projected as id + email only, and only for administrators.</li>
            <li>Plan counts returned with the page so totals and filtering agree.</li>
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-500">
            This dashboard cannot create that endpoint: the Rayern repository is read-only from here.
          </p>
        </div>
      </UnavailablePanel>

      <Card>
        <CardHeader title="What is available today" subtitle="Authoritative workspace aggregates" />
        <CardBody>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-ink-600">
            <li>
              <span className="font-medium text-ink-800">Overview</span> — total workspaces, new workspaces (30 days),
              average members per workspace and the plan breakdown, all from Rayern's synced metrics payload.
            </li>
            <li>
              <span className="font-medium text-ink-800">Adoption</span> — workspace adoption and inactive-workspace
              measurement, when Rayern supplies those aggregate blocks.
            </li>
            <li>
              <span className="font-medium text-ink-800">Revenue</span> — plan-level subscription counts, which are
              workspace counts by plan rather than individual workspaces.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}
