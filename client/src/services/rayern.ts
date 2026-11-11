import { apiRequest, buildQuery, USE_DEMO_DATA } from '../lib/api'
import type {
  InstrumentationResponse,
  RayernLogsResponse,
  SyncDiagnosticsResponse,
  SyntheticResponse,
} from '../lib/types'

/**
 * Rayern instrumentation service.
 *
 * Everything here goes through the dashboard backend — the browser never talks
 * to Rayern and never sees the monitoring token:
 *
 *   GET /rayern/blocks               the 8 metric blocks persisted by the pull-sync
 *   GET /rayern/logs                 server→server /internal/logs
 *   GET /rayern/synthetic-monitoring server→server /internal/synthetic-monitoring
 *   GET /rayern/sync-diagnostics     this backend's failed outbound Rayern calls
 *
 * Demo mode (no API configured) reports every block as absent rather than
 * inventing sample analytics: the pages then render their honest "not available"
 * states instead of a fabricated dashboard.
 */

function delay<T>(value: T, ms = 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

const NO_BLOCKS: InstrumentationResponse = {
  blocks: {
    funnel: null,
    clientErrors: null,
    endpointHealth: null,
    dependencyConfig: null,
    syntheticMonitoring: null,
    productAdoption: null,
    marketingConsent: null,
    engagement: null,
  },
  syncedAt: null,
  received: [],
}

const DEMO_LOGS: RayernLogsResponse = {
  entries: [],
  meta: {
    source: '/internal/logs',
    requestId: null,
    fetchedAt: new Date().toISOString(),
    level: null,
    since: null,
    limit: 100,
    retentionDays: 7,
    maxEntries: 500,
    durable: false,
    note: 'In-process store: at most 500 entries over the last 7 days. Older log lines are not retrievable.',
  },
}

const DEMO_SYNTHETIC: SyntheticResponse = {
  synthetic: {
    available: false,
    reason: 'no_checks_run',
    lastCheckedAt: null,
    lastSuccessfulCheckAt: null,
    checks: [],
  },
  meta: {
    source: '/internal/synthetic-monitoring',
    requestId: null,
    fetchedAt: new Date().toISOString(),
    durable: false,
    note: 'Produced by an external scheduler running scripts/synthetic-monitor.mjs. The dashboard only displays results.',
  },
}

export interface LogQuery {
  limit?: number
  level?: string
  /** ISO date; the backend bounds it to the 7-day retention window. */
  since?: string
}

const DEMO_DIAGNOSTICS: SyncDiagnosticsResponse = {
  diagnostics: [],
  meta: {
    maxEntries: 200,
    retention: 'newest-first bounded store; older failures are discarded',
    fetchedAt: new Date().toISOString(),
    note: 'Captured on the dashboard backend for outbound Rayern requests. Never contains credentials or request headers.',
  },
}

export const rayernService = {
  blocks(): Promise<InstrumentationResponse> {
    if (USE_DEMO_DATA) return delay(NO_BLOCKS)
    return apiRequest<InstrumentationResponse>('/rayern/blocks')
  },

  logs(query: LogQuery = {}): Promise<RayernLogsResponse> {
    if (USE_DEMO_DATA) return delay(DEMO_LOGS)
    const path = `/rayern/logs${buildQuery({
      limit: query.limit,
      level: query.level,
      since: query.since,
    })}`
    return apiRequest<RayernLogsResponse>(path)
  },

  /** On-demand read of Rayern's external synthetic-probe results. */
  syntheticMonitoring(): Promise<SyntheticResponse> {
    if (USE_DEMO_DATA) return delay(DEMO_SYNTHETIC)
    return apiRequest<SyntheticResponse>('/rayern/synthetic-monitoring')
  },

  /**
   * Failures this backend hit while calling Rayern (pull-sync and internal
   * proxies). Records are sanitized server-side; no token ever crosses here.
   */
  syncDiagnostics(limit = 50): Promise<SyncDiagnosticsResponse> {
    if (USE_DEMO_DATA) return delay(DEMO_DIAGNOSTICS)
    return apiRequest<SyncDiagnosticsResponse>(`/rayern/sync-diagnostics${buildQuery({ limit })}`)
  },
}
