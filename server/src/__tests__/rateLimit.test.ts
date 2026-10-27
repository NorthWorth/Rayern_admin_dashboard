import { afterEach, describe, expect, test, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { rateLimit } from '../auth'

/**
 * Rate-limit preservation checks for the manual-refresh work:
 *  - the fixed-window limiter keeps its rules (window, max, per-IP + route key),
 *    and a 429 never resets or extends the window;
 *  - the 429 carries retry information (Retry-After) the dashboard can display;
 *  - the Rayern pull-sync keeps its 30-minute default window, including when
 *    the env override is missing, empty or garbage.
 */

interface FakeRes {
  statusCode: number
  headers: Record<string, string>
  body: unknown
  status(code: number): FakeRes
  set(name: string, value: string): FakeRes
  json(payload: unknown): FakeRes
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code: number) {
      res.statusCode = code
      return res
    },
    set(name: string, value: string) {
      res.headers[name.toLowerCase()] = value
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res
}

function call(middleware: (req: Request, res: Response, next: NextFunction) => void, ip: string) {
  const res = makeRes()
  const next = vi.fn()
  middleware({ ip } as Request, res as unknown as Response, next)
  return { res, next }
}

describe('application rate limiter (unchanged rules)', () => {
  test('allows up to max requests per window, then answers 429 with Retry-After', () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 2, key: 'unit-window' })

    const first = call(middleware, '198.51.100.1')
    expect(first.next).toHaveBeenCalled()
    expect(first.res.statusCode).toBe(200)

    const second = call(middleware, '198.51.100.1')
    expect(second.next).toHaveBeenCalled()

    const third = call(middleware, '198.51.100.1')
    expect(third.next).not.toHaveBeenCalled()
    expect(third.res.statusCode).toBe(429)
    // Existing body shape is untouched — only the retry header is added.
    expect(third.res.body).toEqual({ error: 'Too many requests. Slow down.' })

    const retryAfter = Number(third.res.headers['retry-after'])
    expect(Number.isFinite(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)

    // A 429 must not reset or extend the window: the very next request is
    // still rejected within the same window.
    const fourth = call(middleware, '198.51.100.1')
    expect(fourth.next).not.toHaveBeenCalled()
    expect(fourth.res.statusCode).toBe(429)
  })

  test('remains keyed per IP + route group — another client is unaffected', () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1, key: 'unit-per-ip' })

    expect(call(middleware, '198.51.100.2').next).toHaveBeenCalled()
    expect(call(middleware, '198.51.100.2').next).not.toHaveBeenCalled()
    expect(call(middleware, '198.51.100.3').next).toHaveBeenCalled()
  })

  test('a new fixed window admits requests again (window semantics unchanged)', async () => {
    const middleware = rateLimit({ windowMs: 40, max: 1, key: 'unit-rollover' })

    expect(call(middleware, '198.51.100.4').next).toHaveBeenCalled()
    expect(call(middleware, '198.51.100.4').next).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(call(middleware, '198.51.100.4').next).toHaveBeenCalled()
  })
})

describe('Rayern pull-sync 30-minute window (config)', () => {
  async function configWith(raw: string | undefined): Promise<typeof import('../config').config> {
    vi.resetModules()
    if (raw === undefined) vi.unstubAllEnvs()
    else vi.stubEnv('RAYERN_SYNC_INTERVAL_MS', raw)
    const mod = await import('../config')
    return mod.config
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('defaults to 30 minutes (1800000 ms) when the override is unset or empty', async () => {
    expect((await configWith(undefined)).rayern.intervalMs).toBe(1_800_000)
    expect((await configWith('')).rayern.intervalMs).toBe(1_800_000)
  })

  test('a garbage override falls back to the default instead of becoming NaN', async () => {
    const cfg = await configWith('thirty-minutes')
    expect(cfg.rayern.intervalMs).toBe(1_800_000)
    expect(Number.isFinite(cfg.rayern.intervalMs)).toBe(true)
  })

  test('keeps the documented floor (30s) and ceiling (24h) on overrides', async () => {
    expect((await configWith('5')).rayern.intervalMs).toBe(30_000)
    expect((await configWith('999999999')).rayern.intervalMs).toBe(86_400_000)
    expect((await configWith('600000')).rayern.intervalMs).toBe(600_000)
  })
})
