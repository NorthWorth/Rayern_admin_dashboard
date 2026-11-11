# Temporary Rayern-side request-arrival logging for `/internal/dashboard-metrics`

The Founder Dashboard now captures the full sanitized 429 body, every non-sensitive
response header, the final URL, the request start timestamp, the duration and the
request id, plus a best-effort `reachedApplication` flag, in
`rayern_sync_diagnostics` (surfaced in the System → "Rayern sync diagnostics" card).

To correlate one real production 429, Rayern must emit a matching arrival record.
Add the following **temporary** middleware to the Rayern Express app, mounted
**before** `requireMonitoringToken` on `/internal/dashboard-metrics`. It logs the
arrival and the final response status/duration and never logs the token.

```js
// TEMPORARY — remove after the 429 correlation is complete.
const DASHBOARD_METRICS_DEBUG = process.env.RAYERN_DEBUG_DASHBOARD_METRICS === '1'

if (DASHBOARD_METRICS_DEBUG) {
  app.use('/internal/dashboard-metrics', (req, res, next) => {
    const requestId =
      (req.headers['x-request-id'] || req.headers['x-correlation-id'] || '').toString() ||
      `rayern-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const arrivedAt = new Date().toISOString()
    console.log(JSON.stringify({
      service: 'rayern',
      evt: 'dashboard-metrics.arrival',
      requestId,
      arrivedAt,
      method: req.method,
      // Never log the token or the Authorization header value.
      hasAuthorization: Boolean(req.headers.authorization),
      ip: req.ip,
    }))
    res.on('finish', () => {
      console.log(JSON.stringify({
        service: 'rayern',
        evt: 'dashboard-metrics.response',
        requestId,
        arrivedAt,
        status: res.statusCode,
        durationMs: Date.now() - new Date(arrivedAt).getTime(),
      }))
    })
    next()
  })
}
```

## Correlation procedure

1. Set `RAYERN_DEBUG_DASHBOARD_METRICS=1` on Rayern and redeploy.
2. Trigger one dashboard pull (or wait for the next scheduled one) that returns 429.
3. In the dashboard System page, open the newest `Rayern sync diagnostics` entry:
   - note `startedAt`, `durationMs`, `requestId`, `finalUrl`, `reachedApplication`,
     and the full header set.
4. In Rayern's logs, find the matching `dashboard-metrics.arrival` line by
   `requestId` (and `arrivedAt` within `durationMs`).
   - If an arrival line exists **and** a `dashboard-metrics.response` line with
     status 429 follows it, the 429 originated **inside Express**.
   - If an arrival line exists but no response line (or a non-429 status), the
     response is being synthesized by middleware/edge before the handler runs.
   - If no arrival line exists for that `requestId`, the request never reached
     the Rayern Express application — the 429 came from an edge/proxy/infra
     layer in front of it.

## What is still unknown without the Rayern-side log

The dashboard alone cannot tell whether a 429 came from inside Express or from an
edge layer: both can return identical status codes and similar headers. The
`reachedApplication` flag on the dashboard record is only a header heuristic
(`X-Powered-By: Express` / `Server`), not proof. Do not label it a Render (or
any other provider) issue until the Rayern arrival log either confirms or rules
out an Express-side origin.
EOF