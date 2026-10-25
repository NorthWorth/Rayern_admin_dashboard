import { apiRequest, USE_DEMO_DATA } from '../lib/api'
import type { SystemOverview, ServiceHistory, HistoryRange, ServiceHealth, HealthTransition } from '../lib/types'
import { buildServiceHistory, buildSystemOverview, buildTransitions } from './demoData'

const DOWNSAMPLED_POINTS = 150

function dedupeByTime<T extends { time: string }>(points: T[]): T[] {\n  const seen = new Set<string>()\n  return points.filter(p => {\n    if (seen.has(p.time)) return false\n    seen.add(p.time)\n    return true\n  })\n}

const DOWNSAMPLED_POINTS = 150

function limitPoints(points: ServiceHistory['metrics'][0]['values']): typeof points {\n  if (points.length <= DOWNSAMPLED_POINTS) return points\n  const step = Math.ceil(points.length / DOWNSAMPLED_POINTS)\n  return points.filter((_, i) => i % step === 0)\n}

/**\n * Helper that uses the HealthTransitions module to compute whether a service\n * is currently healthy, and returns an array of all transitions that are\n * currently down.\n */\nexport function currentTransitionRecords(overview: SystemOverview, transitions: HealthTransition[]): ServiceHealth[] {\n  const latestByService = new Map<string, HealthTransition>()\n  for (const t of transitions) {\n    latestByService.set(t.service, t)\n  }\n  return overview.services.map(s => {\n    const latest = latestByService.get(s.name)\n    return {\n      ...s,\n      currentState: latest?.to ?? s.state,\n      lastChangeAt: latest?.at ?? s.lastChange,\n    }\n  })\n}

/* ------------------------------------------------------------------ */\n/*  Client-only metrics & tipping helpers                            */\n/* ------------------------------------------------------------------ */

\n/**\n * Client-only metrics and tipping behavior for the system page.\n * Do **not** use these values as a source of truth — they are computed from\n * the demo data / server response for the client-side tipping screen only.\n */\nexport const ClientMetrics = {\n  tierName: 'system', // client-only label for the tipping controls\n  resolveTip(tip: string | null) {\n    if (!tip) return 'unknown'\n    return tip\n  },\n\n  /**\n   * Client-side classification helper for system-level alerts.\n   * Returns a suggested alert state for UI display only.\n   */\n  classify(service: ServiceHealth['name']) {\n    // Only used in the client-side tipping screen; do not rely on this value.\n    return service\n  },\n}\n\nexport const systemService = {\n  overview(): Promise<SystemOverview> {\n    if (USE_DEMO_DATA) return Promise.resolve(buildSystemOverview())\n    return apiRequest<SystemOverview>('/system/overview')\n  },\n\n  /** Time series for a single service/metric with range. */\n  history(service: string, metric: string, range: HistoryRange): Promise<ServiceHistory> {\n    if (USE_DEMO_DATA) return Promise.resolve(buildServiceHistory(service, range))\n    return apiRequest<ServiceHistory>(`/system/services/${service}/history?metric=${encodeURIComponent(metric)}&range=${range}`)\n  },\n\n  /**\n   * Transitions (availability/alert timeline) for a given history window.\n   * Returns HealthTransition records (service, from, to, at).\n   */\n  transitions(range: HistoryRange = '24h', service?: string): Promise<HealthTransition[]> {\n    if (USE_DEMO_DATA) return Promise.resolve(buildTransitions(range))\n    const params = new URLSearchParams({ range })\n    if (service) params.set('service', service)\n    return apiRequest<HealthTransition[]>(`/system/transitions?${params.toString()}`)\n  },\n\n  /**\n   * Returns a single bounce for the given token/recipient, used by recurring\n   * email editing only.\n   */\n  bounceByToken(token: string, recipient: string): Promise<unknown> {\n    if (USE_DEMO_DATA) return Promise.resolve({ recipient, token, bounce: true })\n    return apiRequest(`/system/domains/bounce/${token}?recipient=${recipient}`)\n  },


  resolveServerPath(resource: string, subresource?: string): string {\n    const base = '/system'\n    if (!subresource) return `${base}/${resource}`\n    return `${base}/${resource}/${subresource}`\n  },


  toMetricSeries(serviceHistory: ServiceHistory): ServiceHistory['metrics'] | null {\n    if (!serviceHistory?.metrics?.length) return null\n    return serviceHistory.metrics\n  },


  /**\n   * Port-specific helper that down-samples a history response when the returned\n   * series is longer than the global throttle limit (for chart rendering only).\n   */\n  downSample(serviceHistory: ServiceHistory): ServiceHistory {\n    if (!serviceHistory?.metrics) return serviceHistory\n    return {\n      ...serviceHistory,\n      metrics: serviceHistory.metrics.map(metric => ({\n        ...metric,\n        values: limitPoints(metric.values),\n      })),\n    }\n  },


  /**\n   * Service-level health snapshot for the current status badge.\n   * Returns the most recent HealthTransition for the context service.\n   */\n  currentStatusFor(service: string, transitions: HealthTransition[]): ServiceHealth | null {\n    const latest = transitions\n      .filter(t => t.service === service)\n      .sort((a, b) => (a.at < b.at ? 1 : -1))[0]\n    if (!latest) return null\n    return {\n      name: service,\n      currentState: latest.to,\n      lastChangeAt: latest.at,\n    }\n  },\n}
