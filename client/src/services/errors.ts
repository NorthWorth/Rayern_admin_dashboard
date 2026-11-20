import { apiRequest, buildQuery, USE_DEMO_DATA } from '../lib/api'
import type { ErrorEntry, ErrorFilters } from '../lib/types'
import { buildErrors } from './demoData'

const demoErrors = buildErrors()

function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function filterErrors(list: ErrorEntry[], filters: ErrorFilters): ErrorEntry[] {
  const search = filters.search?.trim().toLowerCase()
  return list.filter((e) => {
    if (filters.severity && filters.severity !== 'all' && e.severity !== filters.severity) return false
    if (search) {
      const haystack = `${e.service} ${e.endpoint} ${e.message} ${e.traceId ?? ''}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

export const errorsService = {
  list(filters: ErrorFilters = {}): Promise<ErrorEntry[]> {
    if (USE_DEMO_DATA) return delay(filterErrors(demoErrors, filters))
    // The filters must reach the server: the backend owns the WHERE clause.
    // Sending them here keeps the UI and the API in agreement (a client-side
    // re-filter of an unfiltered 500-row page silently hides real matches).
    const query = buildQuery({
      search: filters.search?.trim() || undefined,
      severity: filters.severity && filters.severity !== 'all' ? filters.severity : undefined,
    })
    return apiRequest<ErrorEntry[]>(`/errors${query}`)
  },
}
