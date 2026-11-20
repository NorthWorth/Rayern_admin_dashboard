/**
 * Authentication hardening tests.
 *
 *  - The two service-token guards (Rayern snapshot push, internal metrics) must
 *    compare in constant time via `crypto.timingSafeEqual`, fail closed when no
 *    token is configured, and reject malformed/mismatched headers.
 *  - Admin JWT handling: a valid admin token authenticates, an expired or
 *    forged token does not, and a non-admin role is refused.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import type { NextFunction, Request, Response } from 'express'

const SNAPSHOT_TOKEN = 'snapshot-token-0123456789abcdef'
const MONITORING_TOKEN = 'monitoring-token-0123456789abcdef'
const JWT_SECRET = 'auth-test-jwt-secret-value-0123456789'

type Guard = (req: Request, res: Response, next: NextFunction) => void

let requireRayernSnapshotToken: Guard
let requireMonitoringToken: Guard
let authenticate: (req: Request, res: Response, next: NextFunction) => void
let requireAdmin: (req: Request, res: Response, next: NextFunction) => void
let signAdminToken: (payload: { sub: string; email: string; name: string; role: string }) => string

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res
}

function fakeReq(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as unknown as Request
}

function run(guard: Guard, req: Request) {
  const res = fakeRes()
  let nextCalls = 0
  guard(req, res as unknown as Response, () => {
    nextCalls += 1
  })
  return { res, nextCalls }
}

beforeAll(async () => {
  process.env.RAYERN_SNAPSHOT_TOKEN = SNAPSHOT_TOKEN
  process.env.RAYERN_MONITORING_TOKEN = MONITORING_TOKEN
  process.env.ADMIN_JWT_SECRET = JWT_SECRET
  process.env.TELEMETRY_ENABLED = 'false'
  delete process.env.ADMIN_EMAILS
  vi.resetModules()

  const [snapshot, monitoring, auth] = await Promise.all([
    import('../auth/rayernSnapshotToken'),
    import('../auth/monitoringToken'),
    import('../auth'),
  ])
  requireRayernSnapshotToken = snapshot.requireRayernSnapshotToken as Guard
  requireMonitoringToken = monitoring.requireMonitoringToken as Guard
  authenticate = auth.authenticate as typeof authenticate
  requireAdmin = auth.requireAdmin as typeof requireAdmin
  signAdminToken = auth.signAdminToken
})

describe('Rayern snapshot token guard', () => {
  it('accepts the configured token', () => {
    const { res, nextCalls } = run(requireRayernSnapshotToken, fakeReq(`Bearer ${SNAPSHOT_TOKEN}`))
    expect(nextCalls).toBe(1)
    expect(res.statusCode).toBe(200)
  })

  it('rejects a same-length near-miss', () => {
    const nearMiss = `${SNAPSHOT_TOKEN.slice(0, -1)}X`
    expect(nearMiss).toHaveLength(SNAPSHOT_TOKEN.length)

    const { res, nextCalls } = run(requireRayernSnapshotToken, fakeReq(`Bearer ${nearMiss}`))
    expect(nextCalls).toBe(0)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({
      success: false,
      error: { code: 'SNAPSHOT_TOKEN_INVALID', message: 'Invalid snapshot token' },
    })
  })

  it('rejects a shorter/prefix token', () => {
    const { res, nextCalls } = run(requireRayernSnapshotToken, fakeReq(`Bearer ${SNAPSHOT_TOKEN.slice(0, 10)}`))
    expect(nextCalls).toBe(0)
    expect(res.statusCode).toBe(401)
  })

  it('rejects an empty token', () => {
    const { res, nextCalls } = run(requireRayernSnapshotToken, fakeReq('Bearer '))
    expect(nextCalls).toBe(0)
    expect(res.statusCode).toBe(401)
  })

  it('rejects a missing or malformed Authorization header', () => {
    for (const header of [undefined, `Basic ${SNAPSHOT_TOKEN}`, SNAPSHOT_TOKEN]) {
      const { res, nextCalls } = run(requireRayernSnapshotToken, fakeReq(header))
      expect(nextCalls).toBe(0)
      expect(res.statusCode).toBe(401)
    }
  })

  it('fails closed while no token is configured', () => {
    delete process.env.RAYERN_SNAPSHOT_TOKEN
    try {
      const { res, nextCalls } = run(requireRayernSnapshotToken, fakeReq(`Bearer ${SNAPSHOT_TOKEN}`))
      expect(nextCalls).toBe(0)
      expect(res.statusCode).toBe(401)
      expect(res.body).toEqual({
        success: false,
        error: { code: 'SNAPSHOT_TOKEN_REQUIRED', message: 'Snapshot token is not configured' },
      })
    } finally {
      process.env.RAYERN_SNAPSHOT_TOKEN = SNAPSHOT_TOKEN
    }
  })
})

describe('monitoring token guard', () => {
  it('accepts the configured token', () => {
    const { nextCalls } = run(requireMonitoringToken, fakeReq(`Bearer ${MONITORING_TOKEN}`))
    expect(nextCalls).toBe(1)
  })

  it('rejects a different token and any prefix of the real one', () => {
    for (const supplied of ['monitoring-token-0123456789abcdeX', MONITORING_TOKEN.slice(0, 12), '']) {
      const { res, nextCalls } = run(requireMonitoringToken, fakeReq(`Bearer ${supplied}`))
      expect(nextCalls).toBe(0)
      expect(res.statusCode).toBe(401)
    }
  })

  it('rejects the snapshot token — the two service secrets are not interchangeable', () => {
    const { nextCalls } = run(requireMonitoringToken, fakeReq(`Bearer ${SNAPSHOT_TOKEN}`))
    expect(nextCalls).toBe(0)
  })
})

describe('admin JWT handling', () => {
  const admin = { sub: 'a1', email: 'ops@rayern.test', name: 'Ops', role: 'admin' }

  it('authenticates a valid admin token and passes the admin guard', () => {
    const req = fakeReq(`Bearer ${signAdminToken(admin)}`) as Request & { user?: { role: string } }
    let authNext = 0
    authenticate(req, fakeRes() as unknown as Response, () => {
      authNext += 1
    })
    expect(authNext).toBe(1)
    expect(req.user?.role).toBe('admin')

    const { nextCalls } = run(requireAdmin, req)
    expect(nextCalls).toBe(1)
  })

  it('leaves an expired token unauthenticated, so the admin guard answers 401', () => {
    const expired = jwt.sign(admin, JWT_SECRET, { expiresIn: '-1s' })
    const req = fakeReq(`Bearer ${expired}`) as Request & { user?: { role: string } }
    authenticate(req, fakeRes() as unknown as Response, () => undefined)
    expect(req.user).toBeUndefined()

    const { res, nextCalls } = run(requireAdmin, req)
    expect(nextCalls).toBe(0)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    })
  })

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign(admin, 'some-other-secret-value', { expiresIn: '1h' })
    const req = fakeReq(`Bearer ${forged}`) as Request & { user?: { role: string } }
    authenticate(req, fakeRes() as unknown as Response, () => undefined)
    expect(req.user).toBeUndefined()
  })

  it('refuses a non-admin role that is not on the allow-list', () => {
    const req = fakeReq(`Bearer ${signAdminToken({ ...admin, role: 'viewer' })}`) as Request
    authenticate(req, fakeRes() as unknown as Response, () => undefined)

    const { res, nextCalls } = run(requireAdmin, req)
    expect(nextCalls).toBe(0)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({
      success: false,
      error: { code: 'ADMIN_ACCESS_REQUIRED', message: 'Admin access required' },
    })
  })
})
