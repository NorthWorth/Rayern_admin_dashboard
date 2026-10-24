import type { Request, Response, NextFunction } from 'express'
import { config } from '../config'

/**
 * Fail-closed service-token guard for `GET /internal/dashboard-metrics`.
 *
 * Per the backend contract, this endpoint is mounted outside `/api` and is
 * gated by `RAYERN_MONITORING_TOKEN`. While that env var is unset, every
 * request is rejected with 401 so the dashboard backend can never accidentally
 * expose metrics without an explicit service token being configured.
 *
 * Both `/internal/dashboard-metrics` (service token) and
 * `/api/v1/admin/metrics` (session admin) return the same payload shape.
 */
export function requireMonitoringToken(req: Request, res: Response, next: NextFunction): void {
  const expected = config.rayern.monitoringToken
  if (!expected) {
    res.status(401).json({
      success: false,
      error: { code: 'MONITORING_TOKEN_REQUIRED', message: 'Monitoring token is not configured' },
    })
    return
  }

  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: { code: 'MONITORING_TOKEN_REQUIRED', message: 'Missing or malformed Authorization header' },
    })
    return
  }

  const token = header.slice('Bearer '.length)
  if (token !== expected) {
    res.status(401).json({
      success: false,
      error: { code: 'MONITORING_TOKEN_INVALID', message: 'Invalid monitoring token' },
    })
    return
  }

  next()
}
