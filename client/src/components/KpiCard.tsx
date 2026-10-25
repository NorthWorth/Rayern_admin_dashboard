import { clsx } from '../lib/utils'

interface KpiCardProps {
  label: string
  value: string
  sub?: string
  trendPct?: number | null
  tone?: 'default' | 'green' | 'amber' | 'red'
}

export function KpiCard({ label, value, sub, trendPct, tone = 'default' }: KpiCardProps) {
  const accent = tone === 'green' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : tone === 'red' ? 'text-red-600' : 'text-ink-900'

  return (
    <div className="rounded-lg border border-ink-200 bg-white px-4 py-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className={clsx('text-2xl font-semibold tracking-tight', accent)}>{value}</p>
        {trendPct !== undefined && trendPct !== null ? (
          <span className={clsx('text-xs font-medium', trendPct >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {trendPct >= 0 ? '+' : ''}{trendPct.toFixed(1)}%
          </span>
        ) : null}
      </div>
      {sub ? <p className="mt-0.5 text-xs text-ink-500">{sub}</p> : null}
    </div>
  )
}
