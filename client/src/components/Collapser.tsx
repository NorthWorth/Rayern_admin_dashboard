import { useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Dashboard-wide "5-row rule": long lists and tables show their first 5 rows
 * and collapse the rest behind an unobtrusive "View more" control.
 *
 * The underlying data is never truncated or removed — `children` receives how
 * many rows to render right now (`5` collapsed, all expanded), and callers
 * slice only at render time. When there are at most `initial` rows the toggle
 * is not rendered at all, so short lists look exactly as before.
 *
 * Render-prop shape keeps this table-agnostic: the caller renders its own
 * `<table>`/`<ul>` (including wrapper divs) and slices with the given count.
 */
export function Collapser({
  total,
  initial = 5,
  label,
  children,
}: {
  /** Total number of rows available. */
  total: number
  /** Rows shown before expanding (the dashboard-wide default is 5). */
  initial?: number
  /** What the rows are, for the toggle copy (e.g. "traces", "errors"). */
  label?: string
  children: (visibleCount: number) => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  if (total <= initial) {
    // Nothing to collapse — render everything, no control, zero layout change.
    return <>{children(total)}</>
  }
  const shown = expanded ? total : initial
  const hidden = total - initial
  const noun = label ?? 'more'
  return (
    <>
      {children(shown)}
      <div className="border-t border-ink-100 px-4 py-2 text-center">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="rounded text-xs font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300"
        >
          {expanded ? 'View less' : `View more (${hidden} ${noun})`}
        </button>
      </div>
    </>
  )
}
