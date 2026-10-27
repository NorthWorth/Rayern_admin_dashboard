import type { AdminMetricResponse, ID, Paged } from './types'
import type { AdminOperator } from './types'

/**
 * API configuration for the dedicated dashboard backend.
 *
 * The frontend never talks to Rayern's database, Rayern's server internals, or
 * Resend directly — everything goes through the dashboard backend, whose base
 * URL is provided via VITE_ADMIN_API_URL. No secrets belong in frontend env.
 */

const env = import.meta.env

export const API_BASE_URL: string = (env.VITE_ADMIN_API_URL as string | undefined)?.trim() || ''

export const USE_DEMO_DATA: boolean =
  API_BASE_URL === '' || (env.VITE_ADMIN_USE_DEMO_DATA as string | undefined) === '1'

export const DEMO_MODE = USE_DEMO_DATA

/** Administrative sender identity for dashboard-sent emails (backend enforces). */
export const DEFAULT_FROM = 'Rayern <support@rayern.com.ng>'

export interface ApiError {
  status?: number
  message: string
}

/**
 * Error carrying everything the server told us about a failed request so the
 * UI can show *why* it failed instead of a generic message:
 *  - `status`        — HTTP status code (401, 429, 500, …)
 *  - `code`          — server error code from the response envelope, when present
 *                      (e.g. `UNAUTHENTICATED`, `ADMIN_ACCESS_REQUIRED`)
 *  - `retryAfterSec` — seconds until a retry may be appropriate, parsed from
 *                      `Retry-After` / `X-RateLimit-Reset` on 429/503 responses
 */
export class HttpError extends Error {
  status?: number
  code?: string
  retryAfterSec?: number

  constructor(message: string, status?: number, details: { code?: string; retryAfterSec?: number } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = details.code
    this.retryAfterSec = details.retryAfterSec
  }
}

/**
 * Parses rate-limit retry information from a response:
 *  - `Retry-After`        — delta-seconds or an HTTP date (RFC 9110)
 *  - `X-RateLimit-Reset`  — epoch seconds (or ms) at which the window resets
 * Returns whole seconds until the retry, or null when absent/invalid — a
 * missing header is never turned into an invented wait time.
 */
export function parseRetryAfter(res: Response, now = Date.now()): number | null {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs)
    const dateMs = Date.parse(retryAfter)
    if (!Number.isNaN(dateMs)) return Math.max(0, Math.ceil((dateMs - now) / 1000))
  }
  const reset = res.headers.get('x-ratelimit-reset')
  if (reset) {
    const value = Number(reset)
    if (Number.isFinite(value) && value > 0) {
      // Accept both seconds and milliseconds since epoch.
      const resetMs = value < 1e12 ? value * 1000 : value
      return Math.max(0, Math.ceil((resetMs - now) / 1000))
    }
  }
  return null
}

/* ------------------------------ Admin session ------------------------------ */

const TOKEN_KEY = 'rayern_admin_token'
const OPERATOR_KEY = 'rayern_admin_operator'

export interface LoginResponse {
  token: string
  operator: AdminOperator
}

export const session = {
  token(): string | null {
    return localStorage.getItem(TOKEN_KEY)
  },
  operator(): AdminOperator | null {
    const raw = localStorage.getItem(OPERATOR_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as AdminOperator
    } catch {
      return null
    }
  },
  set(login: LoginResponse): void {
    localStorage.setItem(TOKEN_KEY, login.token)
    localStorage.setItem(OPERATOR_KEY, JSON.stringify(login.operator))
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(OPERATOR_KEY)
  },
}

/** Fired when the backend rejects the admin token (401) so the app can re-auth. */
export const AUTH_EVENT = 'rayern:auth-expired'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/**
 * In-flight GETs, keyed by URL + session token. Concurrent identical reads
 * (a StrictMode double-mounted effect, two cards asking for the same
 * endpoint, an Update click landing while a first request is still out)
 * share one network request instead of issuing duplicates. Only settled
 * requests are shared — nothing is cached, so an Update always fetches anew.
 */
const inflightGet = new Map<string, Promise<unknown>>()

/**
 * Single place where the app talks to the dashboard backend.
 * Extend here (auth headers, retries, tracing headers) as the backend matures.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!API_BASE_URL) {
    throw new HttpError('Dashboard API is not configured (VITE_ADMIN_API_URL is not set).', undefined)
  }

  const method = options.method ?? 'GET'
  const url = `${API_BASE_URL.replace(/\/$/, '')}${path}`
  const token = session.token()

  // Share only fire-and-forget GETs: an aborted request would cancel its
  // other readers, and non-GETs must never be collapsed together.
  const shareKey = method === 'GET' && options.signal === undefined ? `${url}\u0000${token ?? ''}` : null
  if (shareKey !== null) {
    const pending = inflightGet.get(shareKey)
    if (pending) return pending as Promise<T>
  }

  const request = executeRequest<T>(url, method, options, token)
  if (shareKey !== null) {
    inflightGet.set(shareKey, request)
    void request
      .catch(() => undefined)
      .then(() => {
        if (inflightGet.get(shareKey) === request) inflightGet.delete(shareKey)
      })
  }
  return request
}

async function executeRequest<T>(
  url: string,
  method: NonNullable<RequestOptions['method']>,
  options: RequestOptions,
  token: string | null,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    credentials: 'include',
  })

  if (!res.ok) {
    let message = `Request failed with status ${res.status}`
    let code: string | undefined
    try {
      const payload = (await res.json()) as {
        message?: string
        code?: string
        error?: string | { code?: string; message?: string }
      }
      if (typeof payload.message === 'string' && payload.message) {
        message = payload.message
      } else if (typeof payload.error === 'string' && payload.error) {
        message = payload.error
      } else if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
        // Rayern/dashboard error envelope: { success: false, error: { code, message } }
        message = payload.error.message
      }
      if (typeof payload.code === 'string' && payload.code) {
        code = payload.code
      } else if (payload.error && typeof payload.error === 'object' && typeof payload.error.code === 'string') {
        code = payload.error.code
      }
    } catch {
      // keep default message
    }
    const retryAfterSec = parseRetryAfter(res)
    if (res.status === 401) {
      // Token expired or revoked — notify the shell so it shows the login view.
      window.dispatchEvent(new Event(AUTH_EVENT))
    }
    throw new HttpError(message, res.status, {
      code,
      retryAfterSec: retryAfterSec ?? undefined,
    })
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** POST /auth/login against the dashboard backend. */
export async function login(email: string, password: string): Promise<LoginResponse> {
  if (!API_BASE_URL) {
    throw new HttpError('Dashboard API is not configured (VITE_ADMIN_API_URL is not set).', undefined)
  }
  const res = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    let message = `Login failed (${res.status})`
    try {
      const payload = (await res.json()) as { error?: string }
      message = payload.error ?? message
    } catch {
      // keep default
    }
    throw new HttpError(message, res.status)
  }
  return (await res.json()) as LoginResponse
}

/**
 * `GET /api/v1/admin/metrics` — authoritative Rayern metrics (contract §2.1)
 * served by the dashboard backend from the pull-sync state. The billing block
 * inside `data` is Rayern's; the dashboard never recalculates it.
 */
export async function adminMetrics(signal?: AbortSignal): Promise<AdminMetricResponse> {
  return apiRequest<AdminMetricResponse>('/api/v1/admin/metrics', { signal })
}

/** Builds a querystring from defined params, skipping empty values. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

/** Small helper for paged service responses. */
export function makePaged<T>(items: T[], total: number, page: number, pageSize: number): Paged<T> {
  return { items, total, page, pageSize }
}

export type { ID }
