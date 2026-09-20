# Rayern Admin Dashboard

A standalone internal administration and observability console for Rayern. This is **not** the Rayern product — it is a separate operator frontend that communicates exclusively with its own dedicated dashboard API.

## Architecture

```
Rayern App → Rayern API → (aggregate/operational data only) → Dashboard API → Dashboard frontend
                                                                  ↓
                                                               Resend
```

- The frontend never connects to Rayern's database, Rayern's server internals, or Resend directly.
- Rayern exposes only aggregate/operational information to the dashboard backend.
- Email sending is admin-initiated only. Verification and password-reset emails remain part of Rayern's own application flow and are never sent from this console.
- The backend uses its own PostgreSQL database (or an embedded PGlite dev database when no DATABASE_URL is configured).

## Privacy model

This dashboard answers **"How is Rayern doing as a platform, and is the infrastructure healthy?"**

It intentionally does **not** answer "What is this particular customer doing inside their workspace?"

- No pages, tables, routes, or API calls expose individual customer data: no clients, leads, projects, tasks, deliverables, reviews, documents, meetings, or follow-ups.
- No customer activity timelines, per-workspace activity, per-customer funnels, or behavioral analytics.
- User records are administrative only (identifier, name, email, verification, account status, registration date) with no drill-down into workspace content.
- Workspace records are registration metadata only (name, member count, plan, creation date).
- **Platform Metrics** is aggregate-only: total accounts, new registrations, verified/unverified counts, deletions, workspace totals and plan breakdown. There are no drill-downs that could reveal private customer or workspace information.

## Getting started

### Frontend

```bash
bun install
bun run dev          # start Vite dev server (http://localhost:5173)
bun run typecheck    # typecheck only
bun run build        # typecheck + production build to dist/
```

### Backend

```bash
cd server
bun install
cp env.example .env  # edit with your values
bun run dev          # start API server on API_PORT (default 4000)
bun run typecheck    # typecheck only
```

Without a DATABASE_URL the backend automatically starts an embedded Postgres (PGlite) in memory — no external database required for local development.

### Full-stack (frontend + API together)

```bash
bun run dev:full     # concurrently starts Vite + API
```

## Environment variables

### Frontend (.env / .env.local)

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_ADMIN_API_URL` | Base URL of the dashboard backend (e.g. `http://localhost:4000`) | *(empty — uses demo data)* |
| `VITE_ADMIN_USE_DEMO_DATA` | Set to `0` to disable demo mode when API URL is set | *(empty — demo mode on if no URL)* |

### Backend (server/.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string (omit for embedded PGlite dev DB) | No |
| `API_PORT` | Port for the dashboard API | No (default 4000) |
| `ADMIN_JWT_SECRET` | Secret for signing admin JWT tokens | Yes (auto-generated ephemeral if unset in dev) |
| `ADMIN_EMAIL` | Bootstrap admin email | Yes |
| `ADMIN_PASSWORD` | Bootstrap admin password (only used when admin record doesn't exist yet) | Yes |
| `ADMIN_NAME` | Bootstrap admin display name | No (default "Administrator") |
| `SYNC_API_KEY` | Shared secret for the Rayern server-to-server sync endpoint | Yes (auto-generated ephemeral if unset in dev) |
| `RESEND_API_KEY` | Resend API key for sending emails | Yes (optional — see dry-run mode) |
| `EMAIL_DRY_RUN` | Set to `1` to validate + record emails without calling Resend | No |
| `EMAIL_FROM_NAME` | Sender display name | No (default "Rayern") |
| `EMAIL_FROM_ADDRESS` | Sender email address | No (default "support@rayern.com.ng") |
| `CORS_ORIGINS` | Comma-separated allowed origins for production CORS | No (allow all in dev) |
| `SERVE_STATIC` | Set to `true` to serve the compiled frontend from this API server | No |

## Login

The dashboard requires admin authentication when a backend API is configured. The bootstrap admin is created on first boot using `ADMIN_EMAIL` + `ADMIN_PASSWORD`.

When no API URL is configured (`VITE_ADMIN_API_URL` unset), the frontend shows demo data directly without login.

## Connecting the real dashboard backend

The app ships with a deterministic **demo data layer** so the UI is fully explorable before the backend exists. To switch to the real backend:

1. Set `VITE_ADMIN_API_URL=http://localhost:4000` (or your deployed API URL)
2. Set `VITE_ADMIN_USE_DEMO_DATA=0`
3. The frontend will now require admin login and show real data from the API

## Service layer

All API communication lives in `src/services/` — no `fetch` calls in components.

| Service               | Demo source   | Expected backend endpoints (GET unless noted)    |
|-----------------------|---------------|--------------------------------------------------|
| `usersService`        | `demoData.ts` | `/users`, `/users/stats`                         |
| `workspacesService`   | `demoData.ts` | `/workspaces`, `/workspaces/stats`               |
| `platformMetricsService` | `demoData.ts` | `/platform-metrics/overview` (aggregate only)    |
| `emailsService`       | `demoData.ts` | `/emails`, `/emails/stats`, `POST /emails/send`  |
| `systemService`       | `demoData.ts` | `/system/overview`                               |
| `errorsService`       | `demoData.ts` | `/errors`                                        |
| `observabilityService`| `demoData.ts` | `/observability/overview`                        |
| `auditService`        | `demoData.ts` | `/audit`                                         |
| `session / login`     | —             | `POST /auth/login`, `GET /auth/me`              |

When the backend is ready, extend each service's non-demo branch (`apiRequest(...)`) — no UI changes required.

## Sections

- **Overview** — aggregate platform KPIs (accounts, workspaces, registrations, deletions, email volume, system status), registration trend, service health, recent admin-sent email activity.
- **Users** — searchable, filterable account administration table (verification status, account status, registration date) with no workspace-content drill-downs.
- **Workspaces** — aggregate registration metadata only: name, member count, plan, creation date. No owners' emails, contents, or activity.
- **Platform Metrics** — privacy-safe aggregates: registered accounts, new registrations over time, verified vs unverified, deletions, pending deletion requests, workspace totals and plan breakdown.
- **Emails / Send Email** — admin-initiated sending only. Composer with From (fixed: `Rayern <support@rayern.com.ng>`), To, CC, **BCC**, subject, message; validation, sending state, success/failure feedback, and send history. Email types are limited to product updates, announcements, promotions, and important notices — never verification or password-reset mails.
- **System** — overall status, service availability (uptime, latency), request volume, latency percentiles, recent failures.
- **Errors** — searchable error list with severity, service/endpoint, status code, occurrences; detail drawer with trace ID.
- **Observability** — OpenTelemetry-focused: service telemetry, error-rate trend, recent slow operations, trace/span explorer.
- **Audit Log** — admin/system events with actor, action, target, metadata, timestamp.

## Server-to-server sync (STEP 7)

Rayern pushes aggregate/operational data to the dashboard API via `POST /sync/rayern` with an `x-sync-key` header.

```bash
curl -X POST http://localhost:4000/sync/rayern \
  -H "x-sync-key: YOUR_SYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "accounts": { "totalAccounts": 1234, "newAccounts30d": 42 },
    "workspaces": { "totalWorkspaces": 87 },
    "services": [{ "service": "Rayern API", "kind": "api", "status": "healthy" }]
  }'
```

Only privacy-safe aggregate data is accepted. Individual customer records are never accepted by the sync endpoint.

## Email dry-run mode

When `EMAIL_DRY_RUN=1` is set (and no `RESEND_API_KEY`), email sends are validated, stored, and audit-logged without calling Resend. This is useful for local development and sandbox preview.

## Smoke test

```bash
cd server && bun run smoke
```

Starts the API (embedded PGlite), exercises all endpoints (auth, users, workspaces, metrics, system, errors, observability, audit, email send, sync), and reports pass/fail. Requires no external database or API keys.

## Design system

Calm neutral "operator console" palette (`ink` scale) with a single restrained green accent. Dense but readable tables, subtle borders, professional status badges, skeleton loading, empty and error states, and accessible controls throughout.

## Project structure

```
src/
  lib/          config, API client (with admin auth session), domain types, formatting utils
  hooks/        useQuery (fetch + refetch), useDebouncedValue
  services/     domain services (demo + real API branches) and demo data
  components/   shared UI: charts, pagination, KPI cards, search
    ui/         primitives: button, inputs, card, badges, modal, drawer, toast, states
  pages/        one file per route (Overview, Users, Workspaces, Metrics, Emails, System, Errors, Observability, Audit, Login)

server/
  src/
    index.ts        Express entrypoint (security headers, CORS, routes, static serving)
    config.ts       env validation and typed config
    db.ts           PostgreSQL layer (own database, embedded PGlite for dev)
    auth.ts         JWT admin auth middleware + rate limiting
    audit.ts        audit event recording
    emailer.ts      Resend email sending (server-side key)
    format.ts       DB row → API shape mappers
    routes/         auth, users, workspaces, platformMetrics, emails, system, errors, observability, audit, sync
    smoke.ts        integration smoke test
  env.example       backend env var template
```

## Separation rules (enforced by design)

- No Rayern client-management pages, customer navigation, or user-facing settings.
- No Rayern auth flows — admin identity is authenticated through the dashboard backend.
- No direct database or Resend access from the browser.
- No secrets in frontend env vars (`VITE_*` is public by design).
- No path exists from this console into a customer's private Rayern workspace or customer-created content.
