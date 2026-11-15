import { Router, type Request, type Response, type NextFunction } from 'express'
import { requireRayernSnapshotToken } from '../auth/rayernSnapshotToken'
import { ingestRayernSnapshot } from '../rayernIngestion'

export const rayernPushRouter = Router()

rayernPushRouter.post('/internal/dashboard/rayern-snapshot', requireRayernSnapshotToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await ingestRayernSnapshot(req.body)
    if (!result.ok) {
      res.status(result.status ?? 400).json({
        success: false,
        error: { code: 'SNAPSHOT_REJECTED', message: result.error ?? 'Snapshot rejected' },
        snapshotId: result.snapshotId ?? null,
      })
      return
    }
    res.status(200).json({
      success: true,
      snapshotId: result.snapshotId ?? null,
      idempotent: Boolean(result.idempotent),
      sections: result.sections ?? [],
    })
  } catch (err) {
    next(err)
  }
})

export default rayernPushRouter