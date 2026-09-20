import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { clsx } from '../lib/utils'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (item: T) => ReactNode
  sortValue?: (item: T) => string | number
  align?: 'left' | 'right'
  width?: string
}

interface DataTableProps<T> {
  columns: Array<Column<T>>
  rows: T[]
  getRowKey: (item: T) => string
  emptyState?: ReactNode
  initialSort?: { key: string; dir: 'asc' | 'desc' } | null
}

/** Dense, sortable data table used across the dashboard. */
export function DataTable<T>({ columns, rows, getRowKey, emptyState, initialSort = null }: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort)

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const sorted = [...rows].sort((a, b) => {
      const av = col.sortValue?.(a) ?? ''
      const bv = col.sortValue?.(b) ?? ''
      if (typeof av === 'number' && typeof bv === 'number') {
        return sort.dir === 'asc' ? av - bv : bv - av
      }
      return sort.dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return sorted
  }, [rows, sort, columns])

  const toggleSort = (key: string): void => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: 'desc' }
      if (prev.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-ink-200 bg-ink-50/60">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={clsx(
                  'px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500',
                  c.align === 'right' && 'text-right',
                )}
              >
                {c.sortValue ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-ink-800 focus-visible:outline-none"
                    onClick={() => toggleSort(c.key)}
                    aria-label={`Sort by ${typeof c.header === 'string' ? c.header : c.key}`}
                  >
                    {c.header}
                    <span className={clsx('text-ink-400', sort?.key === c.key && 'text-ink-800')}>
                      {sort?.key === c.key ? (sort.dir === 'desc' ? '↓' : '↑') : '↕'}
                    </span>
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{emptyState ?? <div className="px-4 py-10 text-center text-sm text-ink-500">No results.</div>}</td>
            </tr>
          ) : (
            sortedRows.map((row) => (
              <tr key={getRowKey(row)} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                {columns.map((c) => (
                  <td key={c.key} className={clsx('px-3 py-2.5 align-middle', c.align === 'right' ? 'text-right' : 'text-left')}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
