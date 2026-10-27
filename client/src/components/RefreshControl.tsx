import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from '../lib/utils'
import { useRefreshContext } from '../hooks/usePageRefresh'

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Human reason for a failure, distinguishing rate limiting from auth. */
function reasonFor(status: number | undefined, retryAfterSec: number | undefined): string | null {
  if (status === 429) {
    return typeof retryAfterSec === 'number'
      ? `Rate limited — try again in about ${retryAfterSec}s`
      : 'Rate limited by the server'
  }
  if (status === 401) return 'Not authenticated — the session may have expired'
  if (status === 403) return 'Not authorised for this data'
  return null
}

/**
 * Global manual refresh control, rendered in the shared navbar.
 * Refreshes the current page's registered queries only (see usePageRefresh).
 */
export function RefreshControl() {
  const { runRefresh, busy, refreshing, lastSuccessAt, failures, total } = useRefreshContext()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const failed = failures.length > 0

  // Surface a failed refresh immediately — the error must not be discoverable
  // only by chance. The user then dismisses it (Escape / outside click).
  const wasFailed = useRef(false)
  useEffect(() => {
    if (failed && !wasFailed.current) setOpen(true)
    wasFailed.current = failed
  }, [failed])

  // Close the detail panel on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const retryHint = useMemo(() => {
    const secs = failures
      .map((f) => f.info?.retryAfterSec)
      .filter((n): n is number => typeof n === 'number')
    return secs.length > 0 ? Math.max(...secs) : null
  }, [failures])

  const label = refreshing || busy ? 'Updating…' : 'Update'

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2">
      <span className="hidden text-xs text-ink-500 lg:inline" data-testid="last-refresh">
        {busy
          ? 'Loading the latest data…'
          : lastSuccessAt !== null
            ? `Updated ${clockTime(lastSuccessAt)}`
            : 'No successful update yet'}
      </span>

      {failed ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="hidden items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 sm:inline-flex"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
          Update failed{retryHint !== null ? ` · retry ~${retryHint}s` : ''}
        </button>
      ) : null}

      <button
        type="button"
        onClick={runRefresh}
        disabled={busy}
        aria-busy={busy}
        title="Refresh this page's data"
        className={clsx(
          'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-champagne-400/70 focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-60',
          failed
            ? 'border-ink-200 bg-white text-ink-700 hover:bg-ink-100'
            : 'border-ink-900 bg-ink-900 text-white hover:bg-ink-700',
        )}
      >
        <svg
          className={clsx(refreshing || busy ? 'animate-spin' : undefined)}
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path d="M13.5 2v3.2h-3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
      </button>

      {open && failed ? (
        <div
          role="alert"
          data-testid="refresh-failures"
          className="absolute right-0 top-10 z-50 w-80 rounded-lg border border-ink-200 bg-white p-3 shadow-popover"
        >
          <p className="text-xs font-semibold text-ink-900">
            {failures.length} of {total} data sources failed to update
          </p>
          <ul className="mt-2 space-y-2">
            {failures.map((f, i) => {
              const status = f.info?.status
              const reason = reasonFor(status, f.info?.retryAfterSec)
              return (
                <li key={i} className="text-xs text-ink-600">
                  <span className="font-medium text-ink-800">
                    {status ? `HTTP ${status}` : 'Request failed'}
                    {f.info?.code ? ` (${f.info.code})` : ''}
                  </span>{' '}
                  — {f.message}
                  {reason ? <span className="block text-ink-500">{reason}</span> : null}
                </li>
              )
            })}
          </ul>
          {retryHint !== null ? (
            <p className="mt-2 border-t border-ink-200 pt-2 text-xs text-ink-600">
              Another attempt may be appropriate in about {retryHint}s (at {clockTime(Date.now() + retryHint * 1000)}).
              Existing data is kept on screen.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
