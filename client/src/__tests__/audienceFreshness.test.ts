/**
 * Both audience views show how fresh the synchronized list is, because pruning
 * of removed recipients depends on Rayern sending a complete snapshot. The
 * classification must be exact: never-synced is not "fresh", an old snapshot is
 * visibly stale, and a recent one is not.
 */
import { describe, expect, test } from 'vitest'
import { AUDIENCE_STALE_MS, audienceFreshness } from '../components/AudienceFreshness'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')

describe('audienceFreshness', () => {
  test('treats a missing or unparseable sync time as never synchronized', () => {
    expect(audienceFreshness(null, NOW)).toEqual({ never: true, stale: true, syncedLabel: null })
    expect(audienceFreshness('not-a-date', NOW).never).toBe(true)
  })

  test('flags a snapshot older than the threshold as stale', () => {
    const syncedAt = new Date(NOW - AUDIENCE_STALE_MS - 1000).toISOString()
    const state = audienceFreshness(syncedAt, NOW)
    expect(state.never).toBe(false)
    expect(state.stale).toBe(true)
    expect(state.syncedLabel).not.toBeNull()
  })

  test('treats a snapshot inside the threshold as fresh', () => {
    const syncedAt = new Date(NOW - AUDIENCE_STALE_MS + 60_000).toISOString()
    const state = audienceFreshness(syncedAt, NOW)
    expect(state.never).toBe(false)
    expect(state.stale).toBe(false)
  })
})
