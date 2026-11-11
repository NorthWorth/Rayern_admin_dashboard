/**
 * Rayern Admin Dashboard backend — entrypoint.
 *
 * Completely separate from the Rayern application. Serves the dashboard API
 * and (in production) the compiled dashboard frontend from /dist.
 *
 * Data flow with Rayern (never bidirectional):
 *  - Aggregates (accounts/workspaces/billing) arrive via the dashboard-side
 *    pull-sync worker (rayernSync.ts), which outbound-GETs the configured
 *    Rayern endpoint with the monitoring token. Rayern never calls this API.
 *  - The browser never talks to Rayern directly: `/api/v1/admin/users` and
 *    `/api/v1/admin/campaigns/*` are proxied server-side to Rayern
 *    (routes/rayernAdmin.ts) with the configured Rayern admin service
 *    account; consent and authorization are still enforced by Rayern.
 */
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { config } from './config'
import { SERVER_VERSION } from './version'
import { initDb, pool, isDbReady, setDbReady, startEmbeddedDbIfConfigured } from './db'
import { authenticate, requireAdmin, rateLimit } from './auth'
import { recordAudit } from './audit'

import authRoutes from './routes/auth'
import usersRoutes from './routes/users'
import workspacesRoutes from './routes/workspaces'
import platformMetricsRoutes from './routes/platformMetrics'
import emailsRoutes from './routes/emails'
import systemRoutes from './routes/system'
import errorsRoutes from './routes/errors'
import observabilityRoutes from './routes/observability'
import auditRoutes from './routes/audit'
import marketingRoutes from './routes/marketing'
import rayernAdminRoutes from './routes/rayernAdmin'
import rayernInternalRoutes from './routes/rayernInternal'
import { metricsRouter } from './routes/metrics'
import { startSyncWorker } from './rayernSync'
import { initTelemetry, telemetryMiddleware } from './telemetry'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// OpenTelemetry + local telemetry pipeline: optional, env-configured, and
// fail-safe (a telemetry problem can never stop the API from starting).
// Must initialize before the first database query so the pg patch is active.
initTelemetry()

const app = express()
app.set('trust proxy', 1)
app.disable('x-powered-by')

// First middleware: spans every request (incl. preflight/static/404/401) and
// provides the parent context for downstream DB and internal spans.
app.use(telemetryMiddleware)

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
)

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin / curl / health checks
      if (!origin) return callback(null, true)
      // Explicit allow-list wins when configured (production). Never '*': the
      // browser calls this API with credentials: 'include', so a wildcard
      // origin is invalid and would be rejected by browsers anyway.
      if (config.corsOrigins.length > 0 && config.corsOrigins.includes(origin)) {
        return callback(null, true)
      }
      // Dev / preview mode: when no explicit allow-list is configured, allow all origins.
      // Safe because the API uses bearer tokens (not cookies) — CORS is defense-in-depth only.
      if (config.corsOrigins.length === 0) return callback(null, true)
      return callback(new Error('Not allowed by CORS'))
    },
    // The dashboard frontend sends credentials: 'include', so credentialed
    // CORS must be enabled and paired with the explicit origin allow-list.
    credentials: true,
    // Only what the dashboard API actually uses (see client/src/lib/api.ts).
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Accept', 'Authorization', 'Content-Type'],
    // Make the rate-limiter's Retry-After readable from the browser so the
    // dashboard can show when a 429'd request may be retried (cross-origin
    // headers are otherwise opaque to JavaScript).
    exposedHeaders: ['Retry-After'],
    maxAge: 86_400,
  }),
)

app.use(express.json({ limit: '1mb' }))
app.use(rateLimit({ windowMs: 60_000, max: 300, key: 'global' }))

/* --------------------------------- Routes --------------------------------- */

app.get('/healthz', async (_req, res) => {
  let db = false
  try {
    await pool.query('SELECT 1')
    db = true
  } catch {
    db = false
  }
  res.json({ ok: true, db, version: SERVER_VERSION, uptimeSec: Math.floor(process.uptime()) })
})

// Parses/verifies the admin JWT when present. Never rejects on its own — the
// route guards below answer 401/403.
app.use(authenticate)

app.use('/auth', authRoutes)

// Metrics contract endpoints. The router carries its own guards per route:
//   GET /api/v1/admin/metrics         → requireAuth + requireAdmin (session)
//   GET /internal/dashboard-metrics   → requireMonitoringToken (service token)
// Both are mounted at root; the session route embeds its full contract path.
app.use(metricsRouter)

// Rayern admin API proxy (contract §4/§5) — verbatim pass-through, server-side
// credentials only. Consent revalidation happens on Rayern's side.
app.use('/api/v1', rayernAdminRoutes)

// All data routes require an authenticated dashboard admin.
app.use('/users', requireAdmin, usersRoutes)
app.use('/workspaces', requireAdmin, workspacesRoutes)
app.use('/platform-metrics', requireAdmin, platformMetricsRoutes)
app.use('/emails', requireAdmin, emailsRoutes)
app.use('/system', requireAdmin, systemRoutes)
app.use('/errors', requireAdmin, errorsRoutes)
app.use('/observability', requireAdmin, observabilityRoutes)
app.use('/audit', requireAdmin, auditRoutes)
// Marketing (consent-gated campaign metrics/directory of the dashboard's own
// accounts) — same root-mounted, no-prefix convention as every other group.
app.use('/marketing', requireAdmin, marketingRoutes)
// Rayern instrumentation & monitoring (dashboard-side view of the synced metric
// blocks, plus server-to-server access to Rayern's monitoring-token endpoints).
// Admin-only; the monitoring token never reaches the browser.
app.use('/rayern', requireAdmin, rayernInternalRoutes)

/* ------------------------------ Static SPA -------------------------------- */

const distDir = path.resolve(__dirname, '../..', 'dist')
if (config.serveStatic) {
  app.use(express.static(distDir))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/auth') || req.path === '/healthz') {
      next()
      return
    }
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

/* ------------------------------- Errors ----------------------------------- */

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof Error && err.message === 'Not allowed by CORS') {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload too large' })
    return
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }
  console.error('[dashboard-api] unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

/* ------------------------------ Bootstrap --------------------------------- */

async function bootstrapAdmin(): Promise<void> {
  if (!config.bootstrap.email || !config.bootstrap.password) return
  const email = config.bootstrap.email.toLowerCase()
  const existing = await pool.query('SELECT id FROM admin_users WHERE email = $1', [email])
  if (existing.rows.length > 0) return
  const hash = await bcrypt.hash(config.bootstrap.password, 12)
  await pool.query('INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)', [
    config.bootstrap.name,
    email,
    hash,
    'admin',
  ])
  await recordAudit(config.bootstrap.email, 'system', 'admin.created', config.bootstrap.email, {})
  console.log(`[dashboard-api] bootstrap admin created: ${email}`)
}

async function start(): Promise<void> {
  try {
    await startEmbeddedDbIfConfigured()
    await initDb()
    setDbReady(true)
    await bootstrapAdmin()
  } catch (err) {
    setDbReady(false)
    console.error('[dashboard-api] database init failed — running in degraded mode:', err)
  }

  app.listen(config.port, () => {
    console.log(`[dashboard-api] listening on port ${config.port} (db: ${isDbReady() ? 'ready' : 'degraded'})`)
  })

  // Dashboard-side background worker that pulls approved aggregates from the
  // Rayern API. Rayern never pushes, never waits, and never depends on us.
  if (isDbReady()) startSyncWorker()
}

void start()

export default app
