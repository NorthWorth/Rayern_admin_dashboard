export const VERSION = '0.1.0'

/**
 * Deployed build marker. Bumped with meaningful backend behavior changes so
 * /healthz can prove which code a running instance is executing (Render
 * redeployments, staging drift, etc.). Values only — no secrets.
 */
export const SERVER_VERSION = '2026-10-25.1-revenue-campaigns-proxy-sync'
