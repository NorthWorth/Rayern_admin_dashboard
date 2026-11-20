/**
 * The scheduler core.
 *
 * One responsibility: on the configured cadence, POST Rayern's authenticated
 * wake endpoint. Rayern then generates its aggregate snapshot and pushes it to
 * the dashboard, which validates and persists it.
 *
 * Guarantees:
 *  - no overlapping executions (run lock + in-process flag),
 *  - no burst at startup (first run waits for the interval unless explicitly
 *    configured otherwise; after downtime exactly one catch-up run),
 *  - transient failures retried with bounded exponential backoff + jitter,
 *    honouring Retry-After when present,
 *  - permanent failures (401/403/4xx validation) never retried in a loop,
 *  - an edge challenge stops automatic scheduling entirely (`challengeBlocked`),
 *  - a failed run never advances `lastSuccessAt`.
 */
import { randomUUID } from 'node:crypto'
import {
  backoffMs,
  classifyFetchError,
  classifyResponse,
  type AttemptClassification,
} from './classify.js'
import {
  appendHistory,
  type ExecutionRecord,
  type SchedulerState,
  type StateStore,
  acquireRunLock,
} from './state.js'

export interface WakeResponse {
  status: number
  contentType: string | null
  bodyExcerpt: string | null
  headers: Headers | null
  finalUrl: string | null
}

export type WakeFn = (input: {
  endpoint: string
  token: string
  timeoutMs: number
}) => Promise<WakeResponse>

export interface SchedulerOptions {
  endpoint: string
  token: string
  intervalMs: number
  requestTimeoutMs: number
  maxRetries: number
  retryBaseMs: number
  retryMaxMs: number
  lockPath: string
  lockTtlMs: number
  historyLimit: number
  runOnStart: boolean
  wake: WakeFn
  store: StateStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  log?: (line: string) => void
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class SnapshotScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false
  private state: SchedulerState

  constructor(private readonly opts: SchedulerOptions) {
    this.state = { history: [] } as unknown as SchedulerState
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? defaultSleep)(ms)
  }

  private log(line: string): void {
    ;(this.opts.log ?? ((l: string) => console.log(l)))(line)
  }

  /** Loads durable state and computes the first due time. */
  async init(): Promise<SchedulerState> {
    this.state = await this.opts.store.load()
    if (!this.state.nextDueAt) {
      const due = this.now() + (this.opts.runOnStart ? 0 : this.opts.intervalMs)
      this.state.nextDueAt = new Date(due).toISOString()
      await this.persist()
    }
    return this.state
  }

  getState(): SchedulerState {
    return this.state
  }

  private async persist(): Promise<void> {
    await this.opts.store.save(this.state)
  }

  /**
   * Runs one wake execution (with retries). Returns the updated state and the
   * recorded execution. Never throws: every failure is recorded.
   */
  async execute(trigger: ExecutionRecord['trigger']): Promise<ExecutionRecord> {
    const startedAt = this.now()
    const executionId = randomUUID()
    let attempts = 0
    let classification: AttemptClassification = {
      outcome: 'network_error',
      category: 'network',
      httpStatus: null,
      retryable: false,
      reachedApplication: null,
      retryAfterSec: null,
      message: 'No attempt was made.',
    }

    const lock = await acquireRunLock(this.opts.lockPath, this.opts.lockTtlMs, startedAt)
    if (lock === null) {
      // Another instance is executing: this is not a failure of the transport.
      this.log('[scheduler] run skipped — another instance holds the run lock')
      return {
        id: executionId,
        trigger,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(startedAt).toISOString(),
        durationMs: 0,
        attempts: 0,
        outcome: 'failed',
        category: 'none',
        httpStatus: null,
        reachedApplication: null,
        retryAfterSec: null,
        message: 'Skipped: another scheduler instance holds the run lock.',
      }
    }

    try {
      const maxAttempts = this.opts.maxRetries + 1
      for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
        try {
          const res = await this.opts.wake({
            endpoint: this.opts.endpoint,
            token: this.opts.token,
            timeoutMs: this.opts.requestTimeoutMs,
          })
          classification = classifyResponse({
            status: res.status,
            contentType: res.contentType,
            bodyExcerpt: res.bodyExcerpt,
            headers: res.headers,
          })
        } catch (err) {
          classification = classifyFetchError(err, this.opts.requestTimeoutMs)
        }

        if (classification.outcome === 'success' || !classification.retryable) break

        if (attempts < maxAttempts) {
          const retryAfterMs =
            classification.retryAfterSec !== null ? classification.retryAfterSec * 1000 : null
          const waitMs = Math.min(
            retryAfterMs ?? backoffMs(attempts, this.opts.retryBaseMs, this.opts.retryMaxMs, this.opts.random),
            this.opts.retryMaxMs,
          )
          this.log(
            `[scheduler] attempt ${attempts}/${maxAttempts} failed (${classification.category}); retrying in ${Math.round(waitMs / 1000)}s`,
          )
          await this.sleep(waitMs)
        }
      }
    } finally {
      await lock.release()
    }

    const finishedAt = this.now()
    const outcome: ExecutionRecord['outcome'] =
      classification.outcome === 'success'
        ? 'success'
        : classification.outcome === 'edge_challenge'
          ? 'challenge_blocked'
          : 'failed'

    const record: ExecutionRecord = {
      id: executionId,
      trigger,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      attempts,
      outcome,
      category: classification.category,
      httpStatus: classification.httpStatus,
      reachedApplication: classification.reachedApplication,
      retryAfterSec: classification.retryAfterSec,
      message: classification.message,
    }

    this.state = appendHistory(
      {
        ...this.state,
        lastScheduledAt: new Date(startedAt).toISOString(),
        lastAttemptAt: record.startedAt,
        lastOutcome: outcome,
        lastHttpStatus: classification.httpStatus,
        lastErrorCategory: outcome === 'success' ? null : classification.category,
        consecutiveFailures:
          outcome === 'success' ? 0 : (this.state.consecutiveFailures ?? 0) + 1,
        lastSuccessAt: outcome === 'success' ? record.finishedAt : this.state.lastSuccessAt,
        lastFailureAt: outcome === 'success' ? this.state.lastFailureAt : record.finishedAt,
        challengeBlocked: outcome === 'challenge_blocked' ? true : this.state.challengeBlocked,
        retryAt: null,
        backoffMs: null,
      },
      record,
      this.opts.historyLimit,
    )

    if (outcome === 'challenge_blocked') {
      // Do not schedule another automatic attempt: a human-verification page
      // cannot be solved by a worker, and a retry loop would only hammer the
      // edge. Escalate to the operator through the status endpoint.
      this.state.nextDueAt = null
      this.log(
        '[scheduler] EDGE CHALLENGE: the wake request was answered with a browser human-verification page. Automatic scheduling is paused.',
      )
    } else {
      this.state.nextDueAt = new Date(finishedAt + this.opts.intervalMs).toISOString()
    }

    await this.persist()
    return record
  }

  /** Starts the loop: one catch-up run if overdue, then the normal cadence. */
  async start(): Promise<void> {
    this.stopped = false
    await this.init()

    if (this.state.challengeBlocked) {
      this.log(
        '[scheduler] not scheduling: a previous execution was blocked by an edge challenge. Resolve it, then restart the service.',
      )
      return
    }

    const dueMs = this.state.nextDueAt ? Date.parse(this.state.nextDueAt) : this.now()
    const overdue = dueMs <= this.now()
    if (overdue) {
      // Single catch-up after downtime — never a burst of missed slots.
      await this.runOnce('startup-catchup')
      if (this.stopped) return
    }
    this.scheduleNext()
  }

  private scheduleNext(): void {
    if (this.stopped || this.state.challengeBlocked) return
    const dueMs = this.state.nextDueAt ? Date.parse(this.state.nextDueAt) : this.now() + this.opts.intervalMs
    const delay = Math.max(0, dueMs - this.now())
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.runOnce('scheduled'), delay)
    // Never keep the process alive only for the timer in tests/CLI use.
    this.timer.unref?.()
    this.log(`[scheduler] next wake at ${new Date(dueMs).toISOString()} (in ${Math.round(delay / 60_000)}m)`)
  }

  private async runOnce(trigger: ExecutionRecord['trigger']): Promise<void> {
    if (this.running) {
      this.log('[scheduler] run skipped — an execution is already in progress')
      return
    }
    this.running = true
    try {
      const record = await this.execute(trigger)
      this.log(
        `[scheduler] ${trigger} execution ${record.outcome}${record.httpStatus ? ` (HTTP ${record.httpStatus})` : ''}: ${record.message}`,
      )
    } catch (err) {
      // execute() is designed not to throw; this is a last-resort guard so the
      // loop keeps running and the failure is visible.
      this.log(`[scheduler] unexpected execution error: ${(err as Error).message}`)
    } finally {
      this.running = false
      if (!this.stopped) this.scheduleNext()
    }
  }

  /** Stops scheduling and waits for any in-flight execution to finish. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.running) {
      await this.sleep(50)
    }
  }
}
