/**
 * Middleware: JWT admin authentication and rate limiting.
 * All dashboard data routes require a valid admin bearer token.
 */
import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { config } from './config'

export interface AdminTokenPayload {
  sub: string
  email: string
  name: string
  role: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminTokenPayload
    }
  }
}

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '12h' })
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: missing admin token' })
    return
  }
  try {
    req.admin = jwt.verify(token, config.jwtSecret) as AdminTokenPayload
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized: invalid or expired token' })
  }
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
