/**
 * Scheduler configuration — environment only, no secrets in code.
 *
 * The service has one job: periodically POST Rayern's authenticated wake
 * endpoint so Rayern generates a snapshot and pushes it to the dashboard. It
 * stores no customer data and never computes metrics.
 */

function trimmed(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function number(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw.trim())
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

function bool(name: string, fallback: boolean): boolean {
  const raw = trimmed(name).toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}

export const config = {
  /** Rayern wake endpoint (POST). Required — the service is inert without it. */
  wakeEndpoint: trimmed('RAYERN_WAKEUP_ENDPOINT') || trimmed('RAYERN_TRIGGER_ENDPOINT'),
  /** Server-side wake credential. Never exposed to a browser or written to state. */
  monitoringToken: process.env.RAYERN_MONITORING_TOKEN ?? '',
  /** Default cadence: two hours. */
  intervalMs: number('SCHEDULER_INTERVAL_MS', 7_200_000, 300_000, 86_400_000),
  /**
   * First-run policy: false (default) waits for the next interval instead of
   * firing immediately at boot, so restarts cannot produce a burst of wakes.
   */
  runOnStart: bool('SCHEDULER_RUN_ON_START', false),
  requestTimeoutMs: number('SCHEDULER_REQUEST_TIMEOUT_MS', 90_000, 2_000, 300_000),
  /** Bounded retries for transient failures only. */
  maxRetries: number('SCHEDULER_MAX_RETRIES', 3, 0, 10),
  retryBaseMs: number('SCHEDULER_RETRY_BASE_MS', 30_000, 1_000, 600_000),
  retryMaxMs: number('SCHEDULER_RETRY_MAX_MS', 600_000, 5_000, 3_600_000),
  /** How long a run lock may live before it is considered abandoned. */
  lockTtlMs: number('SCHEDULER_LOCK_TTL_MS', 900_000, 30_000, 7_200_000),
  /** Durable state file (JSON). Mount a persistent disk in production. */
  statePath: trimmed('SCHEDULER_STATE_PATH') || './data/scheduler-state.json',
  /** Status/health HTTP listener. */
  port: number('PORT', 4100, 1, 65_535),
  host: trimmed('SCHEDULER_HOST') || '0.0.0.0',
  /** Separate credential for the read-only status endpoint. */
  statusToken: process.env.SCHEDULER_STATUS_TOKEN ?? '',
  /** Bound on retained execution history. */
  historyLimit: number('SCHEDULER_HISTORY_LIMIT', 100, 5, 1_000),
}

export const schedulerConfigured = (): boolean =>
  config.wakeEndpoint.length > 0 && config.monitoringToken.length > 0
