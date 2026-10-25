import type { Workspace, Paged } from '../lib/types'
import { apiRequest, buildQuery } from '../lib/api'
import { buildWorkspaces, buildWorkspaceStats } from './demoData'

const demoItems = buildWorkspaces()

/**
 * Backfill helper for the workspace list page.
 * Reads all workspaces from the server (no client-side pagination), deduplicates
 * by (organization, name), and returns the client-ready shape.
 */
export async function backfillWorkspaces(): Promise<Workspace[]> {
  if (import.meta.env.VITE_ADMIN_USE_DEMO_DATA !== '1') {
    const body = await apiRequest<Workspace[]>('/workspaces/backfill')
    const seen = new Set<string>()
    return body.filter(w => {
      const key = `${w.organizationId}:${w.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  return demoItems
}

/**
 * Workspaces domain service.
 * Used by the workspace list and workspace settings pages.
 */
export const workspacesService = {
  list(params?: { page?: number; pageSize?: number; organizationId?: string }) {
    if (import.meta.env.VITE_ADMIN_USE_DEMO_DATA === '1') {
      const items = demoItems.slice(0, 25)
      return { items, total: items.length, page: 1, pageSize: 25 }
    }
    return apiRequest<Paged<Workspace>>('/workspaces' + buildQuery(params))
  },

  stats(organizationId?: string) {
    if (import.meta.env.VITE_ADMIN_USE_DEMO_DATA === '1') {
      return buildWorkspaceStats(demoItems, organizationId)
    }
    return apiRequest<{ total: number; active: number; archived: number; pending: number }>(
      '/workspaces/stats' + (organizationId ? `?organizationId=${organizationId}` : ''),
    )
  },

  /** Resolve the workspace slug → id mapping for usage across the app. */
  slugMap() {
    return apiRequest<Record<string, string>>('/workspaces/slug-map')
  },
} as const
