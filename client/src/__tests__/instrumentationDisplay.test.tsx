import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

/**
 * The charts used by these pages need a ResizeObserver, which jsdom lacks —
 * the same stub the refresh suite uses.
 */
vi.hoisted(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
})

vi.mock('../services/rayern', () => ({
  rayernService: {
    blocks: vi.fn(),
    logs: vi.fn(),
    syntheticMonitoring: vi.fn(),
  },
}))

vi.mock('../services/system', () => ({
  systemService: { overview: vi.fn() },
}))

vi.mock('../services/emails', () => ({
  emailsService: { list: vi.fn(), stats: vi.fn(), send: vi.fn() },
}))

import { rayernService } from '../services/rayern'
import { systemService } from '../services/system'
import { emailsService } from '../services/emails'
import { SystemPage } from '../pages/System'
import { EmailsPage } from '../pages/Emails'
import { RefreshProvider } from '../hooks/usePageRefresh'
import { ToastProvider } from '../components/ui/Toast'
import type { InstrumentationResponse, SyntheticResponse } from '../lib/types'

const NO_BLOCKS: InstrumentationResponse = {
  blocks: {
    funnel: null,
    clientErrors: null,
    endpointHealth: null,
    dependencyConfig: null,
    syntheticMonitoring: null,
    productAdoption: null,
    marketingConsent: null,
    engagement: null,
  },
  syncedAt: '2026-10-28T06:00:00.000Z',
  received: [],
}

const SYSTEM_OVERVIEW = {
  overall: 'healthy',
  services: [],
  requestVolume: [],
  errorRatePct: 0,
  requestCount24h: 10,
  latency: { p50: 10, p90: 20, p95: 30, p99: 40 },
  recentFailures: [],
  sync: {
    enabled: false,
    status: 'healthy',
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    stale: false,
    running: false,
  },
}

function blocksWith(partial: Partial<InstrumentationResponse['blocks']>): InstrumentationResponse {
  return { ...NO_BLOCKS, blocks: { ...NO_BLOCKS.blocks, ...partial } }
}

function renderPage(ui: ReactNode): void {
  render(
    <RefreshProvider>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </RefreshProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(systemService.overview).mockResolvedValue(SYSTEM_OVERVIEW as never)
  vi.mocked(emailsService.list).mockResolvedValue([])
  vi.mocked(emailsService.stats).mockResolvedValue({
    totalSent: 0,
    delivered: 0,
    failed: 0,
    bounced: 0,
    byType: [],
    daily: [],
  } as never)
  vi.mocked(rayernService.blocks).mockResolvedValue(NO_BLOCKS)
  vi.mocked(rayernService.syntheticMonitoring).mockResolvedValue({
    synthetic: {
      available: false,
      reason: 'no_checks_run',
      lastCheckedAt: null,
      lastSuccessfulCheckAt: null,
      checks: [],
    },
    meta: {
      source: '/internal/synthetic-monitoring',
      requestId: null,
      fetchedAt: '2026-10-28T06:00:00.000Z',
      durable: false,
      note: 'Produced by an external scheduler.',
    },
  } as SyntheticResponse)
})

describe('System — Rayern dependency configuration', () => {
  test('renders presence flags without ever exposing values', async () => {
    vi.mocked(rayernService.blocks).mockResolvedValue(
      blocksWith({
        dependencyConfig: {
          available: true,
          items: [
            { group: 'Email', name: 'Resend', label: 'Resend configured', configured: true, detail: null },
            { group: 'Email', name: 'EmailJS', label: 'EmailJS configured', configured: false, detail: null },
            { group: 'Billing', name: 'Paystack', label: 'Paystack configured', configured: true, detail: 'NGN' },
            { group: 'Waitlist', name: 'Proxy', label: 'Waitlist proxy configured', configured: null, detail: null },
          ],
        },
      }),
    )

    renderPage(<SystemPage />)

    await waitFor(() => expect(screen.getByText('Resend configured')).toBeInTheDocument())

    expect(screen.getByText('Resend configured').closest('li')).toHaveTextContent('Configured')
    expect(screen.getByText('EmailJS configured').closest('li')).toHaveTextContent('Not configured')
    // An unreported flag is "Unknown", not "Not configured".
    expect(screen.getByText('Waitlist proxy configured').closest('li')).toHaveTextContent('Unknown')
    // Non-secret adjacent metadata is shown…
    expect(screen.getByText(/NGN/)).toBeInTheDocument()
    // …and the panel states presence is not health.
    expect(screen.getByText(/does not prove the integration is reachable/)).toBeInTheDocument()
  })

  test('explains a never-synchronized payload instead of showing an empty table', async () => {
    renderPage(<SystemPage />)

    await waitFor(() => expect(screen.getByText('Dependency configuration not reported')).toBeInTheDocument())
    expect(screen.getByText(/No instrumentation payload has been synchronized yet/)).toBeInTheDocument()
  })
})

describe('System — synthetic monitoring', () => {
  test('"no checks run" is unavailable, never healthy', async () => {
    renderPage(<SystemPage />)

    await waitFor(() => expect(screen.getByText('No synthetic checks recorded')).toBeInTheDocument())
    expect(screen.getByText(/Missing checks are not treated as healthy/)).toBeInTheDocument()
    expect(screen.getByText(/Schedule scripts\/synthetic-monitor\.mjs/)).toBeInTheDocument()
    // No fabricated check rows.
    expect(screen.queryByText('Up')).not.toBeInTheDocument()
  })

  test('shows real check results with status, HTTP code and history context', async () => {
    vi.mocked(rayernService.syntheticMonitoring).mockResolvedValue({
      synthetic: {
        available: true,
        reason: null,
        lastCheckedAt: '2026-10-28T06:00:00.000Z',
        lastSuccessfulCheckAt: '2026-10-28T06:00:00.000Z',
        checks: [
          {
            name: 'api_health',
            status: 'up',
            httpStatus: 200,
            latencyMs: 91,
            p95Ms: 140,
            reason: null,
            consecutiveFailures: 0,
            lastSuccessAt: '2026-10-28T06:00:00.000Z',
            lastFailureAt: null,
            lastRecoveredAt: null,
            history: [],
          },
          {
            name: 'internal_metrics_fails_closed',
            status: 'down',
            httpStatus: 500,
            latencyMs: 1200,
            p95Ms: null,
            reason: 'unexpected_status',
            consecutiveFailures: 3,
            lastSuccessAt: '2026-10-27T06:00:00.000Z',
            lastFailureAt: '2026-10-28T06:00:00.000Z',
            lastRecoveredAt: null,
            history: [],
          },
        ],
      },
      meta: {
        source: '/internal/synthetic-monitoring',
        requestId: null,
        fetchedAt: '2026-10-28T06:01:00.000Z',
        durable: false,
        note: 'Produced by an external scheduler.',
      },
    } as SyntheticResponse)

    renderPage(<SystemPage />)

    await waitFor(() => expect(screen.getByText('api_health')).toBeInTheDocument())

    const upRow = screen.getByText('api_health').closest('li')
    expect(upRow).toHaveTextContent('Up')
    expect(upRow).toHaveTextContent('HTTP 200')

    const downRow = screen.getByText('internal_metrics_fails_closed').closest('li')
    expect(downRow).toHaveTextContent('Down')
    expect(downRow).toHaveTextContent('3× in a row')

    // The dashboard never claims uptime it cannot prove.
    expect(screen.getByText(/no historical\s+uptime percentage is claimed/)).toBeInTheDocument()
  })
})

describe('Emails — marketing consent (Rayern)', () => {
  test('shows reported figures and flags inconsistencies without correcting them', async () => {
    vi.mocked(rayernService.blocks).mockResolvedValue(
      blocksWith({
        marketingConsent: {
          totalRegisteredUsers: 10,
          optedIn: 6,
          optedOut: 3,
          optedInPct: 60,
          reconciles: false,
        },
      }),
    )

    renderPage(<EmailsPage />)

    await waitFor(() => expect(screen.getByText('Marketing consent (Rayern)')).toBeInTheDocument())

    expect(screen.getByText('Opted in').nextElementSibling).toHaveTextContent('6')
    expect(screen.getByText('Opted out').nextElementSibling).toHaveTextContent('3')
    expect(screen.getByText('Registered users').nextElementSibling).toHaveTextContent('10')

    // The mismatch is surfaced, the numbers are untouched.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Inconsistent report')
    expect(alert).toHaveTextContent('shown exactly as Rayern reported them')
  })

  test('keeps consent distinct from verification and states the backend revalidates', async () => {
    vi.mocked(rayernService.blocks).mockResolvedValue(
      blocksWith({
        marketingConsent: { totalRegisteredUsers: 10, optedIn: 6, optedOut: 4, optedInPct: 60, reconciles: true },
      }),
    )

    renderPage(<EmailsPage />)

    await waitFor(() => expect(screen.getByText('Opt-in share')).toBeInTheDocument())
    expect(screen.getByText('60.0%')).toBeInTheDocument()
    expect(screen.getByText(/separate from registration and email verification/)).toBeInTheDocument()
    expect(screen.getByText(/revalidates consent on its own backend when a campaign is sent/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('an unsynchronized consent block renders an unavailable state, not zeros', async () => {
    renderPage(<EmailsPage />)

    await waitFor(() => expect(screen.getByText('Marketing consent not reported')).toBeInTheDocument())
    expect(screen.queryByText('Opted in')).not.toBeInTheDocument()
  })
})
