import type { ID, Paged } from './types'
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

export class HttpError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
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
 * Single place where the app talks to the dashboard backend.
 * Extend here (auth headers, retries, tracing headers) as the backend matures.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!API_BASE_URL) {
    throw new HttpError('Dashboard API is not configured (VITE_ADMIN_API_URL is not set).', undefined)
  }

  const token = session.token()
  const res = await fetch(`${API_BASE_URL.replace(/\/$/, '')}${path}`, {
    method: options.method ?? 'GET',
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
    try {
      const payload = (await res.json()) as { message?: string; error?: string }
      message = payload.message ?? payload.error ?? message
    } catch {
      // keep default message
    }
    if (res.status === 401) {
      // Token expired or revoked — notify the shell so it shows the login view.
      window.dispatchEvent(new Event(AUTH_EVENT))
    }
    throw new HttpError(message, res.status)
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
