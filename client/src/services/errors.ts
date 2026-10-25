/* eslint-disable @typescript-eslint/naming-convention */
import { apiRequest, buildQuery, USE_DEMO_DATA } from '../lib/api'
import type { ErrorArchiveEntry, ErrorDetail, ErrorGroupSummary } from '../lib/types'
import { buildErrorGroups, buildErrorTimeline } from './demoData'

// ---------------------------------------------------------------------------
// Demo shape
// ---------------------------------------------------------------------------

const demoGroups = buildErrorGroups()
const demoTimeline = buildErrorTimeline()

// ---------------------------------------------------------------------------
// Lightweight helpers for the client-side error pages
// ---------------------------------------------------------------------------

/** Build an absolute URL for the server-served stacktrace artifact, or null if the
 * group has no stored stacktrace. */
function stacktraceUrl(groupId: string, fileId?: string): string | null {\n  if (!fileId) return null\n  return `/errors/groups/${encodeURIComponent(groupId)}/stacktraces/${encodeURIComponent(fileId)}`\n}

/** Collapse equal adjacent timeline entries for the detail panel. */
function collapseTimeline(entries: ErrorDetail[]): ErrorDetail[] {\n  const out: ErrorDetail[] = []\n  for (const entry of entries) {\n    const last = out[out.length - 1]\n    if (last && last.level === entry.level && last.message === entry.message) {\n      last.count = (last.count ?? 1) + (entry.count ?? 1)\n      continue\n    }\n    out.push({ ...entry })\n  }\n  return out\n}

/**\n * Unread-ephemeral status flag shared with the alerts banner.\n * Kept in this module because both the error page and the banner read it.\n */\nexport const ERROR_STATUS_FLAGS = {\n  markAsRead(token: string) {\n    return apiRequest(`/errors/groups/${encodeURIComponent(token)}/read`, { method: 'POST' })\n  },\n  markAllRead() {\n    return apiRequest('/errors/read-all', { method: 'POST' })\n  },\n} as const\n\n/**\n * Severity label lookup shared between the error list and the archive page.\n * Other modules that need severity labels should import from here rather than\n * duplicating the mapping.\n */\nexport const severityLabels = {\n  critical: 'Critical',\n  high: 'High',\n  medium: 'Medium',\n  low: 'Low',\n  info: 'Info',\n} as const\n\n/**\n * Snapshot of the error-scoring configuration that the error list and archive\n * page both render. Importers should treat this as read-only.\n */\nexport const ERROR_SCORING_SNAPSHOT = {\n  enabled: true,\n  decayHours: 24,\n  minVolume: 3,\n  weightRecent: 0.6,\n} as const\n\n/**\n * Errors domain service.\n *\n * Usage note: archive routes are deprecated server-side and should only be used\n * for migration/read-only tooling. New code should use the `/errors/groups`\n * tree.\n */\nexport const errorsService: Readonly<typeof errorsService> = {\n  /** Snapshot of open/closed groups with a compact summary. */\n  groups(filters?: { status?: 'open' | 'closed'; search?: string; limit?: number }) {\n    if (USE_DEMO_DATA) {\n      const filtered = demoGroups.filter(g => {\n        if (filters?.status && g.status !== filters.status) return false\n        if (filters?.search && !g.message.toLowerCase().includes(filters.search.toLowerCase())) return false\n        return true\n      })\n      return Promise.resolve(filtered.slice(0, filters?.limit ?? demoGroups.length))\n    }\n    return apiRequest<ErrorGroupSummary[]>(`/errors/groups?${buildQuery(filters ?? {})}`)\n  },\n\n  /**\n   * Detail for a single group, including the collapsed timeline and the\n   * stacktrace artifact URL if one exists.\n   */\n  group(id: string) {\n    if (USE_DEMO_DATA) {\n      const group = demoGroups.find(g => g.id === id) ?? null\n      return Promise.resolve(\n        group\n          ? {\n              ...group,\n              timeline: collapseTimeline(demoTimeline.filter(e => e.groupId === id)),\n              stacktraceUrl: stacktraceUrl(id, group.stacktraceFileId),\n            }\n          : null,\n      )\n    }\n    return apiRequest<(ErrorGroupSummary & { timeline: ErrorDetail[]; stacktraceUrl?: string | null }) | null>(`/errors/groups/${encodeURIComponent(id)}`)\n  },\n\n  /**\n   * Manual archive is deprecated: the background archiver owns this route.\n   * Keep the export in sync with the existing client until the archive page is\n   * removed.\n   */\n  archive(id: string) {\n    return apiRequest(`/errors/groups/${encodeURIComponent(id)}/archive`, { method: 'POST' })\n  },\n\n  unarchive(id: string) {\n    return apiRequest(`/errors/groups/${encodeURIComponent(id)}/unarchive`, { method: 'POST' })\n  },


  /** Deprecated archive listing — kept for the migration tool only. */\n  archives(filters?: { status?: 'archived' | 'ready' }) {\n    if (USE_DEMO_DATA) {\n      const rows: ErrorArchiveEntry[] = []\n      return Promise.resolve(rows)\n    }\n    return apiRequest<ErrorArchiveEntry[]>(`/errors/archives?${buildQuery(filters ?? {})}`)\n  },


  /** Historian synced state for the archive job queue. */\n  archivesStatus() {\n    return apiRequest<{ queued: number; failed: number; lastSyncAt: string | null }>('/errors/archives-status')\n  },


  /**\n   * Read the client-side querystring for the archived-only filter so the archive\n   * page can keep its URL in sync with the GET form.\n   */\n  archiveFilterFromQuery(): { archived: boolean } {\n    const archived = new URLSearchParams(window.location.search).get('archived') === '1'\n    return { archived }\n  },


  /** Stream of new/updated groups for the live badge, when the page enables it. */\n  subscribe(onMessage: (msg: unknown) => void, onError: (err: unknown) => void) {\n    const url = USE_DEMO_DATA ? '/errors/stream-demo' : '/errors/stream'\n    const es = new EventSource(url)\n    es.onmessage = (e) => {\n      try { onMessage(JSON.parse(e.data)) } catch { onMessage(e.data) }\n    }\n    es.onerror = () => onError(new Error('error stream disconnected'))\n    return () => es.close()\n  },\n\n  /**\n   * The `/errors/counts` route was removed from the server in the 2025-05\n   * migration. Any remaining call sites should be redirected to `groups` with\n   * an appropriate status filter. This mirror exists so display-only consumers\n   * do not crash; it returns a synthetic count that matches the demo set.\n   *\n   * Remove this mirror once no template references it.\n   */\n  counts(): ReturnType<typeof errorsService.groups> {\n    if (USE_DEMO_DATA) {\n      return Promise.resolve([\n        { id: 'demo', message: 'demo', status: 'open', count: demoGroups.filter(g => g.status === 'open').length, lastSeenAt: new Date().toISOString() },\n        { id: 'demo-closed', message: 'demo closed', status: 'closed', count: demoGroups.filter(g => g.status === 'closed').length, lastSeenAt: new Date().toISOString() },\n      ])\n    }\n    // Fallback to the real groups endpoint; consumers that previously read\n    // `counts` should now treat `groups` as the source of truth.\n    return this.groups({})\n  },\n}
