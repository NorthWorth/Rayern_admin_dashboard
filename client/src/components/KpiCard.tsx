import type { ReactNode } from 'react'
import { clsx } from '../lib/utils'

interface KpiCardProps {
  label: string
  value: string
  sub?: string
  /** Secondary line under the value (period, definition, source). */
  note?: string
  /** Legacy percentage trend (kept for existing pages). */
  trendPct?: number | null
  /** Richer comparison: absolute change plus percentage when computable. */
  delta?: { absolute: number; pct: number | null } | null
  tone?: 'default' | 'green' | 'amber' | 'red'
  /**
   * `primary` renders the featured Deep Ink card (Total Registered Users);
   * `default` renders the quieter white supporting cards.
   */
  variant?: 'primary' | 'default'
  /** Optional body for unavailable metrics (replaces the value treatment). */
  children?: ReactNode
}

/**
 * KPI card hierarchy:
 *  - one featured Deep Ink card for the headline metric;
 *  - quieter white cards for supporting metrics.
 * Champagne appears only as a small highlight on the featured card.
 */
export function KpiCard({
  label,
  value,
  sub,
  note,
  trendPct,
  delta,
  tone = 'default',
  variant = 'default',
  children,
}: KpiCardProps) {
  const deltaValue = delta
    ? delta
    : typeof trendPct === 'number'
      ? { absolute: null as unknown as number, pct: trendPct }
      : null

  if (variant === 'primary') {
    return (
      <div className="relative overflow-hidden rounded-lg bg-ink-900 px-5 py-5 text-white">
        {/* Restrained champagne highlight — a single rule, never a gradient. */}
        <span className="absolute left-0 top-0 h-full w-1 bg-champagne-500" aria-hidden="true" />
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-300">{label}</p>
        <p className="mt-2 font-display text-5xl leading-none tracking-tight tabular-nums">{value}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          {sub ? <p className="text-xs text-ink-300">{sub}</p> : null}
          {deltaValue && typeof deltaValue.pct === 'number' ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-champagne-300">
              <span aria-hidden="true">{deltaValue.pct >= 0 ? '▲' : '▼'}</span>
              {deltaValue.pct >= 0 ? '+' : ''}
              {deltaValue.pct.toFixed(1)}%
              {typeof deltaValue.absolute === 'number' ? (
                <span className="font-normal text-ink-300">
                  ({deltaValue.absolute >= 0 ? '+' : ''}
                  {deltaValue.absolute.toLocaleString('en-US')})
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        {note ? <p className="mt-2 text-[11px] text-ink-400">{note}</p> : null}
        {children}
      </div>
    )
  }

  const valueTone =
    tone === 'green'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'red'
          ? 'text-red-700'
          : 'text-ink-900'

  return (
    <div className="rounded-lg border border-ink-200 bg-white px-4 py-3.5 shadow-card">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-500">{label}</p>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <p className={clsx('font-display text-3xl leading-none tracking-tight tabular-nums', valueTone)}>{value}</p>
        {deltaValue ? (
          <span
            className={clsx(
              'inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium',
              (deltaValue.pct ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-700',
            )}
          >
            <span aria-hidden="true">{(deltaValue.pct ?? 0) >= 0 ? '▲' : '▼'}</span>
            {deltaValue.pct !== null ? `${deltaValue.pct >= 0 ? '+' : ''}${deltaValue.pct.toFixed(1)}%` : 'n/a'}
            {typeof deltaValue.absolute === 'number' ? (
              <span className="font-normal text-ink-500">
                {deltaValue.absolute >= 0 ? '+' : ''}
                {deltaValue.absolute.toLocaleString('en-US')}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {children}
      {sub ? <p className="mt-1.5 text-xs text-ink-500">{sub}</p> : null}
      {note ? <p className="mt-1 text-[11px] text-ink-400">{note}</p> : null}
    </div>
  )
}
