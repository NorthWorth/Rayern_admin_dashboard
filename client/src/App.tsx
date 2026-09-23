import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { OverviewPage } from './pages/Overview'
import { UsersPage } from './pages/Users'
import { WorkspacesPage } from './pages/Workspaces'
import { MetricsPage } from './pages/Metrics'
import { EmailsPage } from './pages/Emails'
import { SystemPage } from './pages/System'
import { ErrorsPage } from './pages/Errors'
import { ObservabilityPage } from './pages/Observability'
import { AuditPage } from './pages/Audit'
import { LoginPage } from './pages/Login'
import { Button } from './components/ui/Button'
import { ToastProvider } from './components/ui/Toast'
import { AUTH_EVENT, DEMO_MODE, session } from './lib/api'
import { clsx } from './lib/utils'

interface NavItem {
  to: string
  label: string
  end?: boolean
  icon: string
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Monitor',
    items: [
      { to: '/', label: 'Overview', end: true, icon: 'grid' },
      { to: '/users', label: 'Users', icon: 'users' },
      { to: '/workspaces', label: 'Workspaces', icon: 'grid-small' },
      { to: '/metrics', label: 'Platform Metrics', icon: 'chart' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/emails', label: 'Send Email', icon: 'mail' },
      { to: '/system', label: 'System', icon: 'activity' },
      { to: '/errors', label: 'Errors', icon: 'warning' },
      { to: '/observability', label: 'Observability', icon: 'telescope' },
      { to: '/audit', label: 'Audit Log', icon: 'list' },
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
      return <svg {...common}><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>
    case 'users':
      return <svg {...common}><circle cx="9" cy="8" r="3.2" /><path d="M4 20c0-3 2.2-4.8 5-4.8s5 1.8 5 4.8" /><path d="M16 11a3 3 0 100-6" /><path d="M17.5 20c0-2.2-.9-3.6-2.5-4.3" /></svg>
    case 'chart':
      return <svg {...common}><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></svg>
    case 'mail':
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
    case 'activity':
      return <svg {...common}><path d="M3 12h4l2.5-7 4 14 2.5-7h5" /></svg>
    case 'warning':
      return <svg {...common}><path d="M12 3L2 20h20L12 3z" /><path d="M12 10v4" /><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none" /></svg>
    case 'telescope':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 2v4" /><path d="M12 18v4" /><path d="M2 12h4" /><path d="M18 12h4" /></svg>
    case 'list':
      return <svg {...common}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" /></svg>
    default:
      return <svg {...common}><circle cx="12" cy="12" r="9" /></svg>
  }
}

const pageTitles: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Overview', sub: 'How is Rayern doing as a platform, and is the infrastructure healthy?' },
  '/users': { title: 'Users', sub: 'Account administration — workspace contents are never accessible' },
  '/workspaces': { title: 'Workspaces', sub: 'Aggregate workspace registrations' },
  '/metrics': { title: 'Platform Metrics', sub: 'Privacy-safe aggregate platform statistics' },
  '/emails': { title: 'Emails', sub: 'Admin-sent email history and composer' },
  '/system': { title: 'System', sub: 'API, infrastructure and service health' },
  '/errors': { title: 'Errors', sub: 'Recent failures across services' },
  '/observability': { title: 'Observability', sub: 'Traces, latency and service performance' },
  '/audit': { title: 'Audit Log', sub: 'Administrative and system events' },
}

function DemoBanner() {
  if (!DEMO_MODE) return null
  return (
    <div className="flex max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
      <span className="truncate">Demo data — set <code className="rounded bg-amber-100 px-1 font-mono text-[10px]">VITE_ADMIN_API_URL</code> to connect the backend</span>
    </div>
  )
}

function SidebarBrand() {
  return (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10">
        <svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M9 23V9h6.2c2.9 0 4.8 1.7 4.8 4.2 0 1.9-1.1 3.3-2.9 3.9L21 23h-3.4l-3.2-5.4h-2.2V23H9zm3.2-7.9h2.6c1.4 0 2.3-.8 2.3-2s-.9-1.9-2.3-1.9h-2.6v3.9z" fill="#f7f8f9" />
          <circle cx="23.5" cy="9" r="2" fill="#35c08e" />
        </svg>
      </span>
      <div className="min-w-0 leading-tight">
        <p className="text-[13px] font-semibold text-white">Rayern Admin</p>
        <p className="text-[10px] uppercase tracking-widest text-ink-400">Operator console</p>
      </div>
    </>
  )
}

/** Nav links + footer shared by the desktop sidebar and the mobile drawer. */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4 scrollbar-thin">
        {NAV.map((group) => (
          <div key={group.section}>
            <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-ink-500">{group.section}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30',
                        isActive ? 'bg-white/10 text-white' : 'text-ink-300 hover:bg-white/5 hover:text-white',
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
      <div className="border-t border-ink-800 px-4 py-3">
        <p className="text-xs font-medium text-white">Admin</p>
        <p className="text-[11px] text-ink-400">support@rayern.com.ng</p>
      </div>
    </>
  )
}

/** Desktop sidebar — visible at the md breakpoint and above. Sticky so it
 *  stays in view while the PAGE scrolls (normal browser scrollbar). */
function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen shrink-0 flex-col border-r border-ink-800 bg-ink-900 text-ink-100 md:flex">
      <div className="flex h-14 items-center gap-2.5 border-b border-ink-800 px-4">
        <SidebarBrand />
      </div>
      <SidebarNav />
    </aside>
  )
}

/**
 * Mobile navigation drawer, rendered below the md sidebar breakpoint.
 * Follows the existing Drawer conventions: Escape closes, backdrop
 * (mousedown on the backdrop itself) closes, body scroll is locked.
 */
function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // If the viewport grows back to the sidebar breakpoint while the drawer
    // is open, hand control back to the desktop sidebar.
    const mq = window.matchMedia('(min-width: 768px)')
    const onViewportChange = (): void => {
      if (mq.matches) onClose()
    }
    mq.addEventListener('change', onViewportChange)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKey)
      mq.removeEventListener('change', onViewportChange)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-ink-900/40 md:hidden"
        aria-hidden="true"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      />
      <aside
        id="mobile-navigation"
        className="fixed inset-y-0 left-0 z-50 flex w-60 max-w-[85vw] flex-col border-r border-ink-800 bg-ink-900 text-ink-100 shadow-2xl md:hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div className="flex h-14 items-center justify-between gap-2.5 border-b border-ink-800 px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <SidebarBrand />
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="shrink-0 rounded-md p-1.5 text-ink-400 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
        <SidebarNav onNavigate={onClose} />
      </aside>
    </>
  )
}

interface TopbarProps {
  onSignOut: () => void
  menuOpen: boolean
  onOpenMenu: () => void
  menuButtonRef: { current: HTMLButtonElement | null }
}

function Topbar({ onSignOut, menuOpen, onOpenMenu, menuButtonRef }: TopbarProps) {
  const operator = session.operator()
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-ink-200 bg-white px-4 sm:px-6">
      <button
        ref={menuButtonRef}
        type="button"
        onClick={onOpenMenu}
        aria-label="Open navigation menu"
        aria-expanded={menuOpen}
        aria-controls="mobile-navigation"
        className="-ml-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-600 hover:bg-ink-100 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-400 md:hidden"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <PageTitle />
      <div className="flex min-w-0 items-center gap-3">
        <DemoBanner />
        <span className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Console online
        </span>
        {operator ? (
          <div className="flex items-center gap-2">
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-xs font-medium text-ink-900">{operator.name}</p>
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

function PageTitle() {
  const { pathname } = useLocation()
  const meta = pageTitles[pathname] ?? { title: 'Not found', sub: '' }
  return (
    <div className="min-w-0 flex-1">
      <h1 className="truncate text-sm font-semibold text-ink-900">{meta.title}</h1>
      <p className="truncate text-xs text-ink-500">{meta.sub}</p>
    </div>
  )
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-3xl font-semibold text-ink-900">404</p>
      <p className="text-sm text-ink-500">This page does not exist in the operator console.</p>
      <Link to="/" className="mt-2 text-sm font-medium text-emerald-700 hover:text-emerald-800">← Back to Overview</Link>
    </div>
  )
}

function AuthedApp() {
  const [authed, setAuthed] = useState(() => session.token() !== null)

  useEffect(() => {
    const onAuthExpired = () => setAuthed(false)
    window.addEventListener(AUTH_EVENT, onAuthExpired)
    return () => window.removeEventListener(AUTH_EVENT, onAuthExpired)
  }, [])

  if (!authed) {
    return <LoginPage onSuccess={() => setAuthed(true)} />
  }

  return (
    <Shell
      onSignOut={() => {
        session.clear()
        setAuthed(false)
      }}
    />
  )
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const wasOpenRef = useRef(false)
  const { pathname } = useLocation()

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [])

  // Return keyboard focus to the hamburger once the drawer closes.
  useEffect(() => {
    if (wasOpenRef.current && !mobileNavOpen) menuButtonRef.current?.focus()
    wasOpenRef.current = mobileNavOpen
  }, [mobileNavOpen])

  // The app now uses the ONE normal page-level scroll (the browser's own), so
  // navigating to a new route starts at the top like a regular website.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  return (
    // min-h-screen (NOT h-screen + overflow-hidden): the document scrolls
    // normally with a single browser scrollbar — there is no nested
    // application scroll container around <main> anymore.
    <div className="flex min-h-screen">
      <Sidebar />
      <MobileSidebar open={mobileNavOpen} onClose={closeMobileNav} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onSignOut={onSignOut}
          menuOpen={mobileNavOpen}
          onOpenMenu={() => setMobileNavOpen(true)}
          menuButtonRef={menuButtonRef}
        />
        <main className="flex-1 min-w-0">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/workspaces" element={<WorkspacesPage />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="/emails" element={<EmailsPage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/errors" element={<ErrorsPage />} />
            <Route path="/observability" element={<ObservabilityPage />} />
            <Route path="/audit" element={<AuditPage />} />
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
      <AuthedApp />
    </ToastProvider>
  )
}
