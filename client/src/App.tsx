import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { OverviewPage } from './pages/Overview'
import { UsersPage } from './pages/Users'
import { WorkspacesPage } from './pages/Workspaces'
import { MetricsPage } from './pages/Metrics'
import { RevenuePage } from './pages/Revenue'
import { EmailsPage } from './pages/Emails'
import { SystemPage } from './pages/System'
import { ErrorsPage } from './pages/Errors'
import { ObservabilityPage } from './pages/Observability'
import { AuditPage } from './pages/Audit'
import { AcquisitionPage } from './pages/Acquisition'
import { FunnelsPage } from './pages/Funnels'
import { RetentionPage } from './pages/Retention'
import { AdoptionPage } from './pages/Adoption'
import { ActivityPage } from './pages/Activity'
import { FeedbackPage } from './pages/Feedback'
import { ReportsPage } from './pages/Reports'
import { SettingsPage } from './pages/Settings'
import { LoginPage } from './pages/Login'
import { Button } from './components/ui/Button'
import { ToastProvider } from './components/ui/Toast'
import { RefreshControl } from './components/RefreshControl'
import { RefreshProvider } from './hooks/usePageRefresh'
import { AUTH_EVENT, DEMO_MODE, session } from './lib/api'
import { clsx } from './lib/utils'

interface NavItem {
  to: string
  label: string
  end?: boolean
  icon: string
}

/**
 * Primary navigation. Existing routes are reused wherever they already serve
 * the purpose; new pages are added alongside them, never as duplicates.
 */
const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Snapshot',
    items: [
      { to: '/', label: 'Overview', end: true, icon: 'grid' },
      { to: '/reports', label: 'Reports', icon: 'file' },
    ],
  },
  {
    section: 'Growth & product',
    items: [
      { to: '/acquisition', label: 'Acquisition', icon: 'trend' },
      { to: '/funnels', label: 'Funnels', icon: 'funnel' },
      { to: '/retention', label: 'Retention', icon: 'loop' },
      { to: '/adoption', label: 'Product adoption', icon: 'blocks' },
      { to: '/users', label: 'Users', icon: 'users' },
      { to: '/workspaces', label: 'Workspaces', icon: 'grid-small' },
    ],
  },
  {
    section: 'Monetisation',
    items: [
      { to: '/revenue', label: 'Revenue', icon: 'revenue' },
      { to: '/emails', label: 'Email', icon: 'mail' },
      { to: '/metrics', label: 'Platform metrics', icon: 'chart' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/activity', label: 'Activity', icon: 'activity' },
      { to: '/feedback', label: 'Feedback', icon: 'chat' },
      { to: '/system', label: 'System', icon: 'pulse' },
      { to: '/errors', label: 'Errors', icon: 'warning' },
      { to: '/observability', label: 'Observability', icon: 'telescope' },
      { to: '/audit', label: 'Audit log', icon: 'list' },
      { to: '/settings', label: 'Settings', icon: 'gear' },
    ],
  },
]

function NavIcon({ name }: { name: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'grid':
      return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
    case 'grid-small':
      return <svg {...common}><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="5" rx="1" /><rect x="13" y="10" width="8" height="11" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /></svg>
    case 'users':
      return <svg {...common}><circle cx="9" cy="8" r="3.2" /><path d="M4 20a5 5 0 0 1 10 0" /><path d="M16 5.5a3 3 0 0 1 0 5.8" /><path d="M17.5 20a5 5 0 0 0-2-3.9" /></svg>
    case 'chart':
      return <svg {...common}><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></svg>
    case 'mail':
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" /></svg>
    case 'activity':
      return <svg {...common}><path d="M3 12h4l2.5-7 4 14 2.5-7h5" /></svg>
    case 'pulse':
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 14l2.5-3 2 2L14 9l3 5" /></svg>
    case 'warning':
      return <svg {...common}><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4" /><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" /></svg>
    case 'telescope':
      return <svg {...common}><circle cx="18" cy="6" r="2" /><path d="M12 2v4" /><path d="M18 12v4" /><path d="M4 18l5-5" /><path d="m9 13 7-7" /></svg>
    case 'list':
      return <svg {...common}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" /></svg>
    case 'revenue':
      return <svg {...common}><path d="M12 2v20" /><path d="M16.5 7.5c-1-1.2-2.5-1.8-4.5-1.8-2.4 0-4 1.1-4 3 0 4.5 9 2.5 9 7 0 1.9-1.7 3.3-4.5 3.3-2.2 0-4-.7-5-2" /></svg>
    case 'trend':
      return <svg {...common}><path d="M3 17l5.5-5.5 3.5 3.5L21 6" /><path d="M15 6h6v6" /></svg>
    case 'funnel':
      return <svg {...common}><path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" /></svg>
    case 'loop':
      return <svg {...common}><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v4.5h-4.5" /></svg>
    case 'blocks':
      return <svg {...common}><rect x="3" y="3" width="7.5" height="7.5" rx="1" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1" /><path d="M13.5 17.25h7.5" /><path d="M17.25 13.5v7.5" /></svg>
    case 'chat':
      return <svg {...common}><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 1 1 21 12z" /><path d="M8.5 10.5h7" /><path d="M8.5 14h4" /></svg>
    case 'file':
      return <svg {...common}><path d="M6 2h8l5 5v15H6z" /><path d="M14 2v5h5" /><path d="M9.5 13h6" /><path d="M9.5 17h6" /></svg>
    case 'gear':
      return <svg {...common}><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" /></svg>
    default:
      return <svg {...common}><circle cx="12" cy="12" r="9" /></svg>
  }
}

const pageTitles: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Overview', sub: 'Founder snapshot — growth, monetisation and operational health' },
  '/acquisition': { title: 'Acquisition', sub: 'Registrations over time and where growth comes from' },
  '/funnels': { title: 'Funnels', sub: 'Visitor to paid, stage by stage' },
  '/retention': { title: 'Retention & engagement', sub: 'Returning usage and cohort durability' },
  '/adoption': { title: 'Product adoption', sub: 'Which modules workspaces actually use' },
  '/users': { title: 'Users', sub: 'Account administration — workspace contents are never accessible' },
  '/workspaces': { title: 'Workspaces', sub: 'Aggregate workspace registrations' },
  '/metrics': { title: 'Platform metrics', sub: 'Privacy-safe aggregate platform statistics' },
  '/revenue': { title: 'Revenue', sub: 'MRR, ARR and subscription metrics reported by Rayern' },
  '/emails': { title: 'Email', sub: 'Composer, consent-gated campaigns and recipient selection' },
  '/activity': { title: 'Activity', sub: 'Administrative and system events over time' },
  '/feedback': { title: 'Feedback', sub: 'Customer feedback and feature requests' },
  '/system': { title: 'System', sub: 'API, infrastructure and service health' },
  '/errors': { title: 'Errors', sub: 'Recent failures across services' },
  '/observability': { title: 'Observability', sub: 'Traces, latency and service performance' },
  '/audit': { title: 'Audit log', sub: 'Administrative and system events' },
  '/reports': { title: 'Reports', sub: 'Period comparisons, cohorts and exports' },
  '/settings': { title: 'Settings', sub: 'Dashboard configuration and data sources' },
}

function BrandMark() {
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10">
      <svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
        <path
          d="M9 23V9h6.2c2.9 0 4.8 1.7 4.8 4.2 0 1.9-1.1 3.3-2.9 3.9L21 23h-3.4l-3.2-5.4h-2.2V23H9zm3.2-7.9h2.6c1.4 0 2.3-.8 2.3-2s-.9-1.9-2.3-1.9h-2.6v3.9z"
          fill="#F7F4EE"
        />
        <circle cx="23.5" cy="9" r="2" fill="#B69A67" />
      </svg>
    </span>
  )
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4 scrollbar-thin" aria-label="Primary">
      {NAV.map((group) => (
        <div key={group.section}>
          <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
            {group.section}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
                      isActive
                        ? 'bg-white/10 text-white'
                        : 'text-ink-300 hover:bg-white/5 hover:text-white',
                    )
                  }
                >
                  <NavIcon name={item.icon} />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function SidebarFooter() {
  const operator = session.operator()
  return (
    <div className="border-t border-white/10 px-4 py-3">
      <p className="text-xs font-medium text-white">{operator?.name ?? 'Admin'}</p>
      <p className="text-[11px] text-ink-400">{operator?.email ?? 'support@rayern.com.ng'}</p>
    </div>
  )
}

function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-black/20 bg-ink-900 text-ink-100 md:flex">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/10 px-4">
        <BrandMark />
        <div className="leading-tight">
          <p className="text-[13px] font-semibold text-white">Rayern</p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-champagne-400">Founder dashboard</p>
        </div>
      </div>
      <NavList />
      <SidebarFooter />
    </aside>
  )
}

/**
 * Mobile/tablet navigation drawer. Overlay only — it never shrinks the
 * content column, and closing it leaves the page state untouched.
 */
function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pathname } = useLocation()

  // Any navigation closes the drawer.
  useEffect(() => {
    if (open) onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
      <div className="absolute inset-0 bg-ink-950/40" onClick={onClose} aria-hidden="true" />
      <div className="absolute left-0 top-0 flex h-full w-64 flex-col bg-ink-900 text-ink-100 shadow-popover">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <div className="leading-tight">
              <p className="text-[13px] font-semibold text-white">Rayern</p>
              <p className="text-[10px] uppercase tracking-[0.16em] text-champagne-400">Founder dashboard</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-md p-1.5 text-ink-300 hover:bg-white/10 hover:text-white"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <NavList onNavigate={onClose} />
        <SidebarFooter />
      </div>
    </div>
  )
}

function DemoBanner() {
  if (!DEMO_MODE) return null
  return (
    /* Hidden below lg: its unbreakable code chip keeps the topbar's right
     * cluster from shrinking, which clipped the Sign out button on narrow
     * viewports (the badge is demo-only chrome; production never renders it). */
    <div className="hidden items-center gap-2 rounded-md border border-champagne-200 bg-champagne-50 px-2.5 py-1 text-[11px] text-champagne-800 lg:flex">
      <span className="h-1.5 w-1.5 rounded-full bg-champagne-500" aria-hidden="true" />
      Demo data — set <code className="rounded bg-champagne-100 px-1 font-mono text-[10px]">VITE_ADMIN_API_URL</code> to connect the backend
    </div>
  )
}

function PageTitle() {
  const { pathname } = useLocation()
  const meta = pageTitles[pathname] ?? { title: 'Not found', sub: '' }
  return (
    <div className="min-w-0">
      <h1 className="truncate text-sm font-semibold text-ink-900">{meta.title}</h1>
      <p className="hidden truncate text-xs text-ink-500 sm:block">{meta.sub}</p>
    </div>
  )
}

/**
 * Shared navbar: page context, the global manual refresh control (present on
 * every route) and the existing account controls.
 */
function Navbar({ onSignOut, onOpenMenu }: { onSignOut: () => void; onOpenMenu: () => void }) {
  const operator = session.operator()
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-200 bg-white px-4 sm:px-6">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open navigation menu"
        aria-haspopup="dialog"
        className="rounded-md border border-ink-200 p-1.5 text-ink-700 hover:bg-ink-100 md:hidden"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      <PageTitle />

      <div className="ml-auto flex items-center gap-2.5">
        <DemoBanner />
        <RefreshControl />
        <span className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 xl:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Console online
        </span>
        {operator ? (
          <div className="flex items-center gap-2">
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-xs font-medium text-ink-800">{operator.name}</p>
              <p className="text-[10px] text-ink-500">{operator.email}</p>
            </div>
            <Button variant="ghost" onClick={onSignOut} className="text-xs">
              Sign out
            </Button>
          </div>
        ) : null}
      </div>
    </header>
  )
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="font-display text-4xl text-ink-900">404</p>
      <p className="text-sm text-ink-500">This page does not exist in the founder dashboard.</p>
      <Link to="/" className="text-sm font-medium text-champagne-700 hover:text-champagne-800">
        ← Back to Overview
      </Link>
    </div>
  )
}

function AuthedApp() {
  const [authed, setAuthed] = useState(() => DEMO_MODE || session.token() !== null)
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    const onAuthExpired = () => {
      setAuthed(false)
      setSessionExpired(true)
    }
    window.addEventListener(AUTH_EVENT, onAuthExpired)
    return () => window.removeEventListener(AUTH_EVENT, onAuthExpired)
  }, [])

  if (!authed) {
    return (
      <LoginPage
        expired={sessionExpired}
        onSuccess={() => {
          setSessionExpired(false)
          setAuthed(true)
        }}
      />
    )
  }

  return (
    <Shell
      onSignOut={() => {
        session.clear()
        // Demo mode has no session to end — stay on the console.
        setAuthed(DEMO_MODE)
      }}
    />
  )
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  return (
    <div className="flex h-screen overflow-hidden bg-ivory-100">
      <Sidebar />
      <MobileDrawer open={menuOpen} onClose={closeMenu} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar onSignOut={onSignOut} onOpenMenu={() => setMenuOpen(true)} />
        {/* Single page-level scroll container — nothing else scrolls. */}
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/acquisition" element={<AcquisitionPage />} />
            <Route path="/funnels" element={<FunnelsPage />} />
            <Route path="/retention" element={<RetentionPage />} />
            <Route path="/adoption" element={<AdoptionPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/workspaces" element={<WorkspacesPage />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="/revenue" element={<RevenuePage />} />
            <Route path="/emails" element={<EmailsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/feedback" element={<FeedbackPage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/errors" element={<ErrorsPage />} />
            <Route path="/observability" element={<ObservabilityPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/404" element={<NotFound />} />
            <Route path="*" element={<Navigate to="/404" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <RefreshProvider>
        <AuthedApp />
      </RefreshProvider>
    </ToastProvider>
  )
}
