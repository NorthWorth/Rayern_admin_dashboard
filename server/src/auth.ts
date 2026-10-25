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
  if (!config.adminEmails.includes(req.user.email.toLowerCase())) {
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
