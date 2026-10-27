import { PageHeader } from '../components/PageHeader'
import { UnavailablePanel } from '../components/UnavailablePanel'
import { Card, CardBody, CardHeader } from '../components/ui/Card'

/**
 * Feedback — there is no feedback data source connected to the dashboard:
 * Rayern has no feedback table exposed to the aggregates channel and the
 * dashboard has no feedback endpoint. Nothing is listed here because nothing
 * can be listed honestly; the page documents exactly what would be required.
 */
export function FeedbackPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Feedback"
        description="Customer feedback, problems and feature requests."
        footnote="No feedback records are shown because no feedback data source is connected."
      />

      <UnavailablePanel
        title="Feedback inbox"
        reason="Neither Rayern's aggregates channel nor the dashboard backend exposes feedback records, so no list, count, category or resolution state can be displayed. Showing an unreviewed-count without the underlying messages would be misleading, so none is shown."
        required="A feedback table (id, account id, category, body, created_at, reviewed_at) written by an in-product feedback form, plus an admin-only list endpoint with pagination and a resolved flag."
      >
        <div className="mt-3 rounded-md border border-ink-200 bg-white px-3 py-2.5">
          <p className="text-xs font-semibold text-ink-800">Required backend surface (not implemented yet)</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-ink-600">
            <li>
              <code className="rounded bg-ivory-100 px-1">GET /feedback</code> — admin-only, paginated, filter by category
              and status.
            </li>
            <li>
              <code className="rounded bg-ivory-100 px-1">PATCH /feedback/:id</code> — mark reviewed/resolved, audit-logged.
            </li>
            <li>
              <code className="rounded bg-ivory-100 px-1">GET /feedback/summary</code> — aggregate counts for the Overview.
            </li>
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-500">
            Bodies are customer-authored content: the list must stay administrator-only and never appear in exports or
            aggregate analytics.
          </p>
        </div>
      </UnavailablePanel>

      <Card>
        <CardHeader title="What exists today" subtitle="Closest available signals" />
        <CardBody>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-ink-600">
            <li>
              <span className="font-medium text-ink-800">Support email</span> — inbound replies to{' '}
              <code className="rounded bg-ivory-100 px-1 text-xs">support@rayern.com.ng</code> are handled outside the
              dashboard.
            </li>
            <li>
              <span className="font-medium text-ink-800">Operational errors</span> — user-impacting failures surface on
              the Errors page from backend telemetry, not from user reports.
            </li>
            <li>
              <span className="font-medium text-ink-800">Consent changes</span> — opt-outs are recorded as marketing
              consent events on the Activity page.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}
