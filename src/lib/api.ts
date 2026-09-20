import type { ID, Paged } from './types'

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

  const res = await fetch(`${API_BASE_URL.replace(/\/$/, '')}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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
    throw new HttpError(message, res.status)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
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
