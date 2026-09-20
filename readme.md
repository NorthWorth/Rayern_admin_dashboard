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

## Privacy model

This dashboard answers **"How is Rayern doing as a platform, and is the infrastructure healthy?"**

It intentionally does **not** answer "What is this particular customer doing inside their workspace?"

- No pages, tables, routes, or API calls expose individual customer data: no clients, leads, projects, tasks, deliverables, reviews, documents, meetings, or follow-ups.
- No customer activity timelines, per-workspace activity, per-customer funnels, or behavioral analytics.
- User records are administrative only (identifier, name, email, verification, account status, registration date) with no drill-down into workspace content.
- Workspace records are registration metadata only (name, member count, plan, creation date).
- **Platform Metrics** is aggregate-only: total accounts, new registrations, verified/unverified counts, deletions, workspace totals and plan breakdown. There are no drill-downs that could reveal private customer or workspace information.

## Getting started

```bash
bun install
bun run dev        # start dev server (http://localhost:5173)
bun run typecheck  # typecheck only
bun run build      # typecheck + production build to dist/
```

## Connecting the real dashboard backend

The app ships with a deterministic **demo data layer** so the UI is fully explorable before the backend exists. To switch to the real backend:

1. Set the API base URL (env var, no secrets):
   ```
   VITE_ADMIN_API_URL=https://your-dashboard-backend.example.com
   ```
   When this is set, all services call the backend instead of the demo layer.
2. Optionally set `VITE_ADMIN_USE_DEMO_DATA=0` to disable demo mode when a URL is configured.

See `env.example`.

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

## Design system

Calm neutral "operator console" palette (`ink` scale) with a single restrained green accent. Dense but readable tables, subtle borders, professional status badges, skeleton loading, empty and error states, and accessible controls throughout.

## Project structure

```
src/
  lib/          config, API client, domain types, formatting utils
  hooks/        useQuery (fetch + refetch), useDebouncedValue
  services/     domain services (demo + real API branches) and demo data
  components/   shared UI: charts, pagination, KPI cards, search
    ui/         primitives: button, inputs, card, badges, modal, drawer, toast, states
  pages/        one file per route (Overview, Users, Workspaces, Metrics, Emails, System, Errors, Observability, Audit)
```

## Separation rules (enforced by design)

- No Rayern client-management pages, customer navigation, or user-facing settings.
- No Rayern auth flows — admin identity is a placeholder until the dashboard backend provides it.
- No direct database or Resend access from the browser.
- No secrets in frontend env vars (`VITE_*` is public by design).
- No path exists from this console into a customer's private Rayern workspace or customer-created content.
