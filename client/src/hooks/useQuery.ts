import { useCallback, useEffect, useRef, useState } from 'react'
import { HttpError } from '../lib/api'

/** Structured failure details so callers can show status/server context. */
export interface QueryError {
  /** Human-readable message (server-provided when the body carried one). */
  message: string
  /** HTTP status code, when the failure came from an HTTP response. */
  status?: number
  /** Server error code from the response envelope, when present. */
  code?: string
  /** Seconds until a retry may be appropriate (from Retry-After, when present). */
  retryAfterSec?: number
}

export interface QueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Same failure as `error`, with HTTP status / server code / retry info. */
  errorInfo: QueryError | null
  refetch: () => void
}

function toQueryError(err: unknown): QueryError {
  if (err instanceof HttpError) {
    return {
      message: err.message,
      status: err.status,
      code: err.code,
      retryAfterSec: err.retryAfterSec,
    }
  }
  return { message: err instanceof Error ? err.message : 'Something went wrong' }
}

/**
 * Tiny replacement for react-query: fetches from a service function,
 * tracks loading/error, supports refetch and avoids state updates after unmount.
 * Pass `null` for the fetcher to skip fetching.
 */
export function useQuery<T>(fetcher: (() => Promise<T>) | null, deps: readonly unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState<boolean>(fetcher !== null)
  const [error, setError] = useState<string | null>(null)
  const [errorInfo, setErrorInfo] = useState<QueryError | null>(null)
  const [tick, setTick] = useState(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!fetcher) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setErrorInfo(null)

    fetcher()
      .then((result) => {
        if (!cancelled && mounted.current) setData(result)
      })
      .catch((err: unknown) => {
        if (!cancelled && mounted.current) {
          const info = toQueryError(err)
          setError(info.message)
          setErrorInfo(info)
        }
      })
      .finally(() => {
        if (!cancelled && mounted.current) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps])

  const refetch = useCallback(() => setTick((t) => t + 1), [])

  return { data, loading, error, errorInfo, refetch }
}
