import { formatNumber } from '../lib/utils'

interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)

  return (
    <div className="flex items-center justify-between border-t border-ink-200 px-4 py-2.5">
      <p className="text-xs text-ink-500">
        Showing <span className="font-medium text-ink-700">{formatNumber(from)}</span>–<span className="font-medium text-ink-700">{formatNumber(to)}</span> of{' '}
        <span className="font-medium text-ink-700">{formatNumber(total)}</span>
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="rounded border border-ink-200 bg-white px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <span className="px-2 text-xs text-ink-500">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="rounded border border-ink-200 bg-white px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  )
}
