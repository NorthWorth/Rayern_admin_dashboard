import type { Request, Response, NextFunction } from 'express'

/**
 * Fail-closed service-token guard for the Rayern push-ingestion endpoint.
 *
 * Rayern authenticates with `RAYERN_SNAPSHOT_TOKEN` (a dedicated secret,
 * distinct from the monitoring token used for outbound calls). While it is
 * unset, every delivery is rejected with 401 so the dashboard can never
 * accept an unauthenticated snapshot.
 */
export function requireRayernSnapshotToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.RAYERN_SNAPSHOT_TOKEN?.trim() ?? ''
  if (!expected) {
    res.status(401).json({
      success: false,
      error: { code: 'SNAPSHOT_TOKEN_REQUIRED', message: 'Snapshot token is not configured' },
    })
    return
  }

  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: { code: 'SNAPSHOT_TOKEN_REQUIRED', message: 'Missing or malformed Authorization header' },
    })
    return
  }

  const token = header.slice('Bearer '.length)
  if (token !== expected) {
    res.status(401).json({
      success: false,
      error: { code: 'SNAPSHOT_TOKEN_INVALID', message: 'Invalid snapshot token' },
    })
    return
  }

  next()
}