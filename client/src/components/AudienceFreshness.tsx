/**
 * Freshness signal for the synchronized Rayern audience.
 *
 * The stored audience is only a mirror of Rayern's consent records. Since the
 * dashboard now prunes removed recipients ONLY when Rayern marks a push as a
 * complete snapshot (`complete: true`), a stale list can still contain people
 * who opted out or were deleted upstream. Both audience views therefore show
 * the age of the newest synchronized row, and say plainly what staleness means
 * for who appears in the list.
 */

/** A synchronized list older than this is flagged as stale. */
export const AUDIENCE_STALE_MS = 24 * 60 * 60 * 1000

export interface AudienceFreshnessState {
  /** No record has ever been synchronized. */
  never: boolean
  /** Newest synchronized row is older than AUDIENCE_STALE_MS. */
  stale: boolean
  /** Human-readable synchronization time, null when never synced. */
  syncedLabel: string | null
}

export function audienceFreshness(lastSyncedAt: string | null, now = Date.now()): AudienceFreshnessState {
  if (!lastSyncedAt) return { never: true, stale: true, syncedLabel: null }
  const syncedMs = new Date(lastSyncedAt).getTime()
  if (!Number.isFinite(syncedMs)) return { never: true, stale: true, syncedLabel: null }
  return {
    never: false,
    stale: now - syncedMs > AUDIENCE_STALE_MS,
    syncedLabel: new Date(syncedMs).toLocaleString(),
  }
}

const PRUNE_NOTE =
  'Recipients removed upstream are only pruned when Rayern sends a complete snapshot (complete: true), so a stale list may still contain people who opted out or were deleted.'

export function AudienceFreshness({ lastSyncedAt, className }: { lastSyncedAt: string | null; className?: string }) {
  const { never, stale, syncedLabel } = audienceFreshness(lastSyncedAt)

  if (never) {
    return (
      <div
        role="status"
        className={
          'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 ' + (className ?? '')
        }
      >
        <span className="font-semibold">Audience not synchronized yet.</span> No recipient list has been received from
        Rayern, so nothing can be selected.
      </div>
    )
  }

  if (stale) {
    return (
      <div
        role="status"
        className={
          'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 ' + (className ?? '')
        }
      >
        <span className="font-semibold">Audience snapshot is stale — last synchronized {syncedLabel}.</span> {PRUNE_NOTE}{' '}
        Rayern still re-checks every recipient at send time.
      </div>
    )
  }

  return (
    <p className={'text-[11px] text-ink-500 ' + (className ?? '')}>
      Audience last synchronized {syncedLabel}. {PRUNE_NOTE}
    </p>
  )
}
