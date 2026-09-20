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
import { ToastProvider } from './components/ui/Toast'
import { DEMO_MODE } from './lib/api'
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
    <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      Demo data — set <code className="rounded bg-amber-100 px-1 font-mono text-[10px]">VITE_ADMIN_API_URL</code> to connect the backend
    </div>
  )
}

function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900 text-ink-100 md:flex">
      <div className="flex h-14 items-center gap-2.5 border-b border-ink-800 px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10">
          <svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M9 23V9h6.2c2.9 0 4.8 1.7 4.8 4.2 0 1.9-1.1 3.3-2.9 3.9L21 23h-3.4l-3.2-5.4h-2.2V23H9zm3.2-7.9h2.6c1.4 0 2.3-.8 2.3-2s-.9-1.9-2.3-1.9h-2.6v3.9z" fill="#f7f8f9" />
            <circle cx="23.5" cy="9" r="2" fill="#35c08e" />
          </svg>
        </span>
        <div className="leading-tight">
          <p className="text-[13px] font-semibold text-white">Rayern Admin</p>
          <p className="text-[10px] uppercase tracking-widest text-ink-400">Operator console</p>
        </div>
      </div>
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
      <div className="border-t border-ink-800 px-4 py-3">        <p className="text-xs font-medium text-white">Admin</p>
        <p className="text-[11px] text-ink-400">support@rayern.com.ng</p>
      </div>
    </aside>
  )
}

function Topbar() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-ink-200 bg-white px-6">
      <PageTitle />
      <div className="flex items-center gap-3">
        <DemoBanner />
        <span className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Console online
        </span>
      </div>
    </header>
  )
}

function PageTitle() {
  const { pathname } = useLocation()
  const meta = pageTitles[pathname] ?? { title: 'Not found', sub: '' }
  return (
    <div>
      <h1 className="text-sm font-semibold text-ink-900">{meta.title}</h1>
      <p className="text-xs text-ink-500">{meta.sub}</p>
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

export default function App() {
  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 overflow-y-auto scrollbar-thin">
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
    </ToastProvider>
  )
}
