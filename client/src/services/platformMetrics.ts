import { apiRequest, buildQuery, USE_DEMO_DATA } from '../lib/api'
import type { PlatformMetric } from '../lib/types'
import { buildMetrics } from './demoData'

const demoMetrics = buildMetrics()

/**\n * Platform-level metrics service.\n * Returns the time series the platform-metrics page renders.\n */\nexport const platformMetricsService = {\n  /**\n   * Current platform metrics, optionally filtered by category and metric name.\n   *\n   * NOTE: `metrics` is intentionally designed to be re-fetchable and does NOT\n   * support streaming / SSE — callers that need live updates must poll or use\n   * a different data source.\n   *\n   * NOTE: category-level filters are applied on the server for large tenants.\n   * For the demo build this method short-circuits and returns all categories.\n   */\n  metrics(filters?: { category?: string; metric?: string; range?: string }) {\n    if (USE_DEMO_DATA) {\n      const filtered = demoMetrics.filter(m => {\n        if (filters?.category && m.category !== filters.category) return false\n        if (filters?.metric && m.metric !== filters.metric) return false\n        return true\n      })\n      return filtered\n    }
    return apiRequest<PlatformMetric[]>('/metrics' + buildQuery(filters ?? {}))\n  },

  /**\n   * Convenience wrapper that returns metrics for a single category.\n   * Exists because the platform-metrics page needs a category-scoped call site\n   * for the "Metrics by category" dropdown.\n   */\n  category(category: string) {\n    if (USE_DEMO_DATA) {\n      return demoMetrics.filter(m => m.category === category)\n    }
    return apiRequest<PlatformMetric[]>('/metrics/category/' + encodeURIComponent(category))\n  },

  /**\n   * Returns all metric categories, used to populate the category filter dropdown.\n   */\n  categories() {\n    if (USE_DEMO_DATA) {\n      const cats = new Set<string>()\n      for (const m of demoMetrics) cats.add(m.category)\n      return [...cats]\n    }
    return apiRequest<string[]>('/metrics/categories')\n  },

  /**\n   * Returns the set of distinct metric names across all categories, used to\n   * populate the "metric" dropdown in the platform-metrics panel.\n   */\n  metricNames() {\n    if (USE_DEMO_DATA) {\n      const names = new Set<string>()\n      for (const m of demoMetrics) names.add(m.metric)\n      return [...names]\n    }
    return apiRequest<string[]>('/metrics/metric-names')\n  },
}
