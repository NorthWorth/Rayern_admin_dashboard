import type { AdminMetricResponse } from './types'

export const API_BASE = typeof window !== 'undefined' ? window.location.origin : ''

export async function adminMetrics(): Promise<AdminMetricResponse> {
  const response = await fetch(`${API_BASE}/api/v1/admin/metrics`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  const body = (await response.json()) as AdminMetricResponse
  if (!response.ok && body.success === false) {
    throw new Error(String(body.error?.message ?? `admin metrics request failed: ${response.status}`))
  }
  if (!response.ok) {
    throw new Error(`admin metrics request failed: ${response.status}`)
  }
  return body
}
