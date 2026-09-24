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
| `RAYERN_SYNC_INTERVAL_MS` | How often to pull from Rayern (ms, default 1800000 = 30 minutes) | No |
| `RAYERN_SYNC_TIMEOUT_MS` | Per-request timeout (ms, default 15000) | No |
| `TELEMETRY_ENABLED` | Master switch for OpenTelemetry/local telemetry (default `true`; `OTEL_SDK_DISABLED=true` also disables) | No |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP base endpoint for trace export (unset = local telemetry only) | No |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full OTLP traces URL (wins over the base endpoint) | No |
| `OTEL_EXPORTER_OTLP_HEADERS` | Standard OTLP auth headers (`key=value,key2=value2`) | No |
| `OTEL_SERVICE_NAME` | Telemetry service name (default `rayern-admin-dashboard-api`) | No |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | Standard OTel sampler (affects OTLP export only; default always-on) | No |
| `TELEMETRY_ENVIRONMENT` | `deployment.environment` resource attribute (default `NODE_ENV`) | No |
| `TELEMETRY_SLOW_REQUEST_MS` / `TELEMETRY_SLOW_QUERY_MS` | Slow request/query thresholds (defaults 1000 / 250) | No |
| `TELEMETRY_FLUSH_MS` | Telemetry persistence batch interval (default 10000) | No |
| `TELEMETRY_*_RETENTION_HOURS` | Telemetry table retention (defaults: traces 48h, request log / span metrics 168h) | No |
| `HEALTH_MIN_SAMPLES` | Samples required before latency/availability are reported (default 10; below → null) | No |
| `HEALTH_ERROR_RATE_DEGRADED_PCT` / `HEALTH_ERROR_RATE_FAILING_PCT` | API error-rate thresholds (defaults 1 / 5) | No |
| `HEALTH_LATENCY_P95_DEGRADED_MS` / `HEALTH_LATENCY_P95_FAILING_MS` | API p95 latency thresholds (defaults 500 / 2000) | No |
| `HEALTH_AVAILABILITY_DEGRADED_PCT` / `HEALTH_AVAILABILITY_FAILING_PCT` | Availability thresholds (defaults 99 / 95) | No |
| `HEALTH_DB_ERROR_RATE_DEGRADED_PCT` / `HEALTH_DB_ERROR_RATE_FAILING_PCT` | PostgreSQL query error-rate thresholds (defaults 1 / 10) | No |

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

**Recipient rule.** A send is allowed when To, CC **or** BCC contains at least one recipient; it is rejected only when all three are empty.

**BCC-only architecture (privacy-safe recipient expansion).** Resend's normal email API requires a `to` recipient, so a genuinely BCC-only payload cannot simply omit `to`. The dashboard backend therefore **expands** such operations server-side (`server/src/emailDelivery.ts`): every recipient that must not see the others receives an **individual message whose `to` is that recipient alone**. BCC recipients can never see one another; no fake To and no shared To list is ever fabricated. Normal sends with visible To recipients keep the classic single-message To/CC structure.

**Resend Batch API.** Expanded messages are carried through Resend's Batch API in chunks of at most 100 individual messages per request (`RESEND_BATCH_CHUNK_SIZE`, provider max 100). 250 BCC recipients → 3 batch requests (100 + 100 + 50), each message an individual email. Every submission carries a deterministic `Idempotency-Key` (`<sendGroupId>:<kind>:<index>`), so a retried batch — timeout, lost response, frontend retry — is deduplicated by Resend instead of re-sent, and a completed logical send replays its original result locally.

**Body modes.** The composer has an explicit **Plain Text | HTML** switch carried through the request as `bodyType`:

- Plain Text → the body goes to Resend's `text` field only (typed HTML tags stay literal).
- HTML → the body is sanitized (scripts, frames, event handlers and `javascript:` URLs stripped), normalized into a document (fragments like `<p>Hello</p>` need no boilerplate), and goes to Resend's `html` field only. A sandboxed, script-free iframe provides a browser-like preview.
- The mode is stored with the history record, shown as metadata in the table, and preserved by "copy as new" (which never auto-sends).

**Usage & quota.** Usage counts **individual recipient messages the provider accepted** — never batches, API requests, clicks, or rejected sends. One BCC-only send to 250 recipients consumes 250 emails. The authoritative counter is the `emails` table itself (one row per individual message, status `accepted`), so usage survives restarts and deployments and cannot double-count (a unique index on the provider message id makes each real message countable exactly once; retries replay). The Emails page shows this month / today against the configured limits:

- `RESEND_MONTHLY_EMAIL_LIMIT` (default 3000) and `RESEND_DAILY_EMAIL_LIMIT` (default 100) — change with the Resend plan, not code.
- Quota is enforced **server-side before any provider call**: an operation that does not fit the remaining monthly AND daily quota is rejected entirely (HTTP 402 with counts, no recipient data) — never partially sent.
- `POST /emails/usage/reconcile` re-submits messages whose outcome was unknown (timeout/lost response) with their original idempotency keys: already-accepted messages return the same ids without re-sending. A failed reconciliation keeps last-known usage.

**Bulk sends.** Email history and the Audit Log render audience **counts** (`250 recipients` / `1 To · 5 CC · 244 BCC`, plus `Provider messages: 250 · Batches: 3`) — never hundreds of addresses. An expanded (BCC) operation stays **one logical row** in history; email bodies are never displayed in either table.

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

## Telemetry (OpenTelemetry)

The backend instruments its **own** operations with the standard OpenTelemetry API/SDK and an optional OTLP/HTTP exporter:

- **HTTP requests** → SERVER spans with route *templates* (`GET /users/stats`), status, duration; p50/p95/p99, error rate, slow requests, request volume.
- **PostgreSQL** → CLIENT spans per query with a sanitized statement template (literals redacted, parameters never leave the driver); query duration/errors/slow queries and pool failures.
- **Internal/external operations** → `rayern.sync` (INTERNAL) with `rayern.fetch` and `resend.send` as CHILD spans — proper parent/child trace relationships.
- **Runtime** → process uptime, memory, CPU, event-loop delay.
- **Health** → deterministic `healthy`/`degraded`/`failing` from configurable `HEALTH_*` thresholds. With insufficient telemetry the measured fields are `null` (rendered `—`) — never a fake `0ms`/`100%`.

Architecture: spans → `BatchSpanProcessor` → OTLP endpoint (optional), and aggregate-only local records → rolling windows + batched persistence feeding `request_log`, `trace_spans`, `service_telemetry`, `slow_operations`, `span_metrics`, and `errors` (API 5xx) — the tables behind the System and Observability pages. Telemetry persistence runs with tracing **suppressed**, so writing telemetry can never generate telemetry.

**Never recorded:** Authorization headers/JWTs, cookies, API keys, request/response bodies, emails, user or workspace identifiers, query strings, raw paths with ids, or SQL parameters. This is enforced by `server/src/telemetry/sanitize.ts` and asserted by the telemetry test.

Telemetry is fully optional: unset every variable and the API starts and serves normally; an unreachable OTLP endpoint (or a telemetry failure of any kind) never fails startup or a request.

```bash
cd server && bun run telemetry-test   # telemetry suite (spans, redaction, exporter failure, disabled mode)
```

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
- **Emails / Send Email** — admin-initiated sending only. Composer with From (fixed: `Rayern <support@rayern.com.ng>`), To, CC, BCC (any non-empty combination is sendable), Plain Text/HTML body mode with sandboxed preview, subject, email type; validation, sending state, success/failure feedback, and a bulk-safe send history (audience counts, mode, copy as new).
- **System** — overall status, service availability (uptime, latency), request volume, latency percentiles, recent failures, Rayern sync status.
- **Errors** — searchable error list with severity, service/endpoint, status code, occurrences; detail drawer with trace ID.
- **Observability** — OpenTelemetry-focused: service telemetry, error-rate trend, recent slow operations, trace/span explorer.
- **Audit Log** — admin/system events with actor, action, target, compact metadata (recipient counts, never stacked address lists), timestamp, and a privacy-conscious details view; responsive card layout on mobile.

## Design system

Calm neutral "operator console" palette (`ink` scale) with a single restrained green accent. Dense but readable tables, subtle borders, professional status badges, skeleton loading, empty and error states, and accessible controls throughout.

## Separation rules (enforced by design)

- No Rayern client-management pages, customer navigation, or user-facing settings.
- No Rayern auth flows — admin identity is authenticated through the dashboard backend.
- No direct database or Resend access from the browser.
- No secrets in frontend env vars (`VITE_*` is public by design).
- No path exists from this console into a customer's private Rayern workspace or customer-created content.
- The dashboard backend and Rayern are completely independent systems.
