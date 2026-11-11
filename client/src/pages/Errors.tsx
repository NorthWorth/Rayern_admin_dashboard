import { useEffect, useState } from 'react'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { SearchInput } from '../components/SearchInput'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { Drawer } from '../components/ui/Drawer'
import { Select } from '../components/ui/Input'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/states'
import { UnavailablePanel } from '../components/UnavailablePanel'
import { errorsService } from '../services/errors'
import { rayernService } from '../services/rayern'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useQuery } from '../hooks/useQuery'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { formatCount, formatDateTime, rayernReasonText, timeAgo } from '../lib/utils'
import { CLIENT_ERROR_CONFIG_HINT, CLIENT_ERROR_KIND_LABELS } from '../lib/types'
import type { ErrorEntry, ErrorSeverity } from '../lib/types'

function severityTone(s: ErrorSeverity): 'neutral' | 'amber' | 'red' {
  switch (s) {
    case 'critical': return 'red'
    case 'high': return 'red'
    case 'medium': return 'amber'
    default: return 'neutral'
  }
}

export function ErrorsPage() {
  const [search, setSearch] = useState('')
  const [severity, setSeverity] = useState<ErrorSeverity | 'all'>('all')
  const [selected, setSelected] = useState<ErrorEntry | null>(null)
  const debouncedSearch = useDebouncedValue(search)

  useEffect(() => {}, [debouncedSearch])

  const listQ = useQuery(
    () => errorsService.list({ search: debouncedSearch, severity }),
    [debouncedSearch, severity],
  )
  const instQ = useQuery(() => rayernService.blocks())
  usePageRefresh([listQ, instQ])

  const clientErrors = instQ.data?.blocks.clientErrors ?? null
  const clientErrorsReason = instQ.error
    ? `Instrumentation could not be loaded: ${instQ.error}`
    : rayernReasonText('not_reported')

  const errors = listQ.data ?? []

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <Card>
        <CardHeader
          title="Client-reported errors"
          subtitle="Errors the browser told Rayern about — distinct from the server log and from synthetic checks"
          actions={
            clientErrors === null ? <Badge tone="neutral">Awaiting sync</Badge> : <Badge tone="green">Rayern reported</Badge>
          }
        />
        {instQ.loading ? (
          <CardBody>
            <LoadingBlock rows={4} />
          </CardBody>
        ) : instQ.error ? (
          <ErrorState message={instQ.error} onRetry={instQ.refetch} />
        ) : clientErrors === null ? (
          <CardBody>
            <UnavailablePanel
              title="Client-side error telemetry"
              reason={clientErrorsReason}
              required="Rayern’s `clientErrors` metrics block, built from POST /api/v1/telemetry/client-errors."
            />
          </CardBody>
        ) : (
          <CardBody className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-ink-200 bg-white px-4 py-3.5">
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">Total · 30d</p>
                <p className="mt-1.5 font-display text-3xl leading-none tabular-nums text-ink-900">
                  {formatCount(clientErrors.total)}
                </p>
                <p className="mt-1.5 text-xs text-ink-500">Browser-reported, deduplicated per session</p>
              </div>
              <div className="rounded-lg border border-ink-200 bg-white px-4 py-3.5">
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">Affected endpoints</p>
                <p className="mt-1.5 font-display text-3xl leading-none tabular-nums text-ink-900">
                  {clientErrors.topEndpoints.length}
                </p>
                <p className="mt-1.5 text-xs text-ink-500">Route templates, never full paths</p>
              </div>
              <div className="rounded-lg border border-ink-200 bg-white px-4 py-3.5">
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">Last occurrence</p>
                <p className="mt-2 text-sm font-medium text-ink-900">
                  {clientErrors.lastOccurredAt ? timeAgo(clientErrors.lastOccurredAt) : '—'}
                </p>
                <p className="mt-1.5 text-xs text-ink-500">
                  {clientErrors.lastOccurredAt ? formatDateTime(clientErrors.lastOccurredAt) : 'Not reported'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">By kind</p>
                {clientErrors.byKind.length === 0 ? (
                  <p className="rounded-md border border-dashed border-ink-300 bg-ivory-50 px-3 py-3 text-xs text-ink-600">
                    No kinds reported for this window.
                  </p>
                ) : (
                  <ul className="divide-y divide-ink-100 rounded-md border border-ink-200 bg-white">
                    {clientErrors.byKind.map((k) => (
                      <li key={k.kind} className="px-3 py-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-ink-800">
                            {CLIENT_ERROR_KIND_LABELS[k.kind] ?? k.kind}
                          </span>
                          <span className="tabular-nums text-sm text-ink-700">{formatCount(k.count)}</span>
                        </div>
                        {CLIENT_ERROR_CONFIG_HINT[k.kind] ? (
                          <p className="mt-1 text-xs leading-relaxed text-amber-700">
                            {CLIENT_ERROR_CONFIG_HINT[k.kind]}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">
                  Top endpoint templates
                </p>
                {clientErrors.topEndpoints.length === 0 ? (
                  <p className="rounded-md border border-dashed border-ink-300 bg-ivory-50 px-3 py-3 text-xs text-ink-600">
                    No endpoint templates reported for this window.
                  </p>
                ) : (
                  <ul className="divide-y divide-ink-100 rounded-md border border-ink-200 bg-white">
                    {clientErrors.topEndpoints.map((e) => (
                      <li key={e.endpoint} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <code className="truncate text-[13px] text-ink-700">{e.endpoint}</code>
                        <span className="shrink-0 tabular-nums text-sm text-ink-700">{formatCount(e.count)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <p className="rounded-md border border-ink-200 bg-ivory-50 px-3 py-2.5 text-xs leading-relaxed text-ink-600">
              These are reported by the browser and scrubbed twice (client, then Rayern) before storage: no request
              bodies, headers, tokens or credentials are ever included. Server-side failures are listed below and in the
              server log on the Observability page; synthetic-probe results live on System.
            </p>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Recent errors"
          subtitle="Grouped operational errors across services"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search message, endpoint, trace…" className="w-72" />
              <Select aria-label="Filter by severity" value={severity} onChange={(e) => setSeverity(e.target.value as ErrorSeverity | 'all')} className="w-36">
                <option value="all">All severities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            </div>
          }
        />
        {listQ.loading ? (
          <CardBody><LoadingBlock rows={8} /></CardBody>
        ) : listQ.error ? (
          <ErrorState message={listQ.error} onRetry={listQ.refetch} />
        ) : errors.length === 0 ? (
          <EmptyState title="No errors match" description="Adjust the search or severity filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  <th scope="col" className="px-4 py-2.5">Severity</th>
                  <th scope="col" className="px-3 py-2.5">Service / endpoint</th>
                  <th scope="col" className="px-3 py-2.5">Message</th>
                  <th scope="col" className="px-3 py-2.5">Status</th>
                  <th scope="col" className="px-3 py-2.5 text-right">Count</th>
                  <th scope="col" className="px-3 py-2.5">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer border-b border-ink-100 last:border-0 hover:bg-ink-50/70"
                    onClick={() => setSelected(e)}
                  >
                    <td className="px-4 py-2.5"><Badge tone={severityTone(e.severity)}>{titleCase(e.severity)}</Badge></td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink-800">{e.service}</p>
                      <p className="text-xs text-ink-500">{e.method} {e.endpoint}</p>
                    </td>
                    <td className="max-w-[20rem] px-3 py-2.5"><p className="truncate text-ink-700">{e.message}</p></td>
                    <td className="px-3 py-2.5"><code className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-semibold text-ink-700">{e.statusCode}</code></td>
                    <td className="px-3 py-2.5 text-right text-ink-700">{e.count}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-600">{timeAgo(e.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ErrorDetailDrawer error={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function ErrorDetailDrawer({ error, onClose }: { error: ErrorEntry | null; onClose: () => void }) {
  return (
    <Drawer open={error !== null} onClose={onClose} title="Error detail">
      {error ? (
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2">
            <Badge tone={severityTone(error.severity)}>{titleCase(error.severity)}</Badge>
            <StatusBadge tone={error.statusCode >= 500 ? 'red' : 'amber'}>HTTP {error.statusCode}</StatusBadge>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Message</p>
            <p className="mt-1 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 font-mono text-[13px] text-ink-800">{error.message}</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Detail label="Service" value={error.service} />
            <Detail label="Endpoint" value={`${error.method} ${error.endpoint}`} />
            <Detail label="First seen" value={formatDateTime(error.firstSeenAt)} />
            <Detail label="Last seen" value={formatDateTime(error.lastSeenAt)} />
            <Detail label="Occurrences" value={String(error.count)} />
            <Detail label="Trace ID" value={error.traceId ? <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[12px]">{error.traceId}</code> : 'Not recorded'} mono />
          </dl>
        </div>
      ) : null}
    </Drawer>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className={mono ? 'mt-0.5 break-all font-mono text-[12px] text-ink-700' : 'mt-0.5 text-ink-800'}>{value}</dd>
    </div>
  )
}
