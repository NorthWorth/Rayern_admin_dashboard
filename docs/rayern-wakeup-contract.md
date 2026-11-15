# Rayern-side wake-and-push contract (Dashboard receiver already implemented)

The Dashboard repository now exposes a push-ingestion endpoint and a wake-up
trigger scheduler. Rayern (separate repository, not in this workspace) must
implement the counterpart described here. Until it does, the Dashboard keeps
the legacy pull sync available as a fallback
(`RAYERN_PULL_FALLBACK_ENABLED=1`).

## Endpoints Rayern must implement

### 1. `POST /internal/dashboard-wakeup` (or configured `RAYERN_WAKEUP_ENDPOINT`)

- Lightweight, authenticated. Auth: `Authorization: Bearer <RAYERN_MONITORING_TOKEN>`
  (the same monitoring token the dashboard already sends).
- Must wake the Render Free service if asleep and return HTTP 202 (or 200)
  within ~10s. Do **not** generate the full snapshot synchronously in this
  request; instead enqueue a background push job.
- Must be idempotent: duplicate triggers (within a short window) must not
  start overlapping push jobs.
- Must never echo credentials or include them in logs/responses.
- On cold start, Render holds the request until the service wakes (~1 min);
  the dashboard trigger timeout is 90s to accommodate this.

### 2. Rayern → Dashboard push

Rayern POSTs the full snapshot to:

```
POST /internal/dashboard/rayern-snapshot
Authorization: Bearer <RAYERN_SNAPSHOT_TOKEN>
Content-Type: application/json
```

`RAYERN_SNAPSHOT_TOKEN` is a dedicated secret configured on both sides
(Dashboard env `RAYERN_SNAPSHOT_TOKEN`; Rayern env the same value).

#### Payload shape

Either a bare snapshot object or the `{ success: true, data: <snapshot> }`
envelope (the dashboard unwraps both). The snapshot must contain:

```json
{
  "snapshotId": "<unique id, e.g. rayern-<timestamp>-<random>>",
  "generatedAt": "2026-...Z",
  "accounts": { ... } | null,
  "workspaces": { ... } | null,
  "billing": { ... } | null,
  "services": [ ... ],
  "telemetry": { ... },
  "funnel": { ... } | null,
  "clientErrors": { ... } | null,
  "endpointHealth": { ... } | null,
  "dependencyConfig": { ... } | null,
  "syntheticMonitoring": { ... } | null,
  "productAdoption": { ... } | null,
  "marketingConsent": { ... } | null,
  "engagement": { ... } | null
}
```

- `snapshotId` is required and must be unique per delivery (used for
  idempotency — a repeat delivery of the same id is a no-op success).
- All aggregate fields follow the existing `/internal/dashboard-metrics`
  contract (`SyncPayload` in `server/src/rayernSync.ts`); Zod strips unknown
  fields, so only the documented aggregates may be sent.
- `null` (upstream aggregation failed) and absent (not sent) are distinct and
  must be preserved — never send `{}` as a placeholder.

#### Retry behavior (Rayern side)

- On non-2xx from the dashboard: retry with exponential backoff + jitter.
- Respect `Retry-After` when present.
- Cap total retries (e.g. 5) and abandon with a logged failure rather than
  looping; the next scheduled trigger will retry.
- Handle dashboard cold starts (Render Free) — the POST may need ~1 min;
  use a timeout ≥ 90s.
- Prevent overlapping push jobs (a single-flight guard).

#### Dashboard ingestion guarantees

- Authenticates with `RAYERN_SNAPSHOT_TOKEN` (fail-closed while unset).
- Validates the complete payload against the explicit schema; malformed
  snapshots are rejected with 400 and recorded.
- Idempotent by `snapshotId`.
- Persists aggregates via the same storage path as the legacy pull sync, so
  existing read APIs and frontend contracts are unchanged.
- Tracks delivery status in `rayern_ingestion_status` and `rayern_snapshots`.
- Never allows arbitrary database updates — only the documented aggregate
  sections are written.

## Dashboard endpoints added/changed

- `POST /internal/dashboard/rayern-snapshot` — new ingestion endpoint.
- `GET /rayern/snapshot-status` — admin-only ingestion status.
- `GET /internal/dashboard-metrics` and `GET /api/v1/admin/metrics` — retained.
- Pull sync (`RAYERN_SYNC_ENDPOINT`) — retained as temporary fallback.

## Environment variables (Dashboard)

- `RAYERN_SNAPSHOT_TOKEN` — dedicated push secret.
- `RAYERN_WAKEUP_ENDPOINT` / `RAYERN_TRIGGER_ENDPOINT` — Rayern wake trigger URL.
- `RAYERN_WAKEUP_INTERVAL_MS` — 1–2h (default 3600000).
- `RAYERN_TRIGGER_TIMEOUT_MS` — default 90000.
- `RAYERN_PULL_FALLBACK_ENABLED` — opt-in legacy pull sync.
EOF
echo done