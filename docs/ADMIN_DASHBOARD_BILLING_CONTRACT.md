# Rayern Admin Dashboard — Backend Integration Contract

This document is the API contract between the Rayern **Admin Dashboard**
(separate project) and the Rayern **App/Backend** (this repository). It covers
user/consent queries, campaign email, subscriber analytics, and the
rate-limit exemption for the metrics endpoint.

All paths are the **final mounted URLs** (origin + `/api/v1` prefix included
in examples as `https://rayern-backend.onrender.com`). The dashboard project
is NOT implemented here; nothing in this repo calls the dashboard.

---

## 1. Authentication model

Two independent mechanisms exist; both are enforced server-side. The
dashboard hiding a control is never authorization.

| Mechanism | Who | Header | Gates |
|---|---|---|---|
| Session admin | Browser dashboard logged in as an address listed in `ADMIN_EMAILS` | `Authorization: Bearer <access token>` (JWT from `/api/v1/auth/login`) | `/api/v1/admin/*` |
| Service token | Dashboard backend/server component | `Authorization: Bearer <RAYERN_MONITORING_TOKEN>` | `/internal/dashboard-metrics` |

`requireAdmin` rejects any authenticated user whose email is not in
`ADMIN_EMAILS` with `403 ADMIN_ACCESS_REQUIRED`; unauthenticated callers get
`401`. `ADMIN_EMAILS` is a comma-separated env var, lowercased on compare.

Error envelope (all endpoints):

```json
{ "success": false, "error": { "code": "MACHINE_CODE", "message": "Human text" } }
```

Validation errors add `error.fields: { fieldName: "message" }` (HTTP 400).

---

## 2. Metrics API

### 2.1 `GET /api/v1/admin/metrics` (session admin)

- Auth: `requireAuth` + `requireAdmin`. Never public.
- Query/body: none.
- **Rate limited: NO — exempt from every application limiter** (exact-path
  skip in `app.js`; see §7). Refresh freely.

### 2.2 `GET /internal/dashboard-metrics` (service token)

Same handler and same response as 2.1; mounted outside `/api` with
`requireMonitoringToken` (fail-closed: while `RAYERN_MONITORING_TOKEN` is
unset every request is rejected 401).

### 2.3 Response schema (both mounts)

```json
{
  "success": true,
  "data": {
    "accounts": {
      "totalAccounts": 123,
      "newAccounts30d": 12,
      "verifiedAccounts": 100,
      "unverifiedAccounts": 23,
      "deletedAccounts30d": null,
      "deletionRequestsPending": null,
      "registrationsTrend": [{ "date": "2026-10-01", "count": 3 }],
      "planBreakdown": [{ "plan": "starter", "count": 100 }]
    },
    "workspaces": {
      "totalWorkspaces": 120,
      "newWorkspaces30d": 11,
      "avgMembersPerWorkspace": 1.2
    },
    "billing": {
      "currency": "USD",
      "amountUnit": "minor_units",
      "generatedAt": "2026-10-22T12:00:00.000Z",
      "activePaidSubscribers": 14,
      "freeUsers": 109,
      "totalAccounts": 123,
      "mrr": {
        "amountMinor": 41320,
        "amountMajor": 413.2,
        "byPlan": [
          { "plan": "pro", "subscriberCount": 10, "mrrMinor": 19000 },
          { "plan": "premium", "subscriberCount": 4, "mrrMinor": 25280 }
        ]
      },
      "arr": { "amountMinor": 495840, "amountMajor": 4958.4, "definition": "mrr_x_12" },
      "planBreakdown": [
        { "plan": "pro", "userCount": 10, "subscriptionCount": 10, "isPaid": true },
        { "plan": "starter", "userCount": 109, "subscriptionCount": 0, "isPaid": false }
      ],
      "definitions": { "…": "see below" }
    },
    "services": [{ "service": "Rayern API", "kind": "api", "status": "healthy",
                   "uptimePct30d": null, "latencyMsP50": 41, "latencyMsP95": 120,
                   "lastIncidentAt": null }],
    "telemetry": { }
  }
}
```

### 2.4 Metric definitions (billing block)

- **Currency**: single settlement currency `PAYSTACK_CURRENCY` (currently
  USD). All amounts are **integer minor units** (`amountMinor`); `amountMajor`
  is the same value / 100 for display. Rayern has no multi-currency billing,
  so no cross-currency addition occurs and no conversion policy is needed.
- **Qualifying paid subscription**: a `Subscription` document whose plan is a
  paid plan (`pro`, `business`, `premium` — `starter` is free and never paid
  revenue) and whose status is one of `active`, `non_renewing`, `past_due`,
  AND which is either inside its current period or inside the billing grace
  window (`BILLING_GRACE_PERIOD_DAYS`, default 7, past `currentPeriodEnd`).
- **Excluded statuses**: `canceled`, `expired` (no current paid access).
- **Trials/beta**: Rayern's billing data contains no trial or beta
  arrangements; nothing sets `Workspace.subscriptionStatus = "trialing"` and
  no trial payment flow exists. No trial assumptions are made.
- **Active paid subscribers**: distinct workspace **owners** with ≥1
  qualifying paid subscription. A user with several paid workspaces counts
  once. This is a **user count**, not a subscription count.
- **MRR**: per qualifying user, take their single highest-paying plan;
  monthly plans contribute the plan's monthly amount, annual plans
  contribute `annualAmountMinor / 12` (rounded to whole minor units), which
  reflects the 20% annual discount. Null billing intervals (defensive only)
  are treated as monthly. One-time `Payment` rows are **never** counted.
- **ARR**: `MRR × 12` (`definition: "mrr_x_12"`). Rayern has no multi-year
  or usage-based contracts.
- **planBreakdown**: `userCount` = distinct paying users per paid plan (from
  the same de-duplicated assignment) plus one aggregate `starter` row for
  free users; `subscriptionCount` = qualifying subscription documents per
  plan (both counts labelled explicitly; they differ only in the
  multiple-workspaces edge case).
- Empty/honest data: with no subscriptions the block reports zeros plus the
  `definitions` object — values are never fabricated or hardcoded.

---

## 3. Marketing consent model

Authoritative record: `User.marketingConsent` sub-document.

| Field | Meaning |
|---|---|
| `optedIn` | current status; **defaults to `false` for every new account** |
| `consentedAt` | timestamp of the most recent affirmative opt-in (kept as history after opt-out) |
| `updatedAt` | timestamp of the most recent preference change |
| `source` | `settings` (user API) or `unsubscribe_link` (email link) |

Consent is never inferred from registration, ToS acceptance, payment, or
receipt of transactional email. Registration does not accept a consent
field at all.

Separation:

- **Transactional email** (verification, password reset, security notices,
  account welcome) — never gated on `optedIn`.
- **Promotional email** (upgrades, sales, discounts, campaigns) — only to
  users with `optedIn: true` and `status: "active"`, enforced server-side.

### 3.1 `GET /api/v1/marketing-consent` (any authenticated user, self only)

```json
{ "success": true, "data": { "consent": {
  "optedIn": true, "consentedAt": "2026-10-22T10:00:00.000Z",
  "updatedAt": "2026-10-22T10:00:00.000Z", "source": "settings" } } }
```

### 3.2 `PUT /api/v1/marketing-consent` (self only)

Body: `{ "optedIn": true | false }` (zod-validated; anything else → 400).
No user id is ever accepted — the target is always the caller. Returns the
same shape as 3.1.

### 3.3 `GET /api/v1/marketing-consent/unsubscribe?token=…` (token, no session)

The token is `userId.HMAC-SHA256(userId + ":marketing-unsubscribe")`
(base64url) signed with `JWT_ACCESS_SECRET`; every promotional email carries
this URL plus RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
A valid token can **only opt out** (idempotent). Invalid/tampered tokens →
`400 INVALID_UNSUBSCRIBE_TOKEN`. The dashboard should render
`${CLIENT_URL}/unsubscribe?token=…` as a branded confirmation page that
calls this endpoint (or simply links to it).

---

## 4. Admin user directory

### `GET /api/v1/admin/users` (requireAuth + requireAdmin)

Query parameters (all validated; invalid values → 400):

| Param | Values | Default |
|---|---|---|
| `page` | integer ≥ 1 | 1 |
| `limit` | integer 1–100 | 50 |
| `plan` | `starter` \| `pro` \| `business` \| `premium` (actual catalog) | all |
| `subscriptionStatus` | `none` (no Subscription doc) \| `active` \| `non_renewing` \| `past_due` \| `canceled` \| `expired` (actual model enum) | all |
| `consent` | `opted_in` \| `opted_out` | all |

Notes: `plan=starter` also matches legacy workspace rows (`free`, `agency`)
because they normalize to starter. `consent=opted_out` means
`optedIn === false` (includes never-touched accounts). Filters combine
(logical AND).

Response:

```json
{ "success": true, "data": {
  "pagination": { "page": 1, "limit": 50, "totalResults": 123, "totalPages": 3 },
  "filters": { "plan": "pro", "subscriptionStatus": null, "consent": "opted_in" },
  "currency": "USD",
  "users": [{
    "id": "652f…", "email": "user@example.com",
    "firstName": "Ada", "lastName": "Lovelace",
    "emailVerified": true, "accountStatus": "active",
    "createdAt": "2026-09-01T00:00:00.000Z",
    "marketingConsent": { "optedIn": true, "consentedAt": "…", "updatedAt": "…", "source": "settings" },
    "workspace": { "id": "…", "name": "Ada WS", "plan": "pro" },
    "subscription": { "plan": "pro", "status": "active", "billingInterval": "monthly",
                      "currentPeriodEnd": "2026-11-01T00:00:00.000Z",
                      "cancelAtPeriodEnd": false, "hasPaidAccess": true }
  }]
} }
```

`subscription.status: "none"` marks free accounts (no Subscription
document). `hasPaidAccess` mirrors live entitlement semantics (statuses
`active`/`non_renewing`/`past_due` plus the grace window). Passwords, hashes,
tokens and auth-lock fields are never serialized. Pagination exists so the
dashboard never needs the whole user table in memory.

---

## 5. Campaign email API

Server-side consent enforcement is unconditional. The dashboard's recipient
selection is a request, never an authorization.

### 5.1 Audience selector (shared by preview + send)

```json
{ "type": "all_eligible" }
```

```json
{ "type": "filters", "plan": "pro", "subscriptionStatus": "active" }
```

(`plan` / `subscriptionStatus` optional; same values as §4.)

```json
{ "type": "manual_emails", "emails": ["a@example.com", "b@example.com"] }
```

(1–500 addresses, email-validated, case-insensitively deduplicated.)

Eligibility rules (enforced in `campaignService`, not the dashboard):

1. Known Rayern users must be `marketingConsent.optedIn: true` AND
   `status: "active"` — checked when the audience is resolved **inside the
   send call** (a stored preview never authorizes a send) and re-checked
   immediately before each individual delivery (an unsubscribe landing
   mid-dispatch yields `consent_revoked_at_send`).
2. Manual addresses belonging to opted-out or suspended users are skipped
   (`not_opted_in` / `account_suspended`).
3. **Unknown external addresses are never treated as consented Rayern
   users** — skipped with `unknown_address`. Rayern cannot verify consent it
   never collected; the admin must use separate compliant tooling for
   pre-consented external lists.
4. Total recipients per campaign capped at 2000; overflow reported via the
   preview `capped` flag, never sent.

### 5.2 `POST /api/v1/admin/campaigns/preview` (requireAuth + requireAdmin)

Body: `{ "audience": <selector> }` (subject/body optional, unused).
Sends nothing; safe to repeat.

Response:

```json
{ "success": true, "data": {
  "audience": { "type": "all_eligible" },
  "eligibleCount": 14, "skippedCount": 2,
  "sizeCap": 2000, "capped": false,
  "preview": [{ "email": "a@example.com" }],
  "previewTruncated": false,
  "skipped": [{ "email": "x@external.test", "reason": "unknown_address" }]
} }
```

### 5.3 `POST /api/v1/admin/campaigns/send` (requireAuth + requireAdmin + campaignSendLimiter 10/15min)

Body:

```json
{ "subject": "…(≤200 chars)", "bodyHtml": "…(≤100 000 chars)",
  "bodyText": "optional", "audience": <selector>,
  "idempotencyKey": "optional-≥8-chars" }
```

Idempotency: the same key (body field or `Idempotency-Key` header) returns
the original campaign with `duplicate: true` and dispatches nothing
(enforced by a unique partial index — race-safe). **The dashboard SHOULD
send a key** (e.g. UUID per user click) to make double-submits harmless.

Response (`201` new, `200` duplicate):

```json
{ "success": true, "data": { "duplicate": false, "campaign": {
  "id": "…", "status": "completed", "subject": "…",
  "audience": { "type": "all_eligible" },
  "totals": { "resolved": 14, "accepted": 12, "failed": 0, "skipped": 2 },
  "accepted": [{ "email": "a@example.com", "providerMessageId": "…" }],
  "failed":  [{ "email": "b@example.com", "error": "…" }],
  "skipped": [{ "email": "c@external.test", "reason": "unknown_address" }],
  "startedAt": "…", "completedAt": "…", "createdAt": "…" } } }
```

Status vocabulary honesty: `accepted` means the provider (Resend) accepted
the message — **not** delivered. Rayern consumes no delivery/bounce webhooks,
so `delivered`/`bounced` cannot be reported and are never claimed. Campaign
`status`: `sending` → `completed` (all accepted) or
`completed_with_failures` (≥1 failed/skipped).

Provider failures: per-recipient errors are captured individually (partial
failure supported); an unconfigured provider fails fast with
`503 EMAIL_NOT_CONFIGURED` and creates no campaign record.

Audit: every campaign persists `createdBy` (admin user id), the audience
spec, per-recipient outcomes, and timestamps in the `EmailCampaign`
collection.

---

## 6. Welcome email

- **Trigger**: immediately after the `User` document is created inside
  `POST /api/v1/auth/register` (`authService.registerUser` →
  `dispatchWelcomeEmail`). It is a transactional account email — marketing
  consent is never consulted.
- **Idempotency**: `User.welcomeEmailSentAt` is claimed atomically before the
  provider call; a retried registration (409 duplicate email) or concurrent
  flow can never produce a second welcome. The claim is released on provider
  failure so the marker stays truthful.
- **Failure behavior**: fire-and-forget — a Resend outage can neither fail
  nor slow registration, and can never create a duplicate account.
- **Provider**: the existing Resend integration (`RESEND_API_KEY`,
  `FROM_EMAIL`). No secrets in frontend code or API responses.

---

## 7. Rate-limit behavior (metrics exemption proof)

Application-controlled limiters (all in this repo):

| Limiter | Mounted on | Limit | Exclusions |
|---|---|---|---|
| `generalLimiter` | `/api` | 200 / 15 min / IP | exact paths `/api/v1/admin/metrics`, prefix `/api/v1/webhooks/` |
| `feedbackLimiter` | `/api/v1/feedback` | 5 / 15 min | — |
| `credentialLimiter` | per auth route | 10 / 15 min | — |
| `sessionLimiter` | per auth route | 100 / 15 min | — |
| `uploadLimiter` | upload routes | 40 / 15 min | — |
| `publicReviewLimiter` | public review routes | 120 / 15 min | — |
| `campaignSendLimiter` | `/api/v1/admin/campaigns/send` | 10 / 15 min | — |

Exempt endpoints: `GET /api/v1/admin/metrics` (exact-path skip in
`generalLimiter.skip`; query strings stripped before comparison so
similarly-named paths are NOT exempt) and `GET /internal/dashboard-metrics`
(mounted outside `/api`, never crosses any limiter). Exemption covers rate
limiting ONLY — `requireAuth`/`requireAdmin`/`requireMonitoringToken` remain
fully enforced.

Regression proof: `server/src/scripts/admin-dashboard-smoke.mjs`
(`npm run test:admin-dashboard`) runs the real middleware stack and asserts:
210 admin requests to `/api/v1/admin/metrics` → 0 × 429; 210 requests to
`/internal/dashboard-metrics` → 0 × 429; unauthenticated metrics → 401;
non-admin metrics → 403; same client IP exhausting `/api/v1/admin/users`
→ 429 (other endpoints stay limited); `/api/v1/admin/metrics-extra` → 404
and still counted; campaign send → 429 past its budget; credential/session
limits covered by the pre-existing suites.

**Infrastructure limits are separate**: Cloudflare/Render may apply their
own per-IP limits outside this repository. No repo-level change removes
those; if 429s persist in production with these tests passing, check the
edge/platform layer (e.g. Cloudflare WAF rate-limiting rules or Render
request limits) and adjust there.

---

## 8. Environment variables for integration (names only — never commit values)

| Variable | Purpose |
|---|---|
| `ADMIN_EMAILS` | Comma-separated admin addresses for session-admin authorization |
| `RAYERN_MONITORING_TOKEN` | Service token for `/internal/dashboard-metrics` (fail-closed when unset) |
| `RESEND_API_KEY`, `FROM_EMAIL` | Email provider (welcome, reset, campaigns); campaign send fails fast with 503 when unset |
| `CLIENT_URL` | Frontend origin used in unsubscribe links |
| `PAYSTACK_CURRENCY` | Single settlement currency for all metric amounts |
| `BILLING_GRACE_PERIOD_DAYS` | Grace window used by metrics qualification and entitlements |
| `TRUST_PROXY` | Proxy hops; must stay correct or per-IP limits collapse |
| `JWT_ACCESS_SECRET` | Signs unsubscribe tokens (and sessions) |

Deployment: standard `npm ci && npm start` (Node ≥ 20). No new environment
variables were introduced by this work.

---

## 9. Dashboard implementation checklist (separate project)

1. Log in as an `ADMIN_EMAILS` user; store the access token; handle 401 by
   re-login (15-minute token TTL) and 403 as "not an admin".
2. Metrics card: poll `GET /api/v1/admin/metrics` freely (no 429 risk from
   the API). Render `billing.mrr.amountMajor` with `billing.currency`,
   `billing.arr`, `billing.activePaidSubscribers`, `billing.planBreakdown`.
   Handle `totalAccounts`/empty series for empty states; treat `null`
   telemetry fields as "unknown".
3. User directory: `GET /api/v1/admin/users` with `page`/`limit` and the
   `plan`/`subscriptionStatus`/`consent` filters; use `pagination` for
   paging; never request limit > 100.
4. Campaign flow: call `POST /api/v1/admin/campaigns/preview` first, show
   `eligibleCount` + `skipped` with human labels for the reason codes
   (`unknown_address`, `not_opted_in`, `account_suspended`), then submit
   `POST /api/v1/admin/campaigns/send` with a generated `idempotencyKey`;
   render `accepted`/`failed`/`skipped` from the response. Show `accepted`
   as "accepted by provider", never "delivered".
5. Consent UI (in the main app, not the dashboard): the app's
   marketing-consent endpoints are self-service only; the dashboard reads
   consent via `/admin/users`.
6. If the dashboard has a backend, either integrate
   `RAYERN_MONITORING_TOKEN` for `/internal/dashboard-metrics` or use the
   session-admin endpoint — both return identical payloads.
