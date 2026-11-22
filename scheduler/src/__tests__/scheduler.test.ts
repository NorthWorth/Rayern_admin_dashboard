import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStateStore, defaultState, type SchedulerState } from '../state.js'
import { SnapshotScheduler, type SchedulerOptions, type WakeResponse } from '../scheduler.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function options(overrides: Partial<SchedulerOptions> & { wake: SchedulerOptions['wake'] }): SchedulerOptions {
  const sleeper = { total: 0 }
  void sleeper
  return {
    endpoint: 'https://rayern.example/internal/dashboard-wakeup',
    token: 'test-token',
    intervalMs: 7_200_000,
    requestTimeoutMs: 5_000,
    maxRetries: 2,
    retryBaseMs: 1,
    retryMaxMs: 10,
    lockPath: path.join(tmpDir, 'run.lock'),
    lockTtlMs: 60_000,
    historyLimit: 10,
    runOnStart: false,
    store: new MemoryStateStore(),
    sleep: async () => undefined,
    random: () => 0.5,
    log: () => undefined,
    ...overrides,
  }
}

function ok(): WakeResponse {
  return { status: 202, contentType: 'application/json', bodyExcerpt: '{"success":true}', headers: new Headers({ 'x-powered-by': 'Express' }), finalUrl: null }
}

describe('SnapshotScheduler.execute', () => {
  it('records a successful wake without touching customer data', async () => {
    const calls: string[] = []
    const scheduler = new SnapshotScheduler(
      options({
        wake: async (input) => {
          calls.push(input.endpoint)
          expect(input.token).toBe('test-token')
          return ok()
        },
      }),
    )
    await scheduler.init()
    const record = await scheduler.execute('scheduled')

    expect(calls).toHaveLength(1)
    expect(record.outcome).toBe('success')
    expect(record.httpStatus).toBe(202)
    const state = scheduler.getState()
    expect(state.lastSuccessAt).not.toBeNull()
    expect(state.consecutiveFailures).toBe(0)
    expect(state.history[0]?.outcome).toBe('success')
    // The record must never contain the credential.
    expect(JSON.stringify(state)).not.toContain('test-token')
  })

  it('retries transient 5xx failures with backoff and then succeeds', async () => {
    let attempts = 0
    const scheduler = new SnapshotScheduler(
      options({
        wake: async () => {
          attempts += 1
          if (attempts < 3) {
            return { status: 503, contentType: 'application/json', bodyExcerpt: '{}', headers: new Headers({ server: 'render' }), finalUrl: null }
          }
          return ok()
        },
      }),
    )
    await scheduler.init()
    const record = await scheduler.execute('scheduled')
    expect(attempts).toBe(3)
    expect(record.outcome).toBe('success')
    expect(record.attempts).toBe(3)
  })

  it('does not retry authentication failures indefinitely', async () => {
    let attempts = 0
    const scheduler = new SnapshotScheduler(
      options({
        wake: async () => {
          attempts += 1
          return { status: 401, contentType: 'application/json', bodyExcerpt: '{}', headers: new Headers({ 'x-powered-by': 'Express' }), finalUrl: null }
        },
      }),
    )
    await scheduler.init()
    const record = await scheduler.execute('scheduled')
    expect(attempts).toBe(1)
    expect(record.outcome).toBe('failed')
    expect(record.category).toBe('auth')
    expect(scheduler.getState().consecutiveFailures).toBe(1)
  })

  it('pauses scheduling and reports challenge_blocked on an edge challenge', async () => {
    const scheduler = new SnapshotScheduler(
      options({
        wake: async () => ({
          status: 403,
          contentType: 'text/html',
          bodyExcerpt: '<!doctype html><html><title>Just a moment...</title><body>Checking your browser</body></html>',
          headers: new Headers({ server: 'cloudflare' }),
          finalUrl: null,
        }),
      }),
    )
    await scheduler.init()
    const record = await scheduler.execute('scheduled')
    expect(record.outcome).toBe('challenge_blocked')
    const state = scheduler.getState()
    expect(state.challengeBlocked).toBe(true)
    expect(state.nextDueAt).toBeNull()
    expect(state.lastSuccessAt).toBeNull()
  })

  it('does not overwrite the last success when a later run fails', async () => {
    let fail = false
    const scheduler = new SnapshotScheduler(
      options({
        wake: async () => (fail ? { status: 500, contentType: 'application/json', bodyExcerpt: '', headers: new Headers({ server: 'render' }), finalUrl: null } : ok()),
      }),
    )
    await scheduler.init()
    await scheduler.execute('scheduled')
    const successAt = scheduler.getState().lastSuccessAt
    fail = true
    await scheduler.execute('scheduled')
    expect(scheduler.getState().lastSuccessAt).toBe(successAt)
    expect(scheduler.getState().lastFailureAt).not.toBeNull()
  })
})

describe('single-run protection', () => {
  it('skips a run while another instance holds the lock', async () => {
    const lockPath = path.join(tmpDir, 'shared.lock')
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, at: new Date().toISOString() }))

    let called = 0
    const scheduler = new SnapshotScheduler(
      options({
        lockPath,
        wake: async () => {
          called += 1
          return ok()
        },
      }),
    )
    await scheduler.init()
    const record = await scheduler.execute('scheduled')
    expect(called).toBe(0)
    expect(record.message).toContain('run lock')
  })

  it('takes over an abandoned (expired) lock', async () => {
    const lockPath = path.join(tmpDir, 'stale.lock')
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, at: '2000-01-01T00:00:00.000Z' }))
    const old = new Date(Date.now() - 3_600_000)
    await fs.utimes(lockPath, old, old)

    const scheduler = new SnapshotScheduler(
      options({
        lockPath,
        wake: async () => ok(),
      }),
    )
    await scheduler.init()
    const record = await scheduler.execute('scheduled')
    expect(record.outcome).toBe('success')
  })
})

describe('restart recovery', () => {
  it('waits for the interval instead of firing immediately on a fresh start', async () => {
    const scheduler = new SnapshotScheduler(options({ wake: async () => ok() }))
    const state = await scheduler.init()
    const dueMs = Date.parse(state.nextDueAt ?? '')
    expect(dueMs).toBeGreaterThan(Date.now())
  })

  it('runs exactly one catch-up when the stored schedule is overdue', async () => {
    const store = new MemoryStateStore()
    const overdue: SchedulerState = { ...defaultState(), nextDueAt: new Date(Date.now() - 3_600_000).toISOString() }
    await store.save(overdue)

    let runs = 0
    const scheduler = new SnapshotScheduler(
      options({
        store,
        wake: async () => {
          runs += 1
          return ok()
        },
      }),
    )
    await scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await scheduler.stop()
    expect(runs).toBe(1)
  })
})
