import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
  /** Short provenance / timezone / freshness line under the description. */
  footnote?: ReactNode
}

/** Consistent page heading used by every dashboard page. */
export function PageHeader({ title, description, actions, footnote }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-2xl leading-tight tracking-tight text-ink-900">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-500">{description}</p> : null}
        {footnote ? <div className="mt-1.5 text-xs text-ink-400">{footnote}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export interface PeriodOption {
  days: 7 | 30 | 90
  label: string
}

export const PERIODS: PeriodOption[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

/** Reporting timezone for every date-boundary calculation in the dashboard. */
export const REPORTING_TIMEZONE = 'UTC'

/**
 * Segmented reporting-period selector (7 / 30 / 90 days).
 * Controlled by the page so the choice survives a global refresh.
 */
export function PeriodSelector({
  value,
  onChange,
  disabledDays = [],
}: {
  value: 7 | 30 | 90
  onChange: (days: 7 | 30 | 90) => void
  disabledDays?: Array<7 | 30 | 90>
}) {
  return (
    <div
      role="group"
      aria-label="Reporting period"
      className="inline-flex rounded-md border border-ink-200 bg-white p-0.5 shadow-card"
    >
      {PERIODS.map((p) => {
        const active = p.days === value
        const disabled = disabledDays.includes(p.days)
        return (
          <button
            key={p.days}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(p.days)}
            className={
              'rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
              (active ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100')
            }
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}
