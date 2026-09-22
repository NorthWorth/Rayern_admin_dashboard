# Rayern Admin Dashboard

A standalone internal administration and observability console for Rayern. This is **not** the Rayern product — it is a separate operator dashboard that communicates exclusively with its own dedicated dashboard API.

## Architecture

```
                         RAYERN
                    Existing Application
                           │
                           │  asynchronous GET
                           ▼
                 ┌─────────────────────┐
                 │ Dashboard Sync      │
                 │ Service             │
                 │                     │
                 │ server/             │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ Dashboard           │
                 │ PostgreSQL          │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ Dashboard API       │
                 │ server/             │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ Dashboard Frontend  │
                 │ client/             │
                 └─────────────────────┘
```

- The frontend (`client/`) never connects to Rayern's database, Rayern's server internals, or Resend directly.
- The backend (`server/`) periodically pulls approved aggregate metrics from Rayern via an outbound GET request. Rayern never calls the dashboard.
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

## Project structure

```
repo/
├── client/                 ← Dashboard frontend (React + Vite + Tailwind)
│   ├── src/
│   │   ├── components/     Shared UI: charts, pagination, KPI cards, search
│   │   │   └── ui/         Primitives: button, inputs, card, badges, modal, drawer, toast, states
│   │   ├── hooks/          useQuery (fetch + refetch), useDebouncedValue
│   │   ├── lib/            Config, API client (with admin auth session), domain types, utils
│   │   ├── pages/          One file per route (Overview, Users, Workspaces, Metrics, Emails, System, Errors, Observability, Audit, Login)
│   │   └── services/       Domain services (demo + real API branches) and demo data
│   ├── public/             Static assets
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── server/                 ← Dashboard backend (Express + PostgreSQL)
│   ├── src/
│   │   ├── index.ts        Express entrypoint (security headers, CORS, routes, static serving)
│   │   ├── config.ts       Env validation and typed config
│   │   ├── db.ts           PostgreSQL layer (own database, embedded PGlite for dev)
│   │   ├── auth.ts         JWT admin auth middleware + rate limiting
│   │   ├── audit.ts        Audit event recording
│   │   ├── emailer.ts      Resend email sending (server-side key)
│   │   ├── format.ts       DB row → API shape mappers
│   │   ├── rayernSync.ts   Dashboard-side pull-sync worker (outbound GET to Rayern)
│   │   ├── routes/         auth, users, workspaces, platformMetrics, emails, system, errors, observability, audit
│   │   └── smoke.ts        Integration smoke test
│   ├── package.json
│   └── tsconfig.json
│
├── scripts/                Operational scripts
├── .gitignore
├── README.md
└── package.json            Root workspace orchestration
```

## Getting started

### Frontend

```bash
cd client
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

From the repo root:

```bash
bun run dev          # concurrently starts Vite + API
```

Or run each independently:

```bash
bun run dev:client   # Vite frontend only
bun run dev:server   # API server only
```

## Environment variables

### Frontend (client/.env / client/.env.local)

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_ADMIN_API_URL` | Base URL of the dashboard backend (e.g. `http://localhost:4000`) | *(empty — uses demo data)* |
| `VITE_ADMIN_USE_DEMO_DATA` | Set to `0` to disable demo mode when API URL is set | *(empty — demo mode on if no URL)* |

> **Security:** Only `VITE_*` variables are exposed to the browser. Never place `RESEND_API_KEY`, `ADMIN_JWT_SECRET`, `ADMIN_PASSWORD`, `RAYERN_MONITORING_TOKEN`, or `DATABASE_URL` in `client/.env`.

### Backend (server/.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string (omit for embedded PGlite dev DB) | No |
| `API_PORT` | Port for the dashboard API | No (default 4000) |
| `ADMIN_JWT_SECRET` | Secret for signing admin JWT tokens | Yes (auto-generated ephemeral if unset in dev) |
| `ADMIN_EMAIL` | Bootstrap admin email | Yes |
| `ADMIN_PASSWORD` | Bootstrap admin password (only used when admin record doesn't exist yet) | Yes |
| `ADMIN_NAME` | Bootstrap admin display name | No (default "Administrator") |
| `RESEND_API_KEY` | Resend API key for sending emails | Yes (optional — see dry-run mode) |
| `EMAIL_DRY_RUN` | Set to `1` to validate + record emails without calling Resend | No |
| `EMAIL_FROM_NAME` | Sender display name | No (default "Rayern") |
| `EMAIL_FROM_ADDRESS` | Sender email address | No (default "support@rayern.com.ng") |
| `CORS_ORIGINS` | Comma-separated allowed origins for production CORS | No (allow all in dev) |
| `SERVE_STATIC` | Set to `true` to serve the compiled frontend from this API server | No |
| `RAYERN_SYNC_ENDPOINT` | Full URL of the Rayern metrics endpoint the dashboard pulls from | No (sync disabled if empty) |
| `RAYERN_API_BASE_URL` | Base URL of the Rayern API (used to construct sync endpoint if `RAYERN_SYNC_ENDPOINT` is empty) | No |
| `RAYERN_MONITORING_TOKEN` | Bearer token sent to Rayern for the sync endpoint | No |
| `RAYERN_SYNC_INTERVAL_MS` | How often to pull from Rayern (ms, default 600000 = 10 minutes) | No |
| `RAYERN_SYNC_TIMEOUT_MS` | Per-request timeout (ms, default 15000) | No |

## Login

The dashboard requires admin authentication when a backend API is configured. The bootstrap admin is created on first boot using `ADMIN_EMAIL` + `ADMIN_PASSWORD`.

When no API URL is configured (`VITE_ADMIN_API_URL` unset), the frontend shows demo data directly without login.

## Rayern synchronization

The dashboard periodically pulls approved aggregate metrics from the Rayern API. This is a **pull-based** architecture:

- The dashboard's sync worker (`server/src/rayernSync.ts`) makes outbound GET requests to the configured Rayern endpoint.
- Rayern never calls the dashboard, never pushes data, and never waits for the dashboard.
- The sync is completely independent — if the dashboard is down, Rayern continues operating normally.
- Only privacy-safe aggregate data is accepted (Zod validation strips any unexpected fields).
- Previously synchronized data is retained during outages; stale data is clearly indicated.

Configure the sync by setting `RAYERN_SYNC_ENDPOINT` and `RAYERN_MONITORING_TOKEN` on the backend.

## Email system

The dashboard's email system is independent from Rayern's automated transactional email system:

- **Rayern** handles verification emails, password-reset emails, and other automated transactional emails.
- **Dashboard** handles admin-initiated emails: product updates, announcements, promotions, and important notices.

The email composer supports To, CC, BCC (each with multiple recipients), bulk "select all recipients", email type selection, and "copy as new email" from past sends. The sender identity is enforced server-side as `Rayern <support@rayern.com.ng>`.

## Service layer

All API communication lives in `client/src/services/` — no `fetch` calls in components.

| Service                  | Expected backend endpoints (GET unless noted)    |
|--------------------------|--------------------------------------------------|
| `usersService`           | `/users`, `/users/stats`                         |
| `workspacesService`      | `/workspaces`, `/workspaces/stats`               |
| `platformMetricsService` | `/platform-metrics/overview` (aggregate only)    |
| `emailsService`          | `/emails`, `/emails/stats`, `POST /emails/send`  |
| `systemService`          | `/system/overview`                               |
| `errorsService`          | `/errors`                                        |
| `observabilityService`   | `/observability/overview`                        |
| `auditService`           | `/audit`                                         |
| `session / login`        | `POST /auth/login`                              |

## Smoke test

```bash
cd server && bun run smoke
```

Starts the API (embedded PGlite), exercises all endpoints (auth, users, workspaces, metrics, system, errors, observability, audit, email send, pull-sync lifecycle), and reports pass/fail. Requires no external database or API keys.

## Sections

- **Overview** — aggregate platform KPIs (accounts, workspaces, registrations, deletions, email volume, system status), registration trend, service health, recent admin-sent email activity.
- **Users** — searchable, filterable account administration table (verification status, account status, registration date) with no workspace-content drill-downs.
- **Workspaces** — aggregate registration metadata only: name, member count, plan, creation date. No owners' emails, contents, or activity.
- **Platform Metrics** — privacy-safe aggregates: registered accounts, new registrations over time, verified vs unverified, deletions, pending deletion requests, workspace totals and plan breakdown.
- **Emails / Send Email** — admin-initiated sending only. Composer with From (fixed: `Rayern <support@rayern.com.ng>`), To, CC, BCC, subject, message, email type; validation, sending state, success/failure feedback, and send history. Supports bulk "select all recipients" and "copy as new email".
- **System** — overall status, service availability (uptime, latency), request volume, latency percentiles, recent failures, Rayern sync status.
- **Errors** — searchable error list with severity, service/endpoint, status code, occurrences; detail drawer with trace ID.
- **Observability** — OpenTelemetry-focused: service telemetry, error-rate trend, recent slow operations, trace/span explorer.
- **Audit Log** — admin/system events with actor, action, target, metadata, timestamp.

## Design system

Calm neutral "operator console" palette (`ink` scale) with a single restrained green accent. Dense but readable tables, subtle borders, professional status badges, skeleton loading, empty and error states, and accessible controls throughout.

## Separation rules (enforced by design)

- No Rayern client-management pages, customer navigation, or user-facing settings.
- No Rayern auth flows — admin identity is authenticated through the dashboard backend.
- No direct database or Resend access from the browser.
- No secrets in frontend env vars (`VITE_*` is public by design).
- No path exists from this console into a customer's private Rayern workspace or customer-created content.
- The dashboard backend and Rayern are completely independent systems.
