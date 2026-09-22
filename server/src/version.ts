/**
 * Deployed build marker. Bumped with meaningful backend behavior changes so
 * /healthz can prove which code a running instance is executing (Render
 * redeployments, staging drift, etc.). Values only — no secrets.
 */
export const SERVER_VERSION = '2026-09-22.1-synced-aggregates'
