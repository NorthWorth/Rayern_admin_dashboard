# Rayern snapshot scheduler

A small, independent service whose only job is to periodically initiate Rayern's
snapshot-generation workflow.

```text
scheduler (this service, every 2h)
  → POST Rayern /internal/dashboard-wakeup  (authenticated)
    → Rayern generates its aggregate snapshot
      → POST dashboard /internal/dashboard/rayern-snapshot  (authenticated)
        → dashboard validates, stores in one transaction, serves locally
```

It is **not** a second dashboard, it stores no customer data, it computes no
metrics, and it does not need the dashboard to be online in order to run.

## Responsibilities

- Configurable execution interval (default **two hours**).
- Durable execution history and scheduling state (JSON file with atomic replace;
  mount a persistent disk).
- One run at a time: an `O_EXCL` lock file prevents duplicate wakes across
  restarts/instances, with a stale-lock TTL after a crash.
- Retries only for transient failures (429, 5xx, timeout, network) with bounded
  exponential backoff and ±20% jitter, honouring `Retry-After`.
- Permanent failures (401/403/validation) are recorded and **not** retried.
- A failed run never advances `lastSuccessAt`.
- Structured, sanitised logs: no token, no Authorization header, no body dump.
- Graceful shutdown on SIGTERM/SIGINT.
- Read-only `/status` endpoint protected by a separate credential, plus an
  unauthenticated `/health`.

## First-run policy

`SCHEDULER_RUN_ON_START=0` (default) waits for the full interval, so a restart
never produces an immediate burst. If the stored `nextDueAt` is already in the
past (the service was down), exactly **one** catch-up run happens, never one per
missed slot.

## Render edge challenge

Automated requests to a public Render service can be answered by a
browser-oriented human-verification page (`challenge.html` / CAPTCHA-style).

This service **does not** attempt to solve, evade or bypass such a challenge.
When a response looks like an edge challenge (`text/html` body with challenge
markers, or `cf-mitigated`/`x-render-challenge` headers) it:

1. classifies the run as `challenge_blocked`,
2. records that the request did **not** reach the Rayern application,
3. stops automatic scheduling entirely instead of retrying in a loop,
4. surfaces the state on `/status` and therefore on the dashboard System page.

Resolution requires the hosting provider: an approved service-to-service route,
infrastructure configuration, or a policy change. Nothing in this repository can
legitimately bypass a human-verification challenge.

## Configuration

See [`env.example`](env.example). Required: `RAYERN_WAKEUP_ENDPOINT` and
`RAYERN_MONITORING_TOKEN`. The service refuses to start half-configured.

## Dashboard integration

The dashboard backend proxies `GET /system/scheduler` using
`SCHEDULER_STATUS_URL` + `SCHEDULER_STATUS_TOKEN`. The scheduler's status is
read-only and carries no credential to the browser. The scheduler cannot confirm
that a snapshot was ingested — that truth belongs to the dashboard's snapshot
status (`/rayern/snapshot-status`).

## Development

```bash
cd scheduler
bun install
bun run test        # classification, retries, lock, restart recovery
bun run typecheck
PORT=4100 bun run dev
```

## Migration from the dashboard-owned wake loop

1. Verify the scheduler can reach Rayern (status shows a real HTTP status and,
   where identifiable, that the application was reached).
2. Confirm a snapshot arrives (dashboard System → snapshot freshness).
3. Leave `RAYERN_DASHBOARD_WAKE_SCHEDULER` unset/0 so the dashboard does not
   also wake Rayern.
4. Recovery path: set `RAYERN_DASHBOARD_WAKE_SCHEDULER=1` and stop the
   scheduler. Never run both.
