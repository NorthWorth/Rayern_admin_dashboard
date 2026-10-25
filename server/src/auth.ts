import type { Request, Response, NextFunction } from 'express'
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
