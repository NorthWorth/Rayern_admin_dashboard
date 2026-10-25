import type { PageRequest, Paged, Workspace, WorkspaceFilters, WorkspaceStats } from '../lib/types'
import { apiRequest, buildQuery, USE_DEMO_DATA } from '../lib/api'
import { buildWorkspaces, buildWorkspaceStats } from './demoData'

const demoItems = buildWorkspaces()

function demoFilter(params: WorkspaceFilters): Workspace[] {
  const search = params.search?.trim().toLowerCase() ?? ''
  return demoItems.filter((w) => {
    if (params.plan && params.plan !== 'all' && w.plan !== params.plan) return false
    if (search && !w.name.toLowerCase().includes(search)) return false
    return true
  })
}

/**
 * Backfill helper for the workspace list page.
 * Reads all workspaces from the server (no client-side pagination), deduplicates
 * by name, and returns the client-ready shape.
 */
export async function backfillWorkspaces(): Promise<Workspace[]> {
  if (!USE_DEMO_DATA) {
    const body = await apiRequest<Workspace[]>('/workspaces/backfill')
    const seen = new Set<string>()
    return body.filter((w) => {
      if (seen.has(w.name)) return false
      seen.add(w.name)
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
  list(params: WorkspaceFilters & PageRequest = {}): Promise<Paged<Workspace>> {
    if (USE_DEMO_DATA) {
      const filtered = demoFilter(params)
      const page = params.page ?? 1
      const pageSize = params.pageSize ?? 25
      const start = (page - 1) * pageSize
      return Promise.resolve({
        items: filtered.slice(start, start + pageSize),
        total: filtered.length,
        page,
        pageSize,
      })
    }
    const query = buildQuery({
      ...params,
      plan: params.plan === 'all' ? undefined : params.plan,
    })
    return apiRequest<Paged<Workspace>>('/workspaces' + query)
  },

  stats(): Promise<WorkspaceStats> {
    if (USE_DEMO_DATA) {
      return Promise.resolve(buildWorkspaceStats(demoItems))
    }
    return apiRequest<WorkspaceStats>('/workspaces/stats')
  },

  /** Resolve the workspace slug → id mapping for usage across the app. */
  slugMap(): Promise<Record<string, string>> {
    return apiRequest<Record<string, string>>('/workspaces/slug-map')
  },
} as const
