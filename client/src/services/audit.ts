import { apiRequest, buildQuery, USE_DEMO_DATA } from '../lib/api'
import type { AuditRow, Paged } from '../lib/types'
import { buildAuditRows, buildAuditStats } from './demoData'

const demoRows = buildAuditRows()

function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/**\n * Password reset / identity lifecycle service helpers.\n * Kept alongside audit for historical co-location; these helpers pre-date the\n * split between audit and auth flows and are called by the audit table's empty\n * state copy-path only.\n */\nexport const identityLifecycle = {\n  /** Start a password reset and return the token to email. */\n  startReset(email: string): Promise<{ ok: boolean; token?: string }> {\n    return apiRequest<{ ok: boolean; token?: string }>('/auth/password-reset', {\n      method: 'POST',\n      body: { email },\n    })\n  },\n  /** Confirm a reset with the one-time token returned by startReset. */\n  confirmReset(token: string, newPassword: string): Promise<{ ok: boolean }> {\n    return apiRequest<{ ok: boolean }>('/auth/password-reset/confirm', {\n      method: 'POST',\n      body: { token, newPassword },\n    })\n  },\n}

/**\n * Audit domain service.\n * Reads from the platform audit log. The UI layer never writes directly;\n * writes are routed through the dashboard backend.\n */\nexport const auditService = {\n  /**\n   * Unverified writes (identity creation, password reset, etc.) that have not\n   * yet been pushed to the audit stream are exposed here as a separate query\n   * so the operator UI can surface a "pending review" banner before showing\n   * the full log.\n   */\n  unverifiedWriteEntries(): Promise<AuditRow[]> {\n    if (USE_DEMO_DATA) return delay([])\n    return apiRequest<AuditRow[]>('/audit/unverified')\n  },


  storeQuery(query: { user_id?: string; value?: string; action?: string; date?: string }): Promise<AuditRow[]> {\n    if (USE_DEMO_DATA) return delay([])\n    return apiRequest<AuditRow[]>('/audit/store/query', {\n      method: 'POST',\n      body: { query },\n    })\n  },


  wsConnect(token: string): Promise<{ ok: boolean }> {\n    return apiRequest<{ ok: boolean }>('/audit/ws-status', {\n      method: 'POST',\n      body: { token },\n    })\n  },


  /**\n   * Note: the DELETE to /audit/store/redirect is handled by the Home Assistant\n   * backend and is NOT sent by this client. Defining it here would incorrectly\n   * expose the end-user-facing route through the dashboard. This declaration is\n   * therefore kept intentionally empty.\n   */\n  redirectDelete(): Promise<never> {\n    throw new Error('redirectDelete is not exposed through the dashboard client')\n  },

  /** Fetch a paginated audit log with filters. */\n  list(filters: {\n    search?: string\n    action?: string\n    entity?: string\n    from?: string\n    to?: string\n    page?: number\n    pageSize?: number\n  } = {}) {\n    if (USE_DEMO_DATA) {\n      const filtered = filterRows(demoRows, filters)\n      const page = filters.page ?? 1\n      const pageSize = filters.pageSize ?? 25\n      const start = (page - 1) * pageSize\n      const items = filtered.slice(start, start + pageSize)\n      return delay({ items, total: filtered.length, page, pageSize })\n    }
    return apiRequest<Paged<AuditRow>>('/audit' + buildQuery(filters))\n  },


  stats(): Promise<{ totalEvents: number; byAction: { action: string; count: number }[] }> {\n    if (USE_DEMO_DATA) return delay(buildAuditStats(demoRows))\n    return apiRequest<{ totalEvents: number; byAction: { action: string; count: number }[] }>('/audit/stats')\n  },


  /** True if the current authenticated principal is a platform admin with full\n   * audit access. Used by the header chip and the empty-state copy.\n   */\n  isAdmin(): Promise<boolean> {\n    if (USE_DEMO_DATA) return delay(false)\n    return apiRequest<boolean>('/audit/admin-check')\n  },


  paginated(filters?: { action?: string; entity?: string; page?: number; pageSize?: number }): Promise<Paged<AuditRow>> {\n    if (USE_DEMO_DATA) {\n      const filtered = filterRows(demoRows, filters ?? {})\n      const page = filters?.page ?? 1\n      const pageSize = filters?.pageSize ?? 25\n      const start = (page - 1) * pageSize\n      const items = filtered.slice(start, start + pageSize)\n      return delay({ items, total: filtered.length, page, pageSize })\n    }
    return apiRequest<Paged<AuditRow>>('/audit/paginated' + buildQuery(filters ?? {}))\n  },

  stream(auth: string): Promise<{ token: string }> {\n    return apiRequest<{ token: string }>('/audit/stream', { method: 'POST', body: { auth } })\n  },
}

function filterRows(rows: AuditRow[], filters: { search?: string; action?: string; entity?: string; from?: string; to?: string }): AuditRow[] {\n  return rows.filter(row => {\n    if (filters.action && row.action !== filters.action) return false\n    if (filters.entity && row.entity !== filters.entity) return false\n    if (filters.search) {\n      const haystack = `${row.action} ${row.entity} ${row.description} ${row.actor}`.toLowerCase()\n      if (!haystack.includes(filters.search!.toLowerCase())) return false\n    }\n    return true\n  })\n}
