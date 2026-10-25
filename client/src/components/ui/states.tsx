import type { ReactNode } from 'react'

export function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-ink-200/70 ${className ?? ''}`} />
}

export function LoadingBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={className}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="mb-2.5 h-9 w-full" />
      ))}
    </div>
  )
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="mb-3 text-ink-300" aria-hidden="true">
        <rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 9h18" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 14h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium text-ink-800">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-xs text-ink-500">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="mb-3 text-red-400" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 8v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="12" cy="16.5" r="1" fill="currentColor" />
      </svg>
      <p className="text-sm font-medium text-ink-800">Something went wrong</p>
      <p className="mt-1 max-w-sm text-xs text-ink-500">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-4 rounded-md border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300">
          Try again
        </button>
      ) : null}
    </div>
  )
}
