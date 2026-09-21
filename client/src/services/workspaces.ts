import { apiRequest, buildQuery, makePaged, USE_DEMO_DATA } from '../lib/api'
import type { Paged, Workspace, WorkspaceFilters, WorkspaceStats } from '../lib/types'
import { buildWorkspaces, buildWorkspaceStats } from './demoData'

const demoWorkspaces = buildWorkspaces()

function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function filterWorkspaces(list: Workspace[], filters: WorkspaceFilters): Workspace[] {
  const search = filters.search?.trim().toLowerCase()
  return list.filter((w) => {
    if (filters.plan && filters.plan !== 'all' && w.plan !== filters.plan) return false
    if (search) {
      const haystack = `${w.name}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

function paginate<T>(items: T[], page = 1, pageSize = 25): Paged<T> {
  const start = (page - 1) * pageSize
  return makePaged(items.slice(start, start + pageSize), items.length, page, pageSize)
}

export const workspacesService = {
  list(filters: WorkspaceFilters & { page?: number; pageSize?: number }): Promise<Paged<Workspace>> {
    if (USE_DEMO_DATA) {
      const filtered = filterWorkspaces(demoWorkspaces, filters)
      return delay(paginate(filtered, filters.page, filters.pageSize))
    }
    return apiRequest<Paged<Workspace>>(`/workspaces${buildQuery({ ...filters })}`)
  },

  stats(): Promise<WorkspaceStats> {
    if (USE_DEMO_DATA) return delay(buildWorkspaceStats(demoWorkspaces))
    return apiRequest<WorkspaceStats>('/workspaces/stats')
  },
}
