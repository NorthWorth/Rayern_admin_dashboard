import type { ReactNode } from 'react'

interface UnavailablePanelProps {
  title: string
  /** Why the metric cannot be measured with today's data. */
  reason: string
  /** The instrumentation or data source that would make it measurable. */
  required?: string
  children?: ReactNode
  className?: string
}

/**
 * Consistent treatment for a metric that cannot be measured reliably.
 * Never substitutes zeros, totals or look-alike metrics for real data.
 */
export function UnavailablePanel({ title, reason, required, children, className }: UnavailablePanelProps) {
  return (
    <div className={'rounded-lg border border-dashed border-ink-300 bg-ivory-50 px-4 py-4 ' + (className ?? '')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-sand-300 bg-sand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-700">
          Not measured
        </span>
        <p className="text-sm font-medium text-ink-800">{title}</p>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-600">{reason}</p>
      {required ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-500">
          <span className="font-medium text-ink-600">To measure it: </span>
          {required}
        </p>
      ) : null}
      {children}
    </div>
  )
}

/** Small definition/source note rendered under a metric or chart. */
export function MetricNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[11px] leading-relaxed text-ink-400">{children}</p>
}
