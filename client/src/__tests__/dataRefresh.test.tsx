import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The dashboard API base URL must exist before `lib/api` is first evaluated:
 * with no base URL the module short-circuits every request and falls back to
 * demo data, which would hide the real fetch path these tests exercise.
 */
vi.hoisted(() => {
  vi.stubEnv('VITE_ADMIN_API_URL', 'http://dashboard-api.test')
  // jsdom has no ResizeObserver; the Overview chart only needs it to exist.
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
})

import { OverviewPage } from '../pages/Overview'

type Mode = 'ok' | 'rate-limited' | 'unauthorized'

let mode: Mode = 'ok'
/** request count per pathname — the assertions below depend on exact counts. */
let counts = new Map<string, number>()

/**
 * Response look-alike: `apiRequest` only reads ok/status/headers.get/json(),
 * so a plain object keeps the tests independent of a fetch implementation.
 */
function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response
}

/** Payloads carry exactly the fields Overview reads (loosely typed on purpose). */
const PAYLOADS: Record<string, unknown> = {
  '/users/stats': { totalUsers: 10, newUsers7d: 2, verified: 8, unverified: 2, deleted30d: 0 },
  '/workspaces/stats': { total: 5, newWorkspaces30d: 1, avgMembersPerWorkspace: 2, proWorkspaces: 2, teamWorkspaces: 3 },
  '/platform-metrics/overview': {
    registeredAccounts: 10,
    newAccounts30d: 2,
    verifiedAccounts: 8,
    unverifiedAccounts: 2,
    deletedAccounts30d: 0,
    deletionRequestsPending: 0,
    totalWorkspaces: 5,
    registrationsTrend: [{ date: '2026-10-01', count: 3 }],
    planBreakdown: [{ plan: 'pro', count: 2 }],
  },
  '/emails': [
    { id: 'e1', resendId: 'r1', to: ['a@b.c'], cc: [], bcc: [], subject: 'Hello', type: 'update', status: 'delivered', sentAt: '2026-10-22T12:00:00.000Z' },
  ],
  '/emails/stats': { totalSent: 4, delivered: 4, failed: 0, bounced: 0, byType: [], daily: [] },
  '/system/overview': {
    overall: 'healthy',
    services: [],
    requestVolume: [],
    errorRatePct: 0.1,
    requestCount24h: 100,
    latency: { p50: 10, p90: 20, p95: 30, p99: 40 },
    recentFailures: [],
    sync: { enabled: false, status: 'healthy', lastSuccessAt: null, lastAttemptAt: null, consecutiveFailures: 0, stale: false, lastError: null },
  },
}

const SOURCE_PATHS = [
  '/emails',
  '/emails/stats',
  '/platform-metrics/overview',
  '/system/overview',
  '/users/stats',
  '/workspaces/stats',
]

/** Overview links to other routes, so it needs a router context. */
function renderOverview(): void {
  render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  )
}

const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const path = new URL(String(input)).pathname
  counts.set(path, (counts.get(path) ?? 0) + 1)

  if (mode === 'unauthorized') {
    return fakeResponse(401, { success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })
  }
  if (mode === 'rate-limited') {
    return fakeResponse(429, { error: 'Too many requests. Slow down.' }, { 'Retry-After': '45' })
  }
  const body = PAYLOADS[path]
  if (body === undefined) return fakeResponse(404, { error: 'Not found' })
  return fakeResponse(200, body)
})

beforeEach(() => {
  mode = 'ok'
  counts = new Map()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('manual refresh — Overview data view', () => {
  test('Update data sends exactly one request per data source, nothing else', async () => {
    renderOverview()
    await waitFor(() => expect(screen.getByTestId('refresh-status')).toHaveTextContent('Last updated'))

    counts.clear()
    fireEvent.click(screen.getByRole('button', { name: /update data/i }))

    await waitFor(() => expect(screen.getByTestId('refresh-status')).toHaveTextContent('Last updated'))

    expect([...counts.keys()].sort()).toEqual(SOURCE_PATHS)
    for (const [, n] of counts) expect(n).toBe(1)
  })

  test('shows a loading state and blocks duplicate requests while a refresh runs', async () => {
    renderOverview()
    await waitFor(() => expect(screen.getByTestId('refresh-status')).toHaveTextContent('Last updated'))

    counts.clear()
    fireEvent.click(screen.getByRole('button', { name: /update data/i }))

    const updating = screen.getByRole('button', { name: /updating/i })
    expect(updating).toBeDisabled()
    expect(screen.getByTestId('refresh-status')).toHaveTextContent('Loading the latest data…')

    // A second click during the flight must not start another round.
    fireEvent.click(updating)

    await waitFor(() => expect(screen.getByTestId('refresh-status')).toHaveTextContent('Last updated'))
    expect(screen.getByRole('button', { name: /update data/i })).toBeEnabled()
    expect([...counts.keys()].sort()).toEqual(SOURCE_PATHS)
    for (const [, n] of counts) expect(n).toBe(1)
  })

  test('keeps the last successful update time visible after a successful refresh', async () => {
    renderOverview()
    await waitFor(() => expect(screen.getByTestId('refresh-status')).toHaveTextContent('Last updated'))
    const first = screen.getByTestId('refresh-status').textContent

    fireEvent.click(screen.getByRole('button', { name: /update data/i }))
    await waitFor(() => expect(screen.getByTestId('refresh-status')).toHaveTextContent('Last updated'))

    expect(screen.getByTestId('refresh-status').textContent).toMatch(/^Last updated /)
    expect(first).toMatch(/^Last updated /)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('reports HTTP status, server message and error code when the API fails', async () => {
    mode = 'unauthorized'
    renderOverview()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('6 of 6 data sources failed to update')
    expect(alert).toHaveTextContent('HTTP 401 (UNAUTHENTICATED) — Authentication required')
    // No fabricated success time for a failed load.
    expect(screen.getByTestId('refresh-status')).toHaveTextContent('No successful update yet')
  })

  test('dispatches the auth-expired event on 401 so the shell can show login', async () => {
    mode = 'unauthorized'
    const onExpired = vi.fn()
    window.addEventListener('rayern:auth-expired', onExpired)
    renderOverview()
    await waitFor(() => expect(onExpired).toHaveBeenCalled())
    window.removeEventListener('rayern:auth-expired', onExpired)
  })

  test('shows when a 429 retry may be appropriate, from the Retry-After header', async () => {
    mode = 'rate-limited'
    renderOverview()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('HTTP 429')
    expect(alert).toHaveTextContent('Too many requests. Slow down.')
    expect(alert).toHaveTextContent(/another attempt may be appropriate in about 45s \(at [^)]+\)/)
  })
})

describe('duplicate request suppression', () => {
  test('concurrent identical GETs share a single network request', async () => {
    const { apiRequest } = await import('../lib/api')
    const [a, b] = await Promise.all([
      apiRequest<unknown>('/users/stats'),
      apiRequest<unknown>('/users/stats'),
    ])
    expect(a).toEqual(PAYLOADS['/users/stats'])
    expect(b).toEqual(PAYLOADS['/users/stats'])
    expect(counts.get('/users/stats')).toBe(1)
  })

  test('a settled request is not reused — the next call fetches again', async () => {
    const { apiRequest } = await import('../lib/api')
    await apiRequest('/users/stats')
    await apiRequest('/users/stats')
    expect(counts.get('/users/stats')).toBe(2)
  })
})
