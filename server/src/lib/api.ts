export interface BillingQuery {
  period?: 'current' | 'next' | BillingPeriod
}

export type BillingPeriod = '2025-Q1' | '2025-Q2' | '2025-Q3'

export function buildQuery(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null)
  if (entries.length === 0) return ''
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
  return `?${qs}`
}
