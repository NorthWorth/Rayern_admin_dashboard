/**
 * Durable scheduler state.
 *
 * A JSON file with atomic replacement (write temp + rename) is used instead of
 * an in-memory timer alone, so a restart preserves:
 *   - the last attempt/success/failure,
 *   - the next due time (no immediate burst at boot),
 *   - the retained execution history.
 *
 * A separate `O_EXCL` lock file prevents two instances from running the wake
 * at the same time. Stale locks (process killed mid-run) expire after a TTL.
 *
 * Single-writer JSON is appropriate for the documented topology (one scheduler
 * instance on Render with a persistent disk). If the service is ever scaled to
 * multiple writers, replace this module with a database-backed store; the rest
 * of the service only talks to the `StateStore` interface.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FailureCategory } from './classify.js'

export interface ExecutionRecord {
  id: string
  trigger: 'scheduled' | 'startup-catchup' | 'manual'
  startedAt: string
  finishedAt: string
  durationMs: number
  attempts: number
  outcome: 'success' | 'failed' | 'challenge_blocked'
  category: FailureCategory
  httpStatus: number | null
  reachedApplication: boolean | null
  retryAfterSec: number | null
  message: string
}

export interface SchedulerState {
  version: 1
  instanceId: string
  /** When the schedule last advanced (successful or not). */
  lastScheduledAt: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  /** null until an execution has run. */
  lastOutcome: 'success' | 'failed' | 'challenge_blocked' | null
  lastHttpStatus: number | null
  lastErrorCategory: FailureCategory | null
  consecutiveFailures: number
  /** When the next scheduled wake is due (UTC ISO). */
  nextDueAt: string | null
  /** Set while a retry/backoff window is pending. */
  retryAt: string | null
  backoffMs: number | null
  /** True after an edge challenge: the loop pauses instead of hammering. */
  challengeBlocked: boolean
  history: ExecutionRecord[]
}

export function defaultState(): SchedulerState {
  return {
    version: 1,
    instanceId: randomUUID(),
    lastScheduledAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastOutcome: null,
    lastHttpStatus: null,
    lastErrorCategory: null,
    consecutiveFailures: 0,
    nextDueAt: null,
    retryAt: null,
    backoffMs: null,
    challengeBlocked: false,
    history: [],
  }
}

export interface StateStore {
  load(): Promise<SchedulerState>
  save(state: SchedulerState): Promise<void>
}

export class FileStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<SchedulerState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as SchedulerState
      if (!parsed || parsed.version !== 1) return defaultState()
      // Defensive: a partially written file must never crash the service.
      return { ...defaultState(), ...parsed, history: Array.isArray(parsed.history) ? parsed.history : [] }
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return defaultState()
      console.error('[scheduler] state file unreadable — starting from a clean state:', (err as Error).message)
      return defaultState()
    }
  }

  async save(state: SchedulerState): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}

/** In-memory store for tests. */
export class MemoryStateStore implements StateStore {
  private state: SchedulerState = defaultState()
  async load(): Promise<SchedulerState> {
    return structuredClone(this.state)
  }
  async save(state: SchedulerState): Promise<void> {
    this.state = structuredClone(state)
  }
}

export interface RunLock {
  release(): Promise<void>
}

/**
 * Acquires an exclusive run lock. Returns null when another instance holds a
 * live lock — the caller must then skip the run rather than duplicate the wake.
 */
export async function acquireRunLock(lockPath: string, ttlMs: number, now = Date.now()): Promise<RunLock | null> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  try {
    const handle = await fs.open(lockPath, 'wx')
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }), 'utf8')
    await handle.close()
    return {
      async release(): Promise<void> {
        try {
          await fs.unlink(lockPath)
        } catch {
          // Already gone (e.g. another cleanup) — nothing to do.
        }
      },
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err
    // Existing lock: take it over only when it is demonstrably abandoned.
    try {
      const stat = await fs.stat(lockPath)
      if (now - stat.mtimeMs > ttlMs) {
        await fs.unlink(lockPath)
        return acquireRunLock(lockPath, ttlMs, now)
      }
    } catch {
      // Lock disappeared between open and stat: try once more.
      return acquireRunLock(lockPath, ttlMs, now)
    }
    return null
  }
}

/** Appends an execution and trims history to the configured bound. */
export function appendHistory(state: SchedulerState, record: ExecutionRecord, limit: number): SchedulerState {
  const history = [record, ...state.history].slice(0, limit)
  return { ...state, history }
}
