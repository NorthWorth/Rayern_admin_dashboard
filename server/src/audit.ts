/**
 * Audit helper — records administrative and system events performed through
 * the dashboard. Never records customer activity (there is no customer
 * activity pipeline into this system at all).
 */
import { query } from './db'
import type { AdminTokenPayload } from './auth'

export async function recordAudit(
  actor: string,
  actorKind: 'admin' | 'system',
  action: string,
  target: string,
  metadata: Record<string, string> = {},
): Promise<void> {
  await query(
    `INSERT INTO audit_events (actor, actor_kind, action, target, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [actor, actorKind, action, target, JSON.stringify(metadata)],
  )
}

export function adminActor(admin: AdminTokenPayload): string {
  return admin.email
}
