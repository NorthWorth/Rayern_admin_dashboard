# Rayern Founder Dashboard — Backend Integration Requirements Report

**Status:** audit only — no code was changed by this report.
**Date:** 2026-10-27
**Repositories inspected:**

| Repo | Role | Evidence used |
|---|---|---|
| `NorthWorth/Rayern-backend` (private, `main`) | The actual Rayern application backend (Express + MongoDB/Mongoose) | `src/app.js`, `src/routes/*`, `src/controllers/*`, `src/models/user.js`, `src/models/workspace.js`, `src/config/env.js`, `src/middleware/*` read directly from GitHub |
| `NorthWorth/Rayern-frontend` (public, `main`) | Rayern customer SPA | `package.json`, code search for `utm_source` / analytics SDKs (0 matches) |
| Rayern waitlist service (standalone Express + Mongoose) | Waitlist capture + double opt-in | `server.js`, `models/waitlist.js` read directly |
| This repository (`Rayern_admin_dashboard`) | Dashboard frontend + dashboard backend | `server/src/*`, `client/src/*`, `docs/ADMIN_DASHBOARD_BILLING_CONTRACT.md` |

Legend: **[E]** existing and verified · **[M]** missing (must be built) · **[P]** proposed new contract (this report defines it).

---

## 0. Architecture summary (as verified)

```
Rayern app (Mongo)  ──GET /internal/dashboard-metrics (Bearer RAYERN_MONITORING_TOKEN)──►  Dashboard backend pull-sync
                                                                                              │  (30-min interval, Zod-validated,
                                                                                              │   stored in Postgres rayern_sync_state)
Dashboard backend  ──proxy /api/v1/admin/users, /api/v1/admin/campaigns/* (session JWT)──►   Rayern app
Dashboard backend  ──proxy (NOT yet built)──►  Rayern GET /api/v1/admin/waitlist ──►  Waitlist service
Dashboard browser  ──only talks to the dashboard backend (VITE_ADMIN_API_URL)──►  never to Rayern directly
```

- Rayern **never calls** the dashboard. All aggregate flow is pull.
- The dashboard backend authenticates to Rayern in two ways: service token (`RAYERN_MONITORING_TOKEN`) for metrics, and an admin session JWT (`RAYERN_ADMIN_EMAIL`/`RAYERN_ADMIN_PASSWORD`, must be listed in Rayern's `ADMIN_EMAILS`) for the admin proxy.

---

## 1. Configuration and synchronization

### 1.1 Environment variables

**Dashboard backend (`server/src/config.ts`) — [E]**

| Variable | Purpose | Required |
|---|---|---|
| `RAYERN_SYNC_ENDPOINT` (or `RAYERN_INTERNAL_DASHBOARD_METRICS`) | Exact metrics URL; wins over base URL | for sync |
| `RAYERN_API_BASE_URL` | Origin only; endpoint derived as `<base>/internal/dashboard-metrics`; also base for admin proxy | yes (proxy) |
| `RAYERN_MONITORING_TOKEN` | Bearer token; must equal Rayern's value | for sync |
| `RAYERN_ADMIN_EMAIL` / `RAYERN_ADMIN_PASSWORD` | Admin service account for proxy login (`POST /api/v1/auth/login`) | for proxy |
| `RAYERN_SYNC_INTERVAL_MS` | Pull interval, default `1_800_000` (30 min), clamped 30 s–24 h | no |
| `RAYERN_SYNC_TIMEOUT_MS` | Fetch timeout, default 15 000 ms (min 5 000) | no |
| `DATABASE_URL`, `ADMIN_JWT_SECRET`, `ADMIN_EMAILS`, `ADMIN_EMAIL/PASSWORD/NAME`, `RESEND_API_KEY`, `FROM_EMAIL`, `CORS_ORIGINS`, `SERVE_STATIC`, `TELEMETRY_*`, `HEALTH_*` | dashboard-local | see `server/env.example` |

**Rayern backend (`src/config/env.js`) — [E]** (names only, values never handled here)
`RAYERN_MONITORING_TOKEN` (fail-closed: while unset, `/internal/dashboard-metrics` returns 401 for everyone), `ADMIN_EMAILS`, `WAITLIST_API_URL`, `WAITLIST_ADMIN_TOKEN`, `EMAILJS_SERVICE_ID/TEMPLATE_ID/API_KEY/PRIVATE_KEY`, `RESEND_API_KEY`, `FROM_EMAIL`, `CLIENT_URL`, `PAYSTACK_*`, `BILLING_GRACE_PERIOD_DAYS`, `TRUST_PROXY`, `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTEL_*`, `RAYERN_TELEMETRY_WINDOW_MINUTES` (15), `RAYERN_TELEMETRY_MIN_SAMPLES` (10), `RAYERN_TELEMETRY_SLOW_REQUEST_MS` (1000), `RAYERN_TELEMETRY_ERROR_RATE_DEGRADED` (0.02), `RAYERN_TELEMETRY_ERROR_RATE_FAILING` (0.1), `RAYERN_TELEMETRY_LATENCY_P95_DEGRADED_MS` (750), `RAYERN_TELEMETRY_LATENCY_P95_FAILING_MS` (2000).

**No new environment variables are required for any P0/P1 item in this report.**

### 1.2 Metrics endpoints — [E]

Both mounts run the **same handler** (`src/controllers/dashboardMetricsController.js`):

| Endpoint | Auth | Rate limiting |
|---|---|---|
| `GET /internal/dashboard-metrics` | `Authorization: Bearer <RAYERN_MONITORING_TOKEN>` (fail-closed) | mounted outside `/api`, never crosses any limiter |
| `GET /api/v1/admin/metrics` | `requireAuth` + `requireAdmin` (session JWT, `ADMIN_EMAILS`) | **exact-path skip** in `generalLimiter.skip` — never 429 from app limiters |

Request: no query params, no body. Response envelope (Rayern standard):

```json
{ "success": true, "data": { "accounts": {…}, "workspaces": {…}, "billing": {…},
  "services": […], "telemetry": {…} } }
```

Verified `data` fields (exact names — the dashboard's `SyncPayload` Zod schema rejects mismatches):

```jsonc
"accounts": {
  "totalAccounts": 123, "newAccounts30d": 12,
  "verifiedAccounts": 100, "unverifiedAccounts": 23,
  "deletedAccounts30d": null,          // ALWAYS null today (no deletion accounting in Rayern)
  "deletionRequestsPending": null,      // ALWAYS null today
  "registrationsTrend": [{ "date": "2026-10-01", "count": 3 }],  // 30 days, UTC, zero-filled
  "planBreakdown": [{ "plan": "starter", "count": 100 }]        // legacy free/agency normalized
},
"workspaces": { "totalWorkspaces": 120, "newWorkspaces30d": 11, "avgMembersPerWorkspace": 1.2 },
"billing": { "currency": "USD", "amountUnit": "minor_units", "generatedAt": "…Z",
  "activePaidSubscribers": 14, "freeUsers": 109, "totalAccounts": 123,
  "mrr": { "amountMinor": 41320, "amountMajor": 413.2,
           "byPlan": [{ "plan": "pro", "subscriberCount": 10, "mrrMinor": 19000 }] },
  "arr": { "amountMinor": 495840, "amountMajor": 4958.4, "definition": "mrr_x_12" },
  "planBreakdown": [{ "plan": "pro", "userCount": 10, "subscriptionCount": 10, "isPaid": true }],
  "definitions": { "…": "documented metric definitions" } },
"services": [{ "service": "Rayern API", "kind": "api",
  "status": "healthy|degraded|failing|unknown",
  "uptimePct30d": null,                 // ALWAYS null — Rayern records no 30-day history
  "latencyMsP50": 41, "latencyMsP95": 120, "lastIncidentAt": null }],
"telemetry": { /* evaluateTelemetry() block — see §2 */ }
```

Known gap: Rayern currently returns **one** `services` entry (`Rayern API`); `kind: database|email|storage…` rows are never produced.

### 1.3 Sync behavior, error handling, persistence — [E] (dashboard side, `server/src/rayernSync.ts`)

- Worker: first pull 5 s after boot, then every `RAYERN_SYNC_INTERVAL_MS` (**30 min default — unchanged**), overlap-guarded (`running` flag).
- Envelope: `{success:true,data}` unwrapped; `{success:false,error:{code,message}}` aborts without storing.
- Validation: Zod `SyncPayload`; unknown top-level keys stripped (privacy contract); any schema issue → **nothing stored**; payload with zero sections → recorded as failure.
- HTTP 429: honors `Retry-After` (delta-seconds or HTTP-date), backs off up to 1 h, keeps previously synced aggregates untouched.
- Timeout: `AbortController` at `RAYERN_SYNC_TIMEOUT_MS`.
- Failure recording: `sync_status` row (last_attempt/success/failure, `last_error` ≤500 chars, `consecutive_failures`, `last_duration_ms`, `last_http_status`), an `errors` table row deduped under `service='Rayern Sync'`, and an `audit` row `rayern-sync/sync.failed`. Shape-only logging (never values/tokens/PII).
- Persistence: Postgres `rayern_sync_state` keys `accounts|workspaces|billing|services|telemetry` + `service_health` upsert; `dataUpdatedAt = max(updated_at)` (a failed pull never advances it); `GET /system` exposes `getSyncStatus()` incl. `stale`, `rateLimitedUntil`, `intervalMs`.
- When sync is unconfigured the dashboard degrades honestly: empty/unavailable states, no fabricated zeros claimed as data.

### 1.4 Rate limits (must remain unchanged)

Rayern (`src/app.js`, `src/middleware/rateLimiters.js`, contract §7): `generalLimiter` 200/15 min/IP on `/api` with exact-path skip for `/api/v1/admin/metrics` and prefix skip `/api/v1/webhooks/`; `feedbackLimiter` 5/15 min; `credentialLimiter` 10/15 min; `sessionLimiter` 100/15 min; `campaignSendLimiter` 10/15 min; `uploadLimiter` 40/15; `publicReviewLimiter` 120/15. Infrastructure (Cloudflare → Render) limits are separate. Dashboard side: global 300/min plus the 30-minute sync cadence. **No item in this report changes any of these.**

---

## 2. Application observability

### 2.1 What exists — [E] (Rayern)

- `telemetryMiddleware` spans **every** request (including 429s and `/internal`), normalized route templates as labels.
- In-process bounded buffers (`src/telemetry/state.js`): HTTP ring 50 000 samples `{t, durMs, status, label}`, DB ring 10 000, dependency rings per host (50 hosts × 5 000), 20 incidents on health-state transitions.
- `evaluateTelemetry({dbReadyState})` returns the `telemetry` block of the metrics payload:

```jsonc
{ "active": true, "status": "healthy|degraded|failing|unknown",
  "windowMinutes": 15, "minSamples": 10, "sampleCount": 431,
  "requestRatePerMin": 28.7, "errorRatePct": 0.46, "availabilityPct": 99.54,
  "latencyMsP50": 41, "latencyMsP95": 120, "latencyMsP99": 310,
  "slowRequestCount": 3,
  "slowEndpoints": [{ "route": "/api/v1/clients", "count": 96, "errorCount": 1,
                      "slowCount": 0, "p50Ms": 38.2, "p95Ms": 121.0 }],   // top 5 by p95
  "database": { /* status, errorRate, p95 — from db ring + readyState */ },
  "dependencies": [{ "host": "api.resend.com", "kind": "external", "requestCount": 88,
                     "errorCount": 0, "errorRatePct": 0, "p95Ms": 220, "status": "healthy" }], // top 10
  "recentIncidents": [{ "at": "…Z", "scope": "api", "reason": "high_error_rate" }],
  "lastIncidentAt": null }
```

- Health endpoint: `GET /api/v1/health` → `{success, data:{status:"ok", service:"rayern-api", environment}}`.
- Optional OTLP export (`OTEL_EXPORTER_OTLP_*`); docs: `docs/Rayern—OpenTelemetry-Observability.md`.

### 2.2 What does NOT exist — [M]

1. **No log-retrieval API anywhere.** Rayern logs to stdout → Render dashboard only. The dashboard cannot securely fetch application logs; its Errors page shows only dashboard-local errors plus sync errors it recorded itself. Do not present any dashboard metric as a log line.
2. **No per-endpoint method/status matrix.** `slowEndpoints` covers only the top-5 slowest routes in the window; `recordHttpRequest` does not capture HTTP method; 4xx breakdowns, endpoint-level GET/POST failure counts and full route lists are not available.
3. **No exception store.** Unhandled exceptions reach `errorHandler` → console; nothing queryable.
4. **No request/correlation ID.** Rayern error envelopes (`{success:false,error:{code,message}}`) carry no request id, so a dashboard-reported failure cannot be correlated with Rayern/Render logs.
5. **API destination/configuration failures** (e.g. `EMAIL_NOT_CONFIGURED`, `BILLING_NOT_CONFIGURED`, EmailJS/Paystack/Cloudinary unreachable) surface only as ad-hoc response codes; there is no aggregated "dependency configuration status" view.
6. **No 30-day uptime history** (`uptimePct30d` is hard-coded `null`).

### 2.3 Proposed Rayern additions — [P] (smallest viable shape)

**P2-A: extend the `telemetry` block (or add `endpoints`) inside `GET /internal/dashboard-metrics`:**

```jsonc
"endpointHealth": {
  "windowMinutes": 15,
  "rows": [
    { "method": "GET", "route": "/api/v1/clients/:id", "count": 210, "status2xx": 205,
      "status4xx": 4, "status5xx": 1, "timeoutCount": 0,
      "p50Ms": 40, "p95Ms": 130, "avgMs": 52, "lastErrorAt": "…Z",
      "lastErrorMessage": "Cast to ObjectId failed" }   // message truncated, no PII
  ]
}
```

Implementation notes: derive from the existing HTTP ring (add `method` to `recordHttpRequest`), cap rows (e.g. 50), keep the privacy contract (route templates only, never query strings/bodies), keep thresholds as-is.

**P2-B: bounded exception log (new, admin-only):**

- `GET /internal/logs?since=<iso>&limit=100&severity=error|warn` — Bearer monitoring token (same token as metrics; fail-closed).
- Row: `{ at, severity, route, method, status, message (≤500 chars, scrubbed), requestId, traceId }`. Store in a capped collection (e.g. 5 000 rows, 7-day TTL). Register in `errorHandler` + a single unhandledRejection/uncaughtException hook.
- **Never** include headers, tokens, request bodies, emails or passwords; scrub known secret patterns before persisting.
- Dashboard side then adds an `/internal/logs` passthrough guarded by dashboard `requireAdmin`, rendered on the System/Diagnostics page.

**P2-C: correlation IDs:** middleware accepts/generates `X-Request-Id`, echoes it on every response and includes it in error envelopes and in `telemetry` rows (P2-A/P2-B). No auth impact.

**P2-D: dependency configuration status** (cheap, high value):

```jsonc
"dependencyConfig": [
  { "name": "resend",        "configured": true },
  { "name": "emailjs",       "configured": false },
  { "name": "paystack",      "configured": true },
  { "name": "cloudinary",    "configured": true },
  { "name": "waitlist",      "configured": true }
]
```

Booleans derived from existing `env` fields — no secret values, no probing.

---

## 3. Acquisition and conversion

### 3.1 Existing data — [E]

| Signal | Source | Notes |
|---|---|---|
| Daily registrations (30 d, UTC, zero-filled) | `accounts.registrationsTrend` in metrics payload | verified in `dashboardMetricsController.js` |
| Total/new/verified accounts, plan breakdown | same payload | |
| Waitlist joins over time | `GET /api/v1/admin/waitlist` → `signups[].joinedAt` (§5) | top-of-funnel proxy only |
| Page views | `@vercel/analytics` in Rayern frontend | **not exposed through any API**; no UTM capture |

### 3.2 Missing — [M]

No landing-page visitor counting, no UTM/source/medium/campaign fields anywhere (`User`, `Waitlist` — code search 0 matches), no sign-up-initiation event (Rayern's `POST /api/v1/auth/register` only records success/failure responses; nothing persists an attempt), no onboarding model or fields, no activation timestamp, no channel conversion. The dashboard's Acquisition/Funnels pages correctly show these as **unavailable** today.

### 3.3 Proposed — [P]

**P1-A: attribution fields on registration (Rayern).**

- Frontend: capture `utm_source|utm_medium|utm_campaign|utm_term|utm_content` + `referrer` from `location.search`/`document.referrer` at the entry point, persist in `sessionStorage`, attach to `POST /api/v1/auth/register` body (new optional object `attribution`).
- Backend: `user.attribution = { source, medium, campaign, referrer, capturedAt }` (all optional, capped lengths), plus `user.signupInitiatedAt` set by a new lightweight `POST /api/v1/auth/signup-intent` (rate-limited by `credentialLimiter`, stores only `{emailHash?, at}` or a counter — **no new account row**; document the chosen privacy stance before building).
- Validation: zod-validated, unknown keys stripped; never accept attribution fields on any other endpoint.

**P1-B: funnel aggregates in the metrics payload (Rayern)** — new optional `funnel` block so the existing sync channel carries it with zero dashboard plumbing changes:

```jsonc
"funnel": {
  "windowDays": 30,
  "stages": [
    { "stage": "visitor",        "count": null, "reason": "no_visitors_instrumented" },
    { "stage": "signup_started", "count": 410 },
    { "stage": "registered",     "count": 118 },
    { "stage": "onboarding_done","count": null, "reason": "no_onboarding_model" },
    { "stage": "activated",      "count": null, "reason": "no_activation_definition" },
    { "stage": "retained_d7",    "count": null, "reason": "no_activity_events" },
    { "stage": "paid",           "count": 14 }
  ]
}
```

`count: null` + machine `reason` is mandatory — the dashboard must render unavailable, never `0`. Visitor stage stays `null` until analytics exist (P2-E).

**P2-E: visitor analytics (Rayern frontend + chosen provider).** Options: self-hosted Plausible/Umami (privacy-friendly, gives UTM + visitor counts via its API) or Vercel Web Analytics API export. Either way the dashboard reads a **provider API with a read-only key held server-side**; no third-party script may be added without that decision. This is the only way the "Website Visitor" funnel stage stops being null.

---

## 4. Activation and retention

### 4.1 Existing — [E]

Only what §3.1 lists. `User` model (verified) has: `email`, `password` (select:false), `firstName/lastName`, `emailVerified`, reset/lock fields, `status: active|suspended`, `marketingConsent`, `welcomeEmailSentAt`, timestamps. **No** `lastActiveAt`, no onboarding fields, no activity stream. `Workspace` has plan/subscription/timezone/storage counters only. The collections that *would* evidence product usage exist (`clients`, `leads`, `projects`, `tasks`, `deliverables`, `meetings`, `notifications`, `files`, `documents`) but no endpoint aggregates them, and their `createdAt` timestamps are workspace-object events, not user activity.

### 4.2 Missing — [M]

Meaningful-activity events, DAU/WAU/MAU, returning-user flags, activation definition/timestamp, time-to-activation, D1/D7/D30 retention, cohort retention. The dashboard's Retention/Adoption pages mark all of these unavailable (verified in source).

### 4.3 Proposed — [P]

**P0 (definition first, before any number):** Rayern team documents the activation definition against real product flows — candidate: *a workspace that has created ≥1 client AND ≥1 project/deliverable step within 14 days of registration* (the dashboard must not pick this unilaterally; the spec requires a documented definition).

**P1-A: `activity_events` collection (Rayern):**

```js
{ userId, workspaceId, type, at }   // type whitelist:
// 'client.created' | 'project.created' | 'task.created' | 'deliverable.created' |
// 'deliverable.submitted' | 'review.completed' | 'meeting.scheduled' |
// 'followup.created' | 'file.uploaded'
// + index on { at }, { userId, at }, { workspaceId, type, at }
// TTL optional; keep ≥ 400 days for D30 cohorts
```

Written server-side inside the existing controllers' success paths (single helper, fire-and-forget, never blocks the request). No sensitive payload content — ids and types only.

**P1-B: aggregates in the metrics payload (Rayern):**

```jsonc
"engagement": {
  "dau": 23, "wau": 61, "mau": 140,
  "newVsReturning": { "new": 8, "returning": 15 },        // per day, last day in window
  "retention": [
    { "cohort": "2026-09", "size": 84, "d1": 0.61, "d7": 0.34, "d30": null,
      "d30Complete": false }                              // immature cohorts → null, never a number
  ],
  "activation": { "definition": "workspace_with_client_and_project_within_14d",
                  "activated": 47, "rate": 0.398, "medianHoursToActivation": 31.5,
                  "registeredNotActivated": 71 },
  "onboarding": { "completed": 52, "incomplete": 66, "rate": 0.441 }
}
```

Rules: cohorts whose observation window has not elapsed must return `null` for that day-N (`d30Complete: false`); timezone = UTC (matches `registrationsTrend`); every rate is `null` when its denominator is 0.

**Dashboard-side work (after P1):** wire Overview/Funnels/Retention/Adoption/Reports to the new blocks; keep current unavailable panels as fallback when a block is absent (sync payload version-tolerant — new keys must be `.optional()` in `SyncPayload`).

---

## 5. Waitlist email marketing

### 5.1 Existing — [E] (verified end-to-end)

**Waitlist service** (standalone Express + Mongoose; env `PORT`, `MONGO_URI`, `FRONTEND_URL`, `ADMIN_TOKEN`):

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/` | none | — | `{success, message:"Rayern API is running."}` |
| POST | `/api/waitlist` | none, 10/15 min/IP | `{email}` | 201 `{success,code:"VERIFICATION_SENT"}` · 409 `ALREADY_VERIFIED` · 400 `EMAIL_REQUIRED|INVALID_EMAIL` · 500 `EMAIL_SEND_FAILED` |
| GET | `/api/waitlist/verify/:token` | none, 5/15 min | token (SHA-256 hashed, 30-min TTL) | 200 `EMAIL_VERIFIED` · 400 `INVALID_TOKEN` |
| POST | `/api/waitlist/resend` | none, 5/15 min + 30 s cooldown | `{email}` | 200 generic · 429 `RESEND_COOLDOWN` |
| **GET** | **`/api/waitlist/admin/list`** | **`x-admin-token` vs `ADMIN_TOKEN` (SHA-256 timing-safe)** | none (no pagination) | 200 (below) · 401 `UNAUTHORIZED` · 500 `ADMIN_LIST_FAILED` |

```json
{ "success": true, "data": { "total": 341, "signups": [
  { "_id": "…", "email": "a@example.com", "verified": true,
    "verifiedAt": "…Z", "lastVerificationSentAt": "…Z",
    "joinedAt": "…Z", "createdAt": "…Z", "updatedAt": "…Z" } ] } }
```

(`verificationToken`/`verificationTokenExpires` are projected out by the service.)

**Rayern backend proxy — [E]:** `GET /api/v1/admin/waitlist` (`requireAuth` + `requireAdmin`, `src/routes/adminRoutes.js` → `getWaitlist` in `src/controllers/adminController.js`): server-side `fetch(WAITLIST_API_URL + "/api/waitlist/admin/list")` with header `x-admin-token: WAITLIST_ADMIN_TOKEN`; returns the same `{success,data:{total,signups}}`; `503 WAITLIST_NOT_CONFIGURED` when either env is unset; `502 WAITLIST_UNAVAILABLE` on upstream failure.

### 5.2 Dashboard gaps — [M]

1. **No waitlist route in the dashboard backend** (`server/src/routes/rayernAdmin.ts` proxies only `/admin/users` and `/admin/campaigns/*`). Verified: no `waitlist` string anywhere in `client/src` or `server/src/routes`.
2. **No pagination** on the service (full dump; fine for hundreds, unsafe at scale).
3. **No consent field.** `Waitlist` model = email + verification state only. `verified: true` is double opt-in *for the waitlist*, **not** marketing consent — Rayern's consent model explicitly forbids inferring consent.
4. **Critical for the Send Email modal:** Rayern's campaign service skips unknown external addresses (`unknown_address`) and only sends to known users with `marketingConsent.optedIn === true`. **Waitlist emails therefore cannot be reached by any existing campaign audience selector** — `manual_emails` will skip them. A waitlist campaign audience must be implemented server-side; frontend filters alone are not authorization.

### 5.3 Proposed — [P]

**P0-A (dashboard backend):** proxy route — `GET /api/v1/admin/waitlist?page&limit&verified` on the dashboard, forwarded to Rayern's existing endpoint using the cached admin session (reuse `forwardToRayern`), guarded by dashboard `requireAuth` + `requireAdmin`, envelope passed through verbatim.

**P0-B (waitlist service + Rayern):** pagination params `?page=&limit=` (default 50, max 100) returning `{success,data:{total,page,limit,signups:[…]}}` — backward compatible (keep `total`).

**P0-C (decision required before any waitlist campaign):** add to `Waitlist` model:

```js
marketingConsent: { optedIn: {type:Boolean, default:false}, consentedAt: Date,
                    updatedAt: Date, source: {type:String, enum:[null,'signup_form','settings']} }
```

collect the opt-in checkbox on `POST /api/waitlist` (body field `marketingOptIn`, default `false` — never pre-checked), and expose it in the admin list. Then Rayern adds audience selector `{ "type": "waitlist" }` resolved **inside the send call** with per-recipient consent revalidation, exactly like §5.1 of the billing contract. Without P0-C the honest answer is: waitlist campaigns are not permitted.

**Dashboard UI:** Send Email modal gains a "Waitlist audience" option fed by the new proxy; recipient counts come from Rayern's preview endpoint; consent legend displayed from the waitlist consent fields.

---

## 6. Feedback

### 6.1 Existing — [E] (Rayern, verified)

`POST /api/v1/feedback` — `requireAuth`, `feedbackLimiter` **5/15 min**, delivered via EmailJS (`EMAILJS_*` env; `503 EMAIL_NOT_CONFIGURED` when unset).

Request: `{ feedbackType, message, workspaceName? }`
`feedbackType ∈ {"General feedback","Feature request","Bug report","Something is confusing"}`; `message` trimmed, 1–5000 chars.
Responses: `200 {success,data:{message:"Thanks — your feedback has been sent."}}` · `400 INVALID_FEEDBACK_TYPE | MESSAGE_REQUIRED | MESSAGE_TOO_LONG` · `502 EMAIL_DELIVERY_FAILED` · `503 EMAIL_NOT_CONFIGURED`.

**Nothing is stored.** There is no Feedback collection, no admin retrieval, no pagination, no category normalization (free enum strings), no reviewed/resolved state, no unreviewed count. The dashboard's Feedback page therefore renders an UnavailablePanel with this exact requirement (verified in `client/src/pages/Feedback.tsx`).

### 6.2 Proposed — [P] (Rayern-side, admin-only)

```
POST   /api/v1/feedback            [E] unchanged — but ALSO persist a Feedback document
GET    /api/v1/admin/feedback      [P] requireAuth+requireAdmin
       ?page=1&limit=50&category=&status=&sort=createdAt:desc
PATCH  /api/v1/admin/feedback/:id  [P] requireAuth+requireAdmin  { status: "reviewed"|"resolved"|"open" }
GET    /api/v1/admin/feedback/summary [P] requireAuth+requireAdmin
```

**Feedback document (minimal):**

```js
{ userId, workspaceId?, category, message, status: 'open'|'reviewed'|'resolved',
  createdAt, updatedAt, reviewedAt?, source: 'app_form' }
// index: { status, createdAt }, { category, status }
// NO password/token fields ever; message is customer content — list stays admin-only,
// excluded from exports and from any aggregate analytics.
```

**Example list response:**

```json
{ "success": true, "data": {
  "pagination": { "page": 1, "limit": 50, "totalResults": 37, "totalPages": 1 },
  "filters": { "category": "Feature request", "status": "open" },
  "items": [ { "id": "…", "category": "Feature request",
               "message": "…", "status": "open",
               "createdAt": "…Z", "updatedAt": "…Z",
               "user": { "id": "…", "email": "a@example.com" } } ] } }
```

(`user` projection: id + email only, and only because admins already see both via `/admin/users`.)

**Summary response (Overview unreviewed count):**

```json
{ "success": true, "data": { "open": 12, "reviewed": 9, "resolved": 16,
  "byCategory": [ { "category": "Bug report", "count": 7 } ],
  "lastSubmittedAt": "…Z" } }
```

**Dashboard-side work:** new `GET /feedback`, `PATCH /feedback/:id`, `GET /feedback/summary` passthroughs in `rayernAdmin.ts` (reusing the proxy session), a `feedbackService`, and replacing the Feedback UnavailablePanel with the list/summary UI (pagination + category/status filters + mark-reviewed action with confirmation). Consent/authorization remain Rayern's.

---

## 7. Existing metrics the dashboard consumes (inventory)

| Dashboard consumer | Endpoint / channel | Auth | Status |
|---|---|---|---|
| Overview KPIs, Acquisition, Retention cohorts, Metrics page | pull-sync ← Rayern `GET /internal/dashboard-metrics` | Bearer monitoring token | [E] |
| Same payload, browser path | dashboard `metricsRouter` re-exposes contract paths | dashboard admin JWT / monitoring token | [E] |
| System page sync card | dashboard `GET /system` (`getSyncStatus`) | dashboard admin JWT | [E] |
| Users page | dashboard proxy → Rayern `GET /api/v1/admin/users` | proxy session JWT (admin) | [E] |
| Email recipient selection / send | dashboard proxy → Rayern `POST /api/v1/admin/campaigns/preview|send` | proxy session JWT; send additionally `campaignSendLimiter` | [E] |
| Revenue page | `billing` block of sync payload (`billingService.current()`) | — | [E] (unavailable until first sync) |
| Marketing consent KPIs (dashboard's *own* accounts) | dashboard `GET /marketing/metrics|directory|consent` (Postgres `accounts` + `marketing_consent`) | dashboard admin JWT | [E] — **separate data plane from Rayern consent** |
| Email usage / history | dashboard `GET /emails/*` (Resend, dashboard's own sends) | dashboard admin JWT | [E] |
| Activity page | dashboard `GET /audit` (dashboard-originated audit events only) | dashboard admin JWT | [E] — Rayern product activity is *not* shown (by design) |
| Errors / Observability / System | dashboard `GET /errors`, `/observability/*`, `/system` (dashboard's own telemetry + `Rayern Sync` error rows) | dashboard admin JWT | [E] |
| Workspaces page | sync `workspaces` block + dashboard `GET /workspaces` | dashboard admin JWT | [E] |
| Waitlist list | — | — | **[M]** (Rayern endpoint exists, no dashboard route — §5) |
| Feedback list / summary | — | — | **[M]** (no storage anywhere — §6) |
| Product adoption (workspace module usage) | — | — | **[M]** (collections exist, no aggregate endpoint — §7.1) |
| Rayern consent aggregates for campaign KPIs | derivable only by paging `/admin/users` | — | **[M]** (P0-B below) |
| Acquisition attribution, visitors, funnels, activation, retention | — | — | **[M]** (§3–§4) |
| Application logs | — | — | **[M]** (§2.3) |

### 7.1 Proposed adoption + consent blocks (Rayern, P0)

Add two optional blocks to the metrics payload (same endpoint, zero plumbing change on the dashboard):

```jsonc
"adoption": {
  "measuredAt": "…Z",
  "modules": [
    { "module": "clients",      "workspacesUsing": 74, "workspacePct": 0.60, "totalObjects": 812 },
    { "module": "leads",        "workspacesUsing": 31, "workspacePct": 0.25, "totalObjects": 240 },
    { "module": "projects",     "workspacesUsing": 66, "workspacePct": 0.53, "totalObjects": 390 },
    { "module": "tasks",        "workspacesUsing": 62, "workspacePct": 0.50, "totalObjects": 1502 },
    { "module": "deliverables", "workspacesUsing": 40, "workspacePct": 0.32, "totalObjects": 271 },
    { "module": "meetings",     "workspacesUsing": 22, "workspacePct": 0.18, "totalObjects": 96 },
    { "module": "followups",    "workspacesUsing": 18, "workspacePct": 0.14, "totalObjects": 74 },
    { "module": "notifications","workspacesUsing": 118,"workspacePct": 0.95, "totalObjects": 4130 }
  ],
  "workspacesNoUsage": 12
}
```

Rules: `workspacesUsing` = distinct workspaces with ≥1 document of that module **ever** (workspace-level, not object-level — `totalObjects` is the separate object count); percentages use `totalWorkspaces` denominator; every number is a count query, consistent with the existing privacy contract (no ids, no names).

```jsonc
"consent": { "optedIn": 14, "optedOut": 109, "unknown": 0, "measuredAt": "…Z" }
```

(counts over `User.marketingConsent.optedIn`; `unknown` = never touched — the three must sum to `totalAccounts`.)

Dashboard-side: `SyncPayload` gains `.optional()` blocks; Adoption page and campaign KPI cards consume them; absent block → existing unavailable panel.

---

## 8. Prioritized missing backend work

### P0 — required for pages that already exist in the dashboard

| # | Change | Repo | Notes |
|---|---|---|---|
| 1 | Persist feedback + `GET /api/v1/admin/feedback`, `PATCH /:id`, `GET /summary` | **Rayern-backend** | §6.2; keeps `POST /feedback` behavior, adds storage |
| 2 | Dashboard proxy routes for feedback (`/api/v1/admin/feedback*`) | **Dashboard** | reuse `forwardToRayern`, `requireAuth`+`requireAdmin` |
| 3 | `GET /api/v1/admin/waitlist` passthrough in dashboard `rayernAdmin.ts` | **Dashboard** | §5.3 P0-A; Rayern endpoint already exists |
| 4 | Waitlist pagination `?page&limit` | **Waitlist service** (+ Rayern passthrough params) | §5.3 P0-B |
| 5 | `adoption` + `consent` blocks in metrics payload; `SyncPayload` optional parse | **Rayern-backend** + **Dashboard** | §7.1; unblocks Adoption page + campaign consent KPIs |
| 6 | Documented activation definition (decision, not code) | **Rayern team** | blocks all activation numbers |

### P1 — required for acquisition / activation / retention / funnel pages

| # | Change | Repo |
|---|---|---|
| 7 | `activity_events` instrumentation + `engagement` metrics block (DAU/WAU/MAU, D1/D7/D30 with immature-cohort `null`s) | Rayern-backend |
| 8 | Onboarding completion tracking (fields + definition) → `onboarding` sub-block | Rayern-backend |
| 9 | Attribution capture (UTM/referrer) + `signup-intent` event + `funnel` block | Rayern-frontend + Rayern-backend |
| 10 | Admin users search/date filters (`q`, `createdFrom/To`) + passthrough in dashboard proxy + dashboard Users UI | Rayern-backend + Dashboard |
| 11 | Waitlist consent model (`marketingConsent` on Waitlist, opt-in checkbox) + `{type:"waitlist"}` campaign audience with server-side revalidation | Waitlist service + Rayern-backend |

### P2 — observability and scale

| # | Change | Repo |
|---|---|---|
| 12 | `endpointHealth` matrix (method × route, status classes, latency) in metrics payload | Rayern-backend |
| 13 | Bounded admin-only log store + `GET /internal/logs` + dashboard System-page passthrough | Rayern-backend + Dashboard |
| 14 | `X-Request-Id` correlation through error envelopes and telemetry rows | Rayern-backend |
| 15 | `dependencyConfig` booleans (resend/emailjs/paystack/cloudinary/waitlist) | Rayern-backend |
| 16 | Visitor analytics provider (self-hosted Plausible/Umami or Vercel API) → unlocks visitor funnel stage | decision + Rayern-frontend |
| 17 | Deletion accounting so `deletedAccounts30d`/`deletionRequestsPending` stop being `null` (or dashboard labels them permanently unavailable) | Rayern-backend |

---

## 9. Explicit non-changes (guardrails for the combined implementation)

- The **30-minute** sync interval and every Rayern rate limiter in §1.4 stay exactly as they are; metrics endpoints keep their deliberate rate-limit exemption (auth still enforced).
- No endpoint, field or status above is invented for *existing* behavior — everything marked [E] was read from source in this audit; everything [P] is a proposal requiring Rayern-side implementation first.
- No secrets, tokens, headers, PII or log bodies may enter the metrics channel, the dashboard database, or any export; the existing Zod strip-unknown contract stays the privacy boundary.
- Dashboard never talks to the waitlist service or Rayern from the browser; all new flows go through server-side proxies with server-held credentials.
