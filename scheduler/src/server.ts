/**
 * Scheduler observability surface.
 *
 *   GET /health — unauthenticated liveness only (no schedule, no history)
 *   GET /status — read-only operational snapshot, protected by a dedicated
 *                 SCHEDULER_STATUS_TOKEN (separate from the wake credential)
 *
 * The dashboard backend proxies /status server-side; the browser never holds
 * either credential.
 */
import { createServer, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { SchedulerState } from './state.js'

export interface StatusContext {
  state: SchedulerState
  configured: boolean
  intervalMs: number
  /** True while the process is inside an execution. */
  running: boolean
  statusToken: string
}

export interface StatusSnapshot {
  service: 'rayern-snapshot-scheduler'
  state: 'ok' | 'paused_challenge' | 'failing' | 'not_configured'
  configured: boolean
  running: boolean
  intervalMs: number
  lastScheduledExecutionAt: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastOutcome: string | null
  nextScheduledAt: string | null
  consecutiveFailures: number
  lastHttpStatus: number | null
  lastErrorCategory: string | null
  edgeChallenge: boolean
  /** Whether the last wake reached the Rayern application (null = unknown). */
  reachedApplication: boolean | null
  /** The scheduler cannot confirm ingestion; the dashboard owns that truth. */
  snapshotReceived: null
  history: SchedulerState['history']
  checkedAt: string
}

export function buildStatus(ctx: StatusContext): StatusSnapshot {
  const { state } = ctx
  const snapshotState: StatusSnapshot['state'] = !ctx.configured
    ? 'not_configured'
    : state.challengeBlocked
      ? 'paused_challenge'
      : (state.consecutiveFailures ?? 0) > 0
        ? 'failing'
        : 'ok'

  return {
    service: 'rayern-snapshot-scheduler',
    state: snapshotState,
    configured: ctx.configured,
    running: ctx.running,
    intervalMs: ctx.intervalMs,
    lastScheduledExecutionAt: state.lastScheduledAt,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastOutcome: state.lastOutcome,
    nextScheduledAt: state.nextDueAt,
    consecutiveFailures: state.consecutiveFailures ?? 0,
    lastHttpStatus: state.lastHttpStatus,
    lastErrorCategory: state.lastErrorCategory,
    edgeChallenge: state.challengeBlocked,
    reachedApplication:
      state.history[0]?.reachedApplication ?? null,
    snapshotReceived: null,
    history: state.history,
    checkedAt: new Date().toISOString(),
  }
}

/** Length-safe constant-time comparison of two secrets. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    // Still do a comparison so timing does not reveal the length difference.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

export function startStatusServer(
  port: number,
  host: string,
  getContext: () => StatusContext,
): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const ctx = getContext()

    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      const snapshot = buildStatus(ctx)
      res.writeHead(snapshot.state === 'not_configured' ? 503 : 200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: snapshot.state === 'ok' ? 'ok' : snapshot.state,
          configured: snapshot.configured,
          checkedAt: snapshot.checkedAt,
        }),
      )
      return
    }

    if (req.method === 'GET' && (url === '/status' || url.startsWith('/status?'))) {
      // Fail closed when no status credential is configured.
      if (!ctx.statusToken) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'SCHEDULER_STATUS_TOKEN is not configured' }))
        return
      }
      const header = req.headers.authorization
      const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!presented || !safeEqual(presented, ctx.statusToken)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(buildStatus(ctx)))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}
