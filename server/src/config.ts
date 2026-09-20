/**
 * Backend configuration — reads only from environment variables.
 * No secrets are ever hardcoded; .env is gitignored.
 */
function required(name: string, fallbackIfOptional = false): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    if (fallbackIfOptional) return ''
    throw new Error(`Missing required env var: ${name}`)
  }
  return value.trim()
}

function optionalWithDevFallback(name: string, label: string): string {
  const value = process.env[name]?.trim() ?? ''
  if (value) return value
  // Dev convenience: ephemeral in-memory secret so local/dev runs work without
  // configuration. Production MUST set these via env — see server/env.example.
  const generated = `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  console.warn(`[dashboard-api] WARNING: ${name} is not set — using an ephemeral ${label}. Set it in production.`)
  return generated
}

export const config = {
  // API_PORT keeps the dashboard API on its own port even where the platform
  // injects PORT for the frontend dev server (they run side by side in dev).
  port: Number(process.env.API_PORT ?? process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL', true),
  jwtSecret: optionalWithDevFallback('ADMIN_JWT_SECRET', 'ephemeral JWT secret'),
  syncApiKey: optionalWithDevFallback('SYNC_API_KEY', 'ephemeral sync key'),
  // In production, restrict to exact origins. In dev, allow all — the API
  // uses bearer tokens (not cookies) so CORS is defense-in-depth only.
  corsOrigins:
    process.env.NODE_ENV === 'production'
      ? (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      : [], // empty = allow all origins
  bootstrap: {
    email: process.env.ADMIN_EMAIL?.trim() || '',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME?.trim() || 'Administrator',
  },
  resendApiKey: required('RESEND_API_KEY', true),
  emailFrom: {
    name: process.env.EMAIL_FROM_NAME?.trim() || 'Rayern',
    address: process.env.EMAIL_FROM_ADDRESS?.trim() || 'support@rayern.com.ng',
  },
  registrationTrendDays: Number(process.env.REGISTRATION_TREND_DAYS ?? 90),
  /** Serve the compiled dashboard frontend from ../dist (single-origin deploys). */
  serveStatic: (process.env.SERVE_STATIC ?? 'false') === 'true',
  /** Dev/test only: validate + record emails without calling Resend. */
  emailDryRun: (process.env.EMAIL_DRY_RUN ?? '') === '1',
}
