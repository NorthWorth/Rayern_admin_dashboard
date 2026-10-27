import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from './config'

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string
    email: string
    role: string
  }
}

/**
 * Parses and verifies the dashboard admin JWT (Bearer token issued by
 * `POST /auth/login`). A missing or invalid token leaves `req.user` /
 * `req.admin` unset so the route guards below can answer 401 — the token is
 * never trusted before this middleware runs.
 */
export function authenticate(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null
  if (!token) {
    next()
    return
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AdminTokenPayload
    req.admin = payload
    req.user = { id: payload.sub, email: payload.email, role: payload.role }
  } catch {
    // Invalid/expired token: leave the request unauthenticated (401 downstream).
  }
  next()
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    })
    return
  }
  next()
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    })
    return
  }
  // Dashboard admins are the `admin_users` rows that carry role 'admin' (the
  // only accounts `POST /auth/login` issues tokens for). When ADMIN_EMAILS is
  // configured it stays an additional allow-list for non-admin roles.
  const allowlisted = config.adminEmails.includes(req.user.email.toLowerCase())
  if (req.user.role !== 'admin' && !allowlisted) {
    res.status(403).json({
      success: false,
      error: { code: 'ADMIN_ACCESS_REQUIRED', message: 'Admin access required' },
    })
    return
  }
  next()
}

/* --------- Restored from the full-backend auth module (still used) -------- */

export interface AdminTokenPayload {
  sub: string
  email: string
  name: string
  role: string
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminTokenPayload
    }
  }
}

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '12h' })
}

/* ------------------------------ Rate limiting ----------------------------- */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

/** In-memory fixed-window rate limiter, keyed by IP + route group. */
export function rateLimit(opts: { windowMs: number; max: number; key?: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${opts.key ?? 'global'}:${req.ip ?? 'unknown'}`
    const now = Date.now()
    const bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs })
      next()
      return
    }

    bucket.count += 1
    if (bucket.count > opts.max) {
      // Informational only: seconds until THIS fixed window resets. The window,
      // the max and the bucket key are untouched — a client only learns when
      // another attempt may be appropriate (RFC 9110 Retry-After).
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      res.set('Retry-After', String(retryAfterSec))
      res.status(429).json({ error: 'Too many requests. Slow down.' })
      return
    }
    next()
  }
}

// Periodically clear expired buckets to avoid unbounded growth.
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}, 60_000).unref()
