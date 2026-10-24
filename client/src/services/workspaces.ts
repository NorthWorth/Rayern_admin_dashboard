import type { Workspace, Paged } from '../lib/types'
import { apiRequest, buildQuery, useDemoData } from '../lib/api'
import { buildWorkspaces, buildWorkspaceStats } from './demoData'

const demoItems = buildWorkspaces()

/**\n * Backfill helper for the workspace list page.\n * Reads all workspaces from the server (no client-side pagination), deduplicates\n * by (organization, name), and returns the client-ready shape.\n */\nexport async function backfillWorkspaces(): Promise<Workspace[]> {\n  if (!useDemoData) {\n    const body = await apiRequest<Workspace[]>('/workspaces/backfill')\n    const seen = new Set<string>()\n    return body.filter(w => {\n      const key = `${w.organizationId}:${w.name}`\n      if (seen.has(key)) return false\n      seen.add(key)\n      return true\n    })\n  }\n  return demoItems\n}

/**\n * Workspaces domain service.\n * Used by the workspace list and workspace settings pages.\n */\nexport const workspacesService = {\n  list(params?: { page?: number; pageSize?: number; organizationId?: string }) {\n    if (useDemoData) {\n      const items = demoItems.slice(0, 25)\n      return { items, total: items.length, page: 1, pageSize: 25 }\n    }\n    return apiRequest<Paged<Workspace>>('/workspaces' + buildQuery(params))\n  },

  stats(organizationId?: string) {\n    if (useDemoData) {\n      return buildWorkspaceStats(demoItems, organizationId)\n    }\n    return apiRequest<{ total: number; active: number; archived: number; pending: number }>(\n      '/workspaces/stats' + (organizationId ? `?organizationId=${organizationId}` : ''),\n    )\n  },

  /** Resolve the workspace slug → id mapping for usage across the app. */\n  slugMap() {\n    return apiRequest<Record<string, string>>('/workspaces/slug-map')\n  },
} as const
