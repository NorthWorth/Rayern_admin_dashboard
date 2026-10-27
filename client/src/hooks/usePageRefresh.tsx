import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { QueryError, QueryState } from './useQuery'

/**
 * Shared, page-scoped refresh mechanism behind the global navbar control.
 *
 * The navbar must refresh the CURRENT page's data — never every endpoint in
 * the application. Each page therefore registers exactly the queries it is
 * rendering (through `usePageRefresh`); the provider aggregates their loading
 * and error state and invokes their existing `refetch` functions.
 *
 * Rules enforced here:
 *  - one refresh at a time (repeated clicks are ignored while in flight);
 *  - the last-successful-refresh timestamp only advances after a clean settle;
 *  - failures keep their HTTP status, server code and retry information so the
 *    navbar can distinguish rate limiting (429 + Retry-After) from
 *    authentication failures (401/403);
 *  - route, filters, period selection and pagination live in page components,
 *    so refreshing never resets them.
 */

/** The subset of `QueryState` the refresh mechanism needs. */
export type RefreshableQuery = Pick<QueryState<unknown>, 'refetch' | 'loading' | 'error' | 'errorInfo'>

export interface PageRefreshEntry {
  loading: boolean
  /** How many queries this page registered — the denominator of failure counts. */
  count: number
  errors: Array<{ message: string; info: QueryError | null }>
  refresh: () => void
}

interface RefreshContextValue {
  /** Called by `usePageRefresh` on every state change of the mounted page. */
  setPage: (id: string, entry: PageRefreshEntry | null) => void
  /** Requests a refresh of the current page's registered queries. */
  runRefresh: () => void
  busy: boolean
  refreshing: boolean
  lastSuccessAt: number | null
  failures: Array<{ message: string; info: QueryError | null }>
  /** How many data sources the current page registered (for failure summaries). */
  total: number
}

const RefreshContext = createContext<RefreshContextValue | null>(null)

function sameErrors(
  a: PageRefreshEntry['errors'],
  b: PageRefreshEntry['errors'],
): boolean {
  if (a.length !== b.length) return false
  return a.every((e, i) => e.message === b[i]?.message && e.info === b[i]?.info)
}

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [pages, setPages] = useState<Record<string, PageRefreshEntry>>({})
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const flightSeen = useRef(false)
  const wasClean = useRef(false)
  const pagesRef = useRef(pages)
  pagesRef.current = pages

  const setPage = useCallback((id: string, entry: PageRefreshEntry | null) => {
    setPages((prev) => {
      if (entry === null) {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      }
      const current = prev[id]
      if (
        current &&
        current.loading === entry.loading &&
        current.count === entry.count &&
        sameErrors(current.errors, entry.errors)
      ) {
        return prev
      }
      return { ...prev, [id]: entry }
    })
  }, [])

  const entries = useMemo(() => Object.values(pages), [pages])
  const busy = refreshing || entries.some((e) => e.loading)
  // Registered queries across the current page (pages may register many).
  const total = entries.reduce((sum, e) => sum + e.count, 0)
  const failures = useMemo(
    () => entries.flatMap((e) => e.errors),
    [entries],
  )
  const clean = entries.length > 0 && !entries.some((e) => e.loading) && failures.length === 0

  // Last successful update = the moment a page settles with no failures.
  useEffect(() => {
    if (clean && !wasClean.current) setLastSuccessAt(Date.now())
    wasClean.current = clean
  }, [clean, pages])

  // A manual refresh ends once its requests have started and settled.
  useEffect(() => {
    if (!refreshing) return
    if (entries.some((e) => e.loading)) {
      flightSeen.current = true
      return
    }
    if (!flightSeen.current) return
    flightSeen.current = false
    setRefreshing(false)
  }, [refreshing, pages, entries])

  const runRefresh = useCallback(() => {
    const current = Object.values(pagesRef.current)
    // Nothing registered (or already in flight) → never start a second round.
    if (current.length === 0 || current.some((e) => e.loading)) return
    flightSeen.current = false
    setRefreshing(true)
    for (const entry of current) entry.refresh()
  }, [])

  const value = useMemo(
    () => ({ setPage, runRefresh, busy, refreshing, lastSuccessAt, failures, total }),
    [setPage, runRefresh, busy, refreshing, lastSuccessAt, failures, total],
  )

  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
}

export function useRefreshContext(): RefreshContextValue {
  const ctx = useContext(RefreshContext)
  if (!ctx) throw new Error('useRefreshContext must be used within RefreshProvider')
  return ctx
}

/**
 * Registers the current page's queries with the global refresh control.
 * Pass the same `useQuery` results the page renders — the navbar then refreshes
 * exactly this page's data, preserving route, filters and pagination.
 */
export function usePageRefresh(queries: RefreshableQuery[]): void {
  const { setPage } = useRefreshContext()
  const id = useId()
  const queriesRef = useRef(queries)
  queriesRef.current = queries

  const loading = queries.some((q) => q.loading)
  const errorKey = queries.map((q) => q.error ?? '').join('\u0000')

  useEffect(() => {
    const current = queriesRef.current
    setPage(id, {
      loading,
      count: current.length,
      errors: current
        .filter((q) => q.error !== null)
        .map((q) => ({ message: q.error as string, info: q.errorInfo })),
      refresh: () => {
        for (const q of queriesRef.current) q.refetch()
      },
    })
  }, [loading, errorKey, id, setPage])

  useEffect(() => () => setPage(id, null), [id, setPage])
}
