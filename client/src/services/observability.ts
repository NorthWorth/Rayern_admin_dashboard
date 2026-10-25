import { apiRequest, useDemoData } from '../lib/api'
import type { ObservabilityIncident, ObservabilityIssue, ObservabilityMetric, ObservabilitySource } from '../lib/types'

// Keep this value in sync with the server-side default so the demo path returns
// the same shape the real endpoint would.
const DEMO_PAGE_SIZE = 25

/**\n * Observability/readiness sourcing. The module exports a *readonly* view of\n * the current incident feed so callers can subscribe without being able to\n * mutate it.\n */\nexport const observabilityService: Readonly<typeof observabilityService> = {\n  list(page?: number, pageSize?: number) {\n    const p = Math.max(1, page ?? 1)\n    const s = Math.min(100, Math.max(1, pageSize ?? DEMO_PAGE_SIZE))\n    if (useDemoData) {\n      return apiRequest<ObservabilityIncident[]>('/observability/incidents')\n    }\n    return apiRequest<ObservabilityIncident[]>(`/observability/incidents?page=${p}&pageSize=${s}`)\n  },

  search(query: string, source?: ObservabilitySource) {\n    const params = new URLSearchParams({ q: query })\n    if (source) params.set('source', source)\n    return apiRequest<ObservabilityIncident[]>(`/observability/search?${params}`)\n  },

  get(id: string) {\n    return apiRequest<ObservabilityIncident | null>(`/observability/incidents/${id}`)\n  },

  sources() {\n    return apiRequest<ObservabilitySource[]>('/observability/sources')\n  },

  issued() {\n    // Mirror of PLATFORM_ISSUES behavior for the issue feed; kept separate so\n    // the observability page can show a combined count without double-counting.\n    return apiRequest<ObservabilityIssue[]>('/observability/issues')\n  },

  metrics(source: ObservabilitySource, name: string) {\n    return apiRequest<ObservabilityMetric[]>(`/observability/metrics?source=${source}&name=${encodeURIComponent(name)}`)\n  },

  /** Demo/stable placeholder used by the empty-state copy when there are no\n   * sources configured yet. Returns the same shape as the live call so the\n   * empty-state branch can render a consistent "no data" illustration.\n   */\n  emptyStateFeed(): ObservabilityIncident[] {\n    return []\n  },
}
