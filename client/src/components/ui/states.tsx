import React from 'react'

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-ink-200" style={{ width: `${70 + (i % 3) * 10}%` }} />
      ))}
    </div>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50/60 p-6 text-center">
      <p className="text-sm font-medium text-ink-900">{title}</p>
      {description ? <p className="mt-1 text-sm text-ink-500">{description}</p> : null}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50/60 p-4 text-sm text-red-700">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-2 underline">Retry</button>
      ) : null}
    </div>
  )
}
