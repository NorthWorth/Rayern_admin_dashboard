import type { HealthStatus } from './types'

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

export function formatPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`
  if (ms >= 1) return `${Math.round(ms)}ms`
  return `${ms.toFixed(2)}ms`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Compact relative time like "3m ago" / "2h ago" / "5d ago". */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

export function initialsOf(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* ------------------------- Audience (recipient counts) --------------------- */

export interface AudienceSummary {
  total: number
  to: number
  cc: number
  bcc: number
  /** Compact aggregate label, e.g. "250 recipients" — never a raw address list. */
  label: string
  /** "1 To · 5 CC · 244 BCC" when CC/BCC are in play, otherwise null. */
  breakdown: string | null
}

/**
 * Compact recipient summary for bulk-send-safe rendering. Tables and audit
 * rows must NEVER render hundreds of addresses — they render these counts;
 * the underlying recipient arrays stay available for details views/audit.
 */
export function audienceSummary(to: string[], cc: string[], bcc: string[]): AudienceSummary {
  const t = to.length
  const c = cc.length
  const b = bcc.length
  const total = t + c + b
  return {
    total,
    to: t,
    cc: c,
    bcc: b,
    label: `${total} recipient${total === 1 ? '' : 's'}`,
    breakdown: c > 0 || b > 0 ? `${t} To · ${c} CC · ${b} BCC` : null,
  }
}

/** Single-line audience text for compact rows: "250 recipients · 1 To · …". */
export function audienceLine(to: string[], cc: string[], bcc: string[]): string {
  const a = audienceSummary(to, cc, bcc)
  return a.breakdown ? `${a.label} · ${a.breakdown}` : a.label
}

/** Deterministic past date offset from now, used by the demo data layer. */
export function daysAgoIso(days: number, hour = 12): string {
  const d = new Date()
  d.setDate(d.getDate() - Math.floor(days))
  d.setHours(hour, (Math.floor(days * 60) % 60), 0, 0)
  return d.toISOString()
}

export function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString()
}

/** Severity order for rollups: `unknown` is the LEAST severe (no evidence
 * either way) — it must never be mistaken for a problem or for health. */
export const HEALTH_ORDER: readonly HealthStatus[] = ['unknown', 'healthy', 'degraded', 'failing']
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'unknown'
  return HEALTH_ORDER[Math.max(...statuses.map((s) => HEALTH_ORDER.indexOf(s)))] ?? 'unknown'
}

export type HealthTone = 'neutral' | 'green' | 'amber' | 'red'

/** Badge tone for the four-state health model — `unknown` renders neutral. */
export function healthTone(s: HealthStatus): HealthTone {
  switch (s) {
    case 'healthy': return 'green'
    case 'degraded': return 'amber'
    case 'failing': return 'red'
    default: return 'neutral'
  }
}

/** Badge label for health — `unknown` displays as "No data", not "Unknown". */
export function healthLabel(s: HealthStatus): string {
  return s === 'unknown' ? 'No data' : titleCase(s)
}

export function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
