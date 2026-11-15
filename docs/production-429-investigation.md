# Production 429 investigation — Rayern server-to-server dashboard requests

Scope: investigation only. No application code or configuration was changed.

## 1. Verified findings

- **Render fronts every web service with Cloudflare.** Render's DDoS protection routes all inbound traffic through Cloudflare's network before it reaches the app (`render.com/docs/ddos-protection`, `render.com/articles/how-render-handles-ddos-attacks`). The `server: cloudflare` header and `cf-ray` on both captured responses are consistent with this; they do **not** by themselves prove a Cloudflare challenge or a DDoS event.
- **Render documents inbound 429 causes** (`render.com/docs/troubleshooting-deploys`, 429 tab): (a) the app's own rate limiter, (b) Render mitigating a DDoS attack, (c) a free service hitting Render's lower inbound rate limits, (d) Render's REST API rate limits, (e) an app rate limiter counting Render's health checks.
- **Free Render web services spin down after 15 minutes of no inbound traffic** and take ~1 minute to wake; paid plans do not spin down (`render.com/docs/free`). Free services also have materially lower inbound rate limits.
- **Render's DDoS protection is automatic and free** for every service; Render does not bill for attack traffic.
- **Cloudflare challenge pages** are documented to carry `cf-mitigated: challenge` (the only valid value), `content-type: text/html`, and a `cf-ray` (`developers.cloudflare.com/cloudflare-challenges/.../detect-response`). They are issued by WAF custom rules, rate-limiting rules, WAF managed rules, Bot Fight Mode, HTTP DDoS protection, IP access rules, user-agent blocking, country blocks, high threat score, IP reputation, and Browser Integrity Check.
- **Bot Fight Mode (free)** can challenge API/mobile traffic and **cannot be bypassed with WAF Skip rules**; exceptions require Super Bot Fight Mode (Pro+) or an IP Access Allow rule for a fixed egress IP (`developers.cloudflare.com/bots/get-started/bot-fight-mode`).
- **Cloudflare challenges require JavaScript + cookies** and cannot be solved by a server-to-server client.

## 2. Captured response patterns (from production diagnostics)

Pattern 1 — plain text:
- `server: cloudflare`, `x-render-routing: hibernate-rate-limited`, `content-type: text/plain; charset=utf-8`, body `Too Many Requests`.

Pattern 2 — HTML challenge:
- `server: cloudflare`, `content-type: text/html; charset=UTF-8`, body starts `Just a moment...`, includes Cloudflare challenge scripts and `cf-ray`.

Example Render request id: `5b36b81b-a9ef-4565`.

## 3. Ranked explanations (confidence)

1. **(High) Pattern 2 is a Cloudflare challenge issued to automated traffic.** The body/`cf-mitigated: challenge` signature matches Cloudflare's documented challenge page. Server-to-server clients (no JS/cookies) cannot pass it, so it surfaces as a hard failure. Most likely triggers: Bot Fight Mode, a WAF managed rule, or HTTP DDoS protection reacting to a datacenter source IP / default User-Agent / request shape. The dashboard's requests originate from a server egress IP with no browser-like fingerprint, which is exactly what Bot Fight Mode targets.
2. **(Medium-High) Pattern 1 is a Render-side hibernation/rate-limit response on a free or spinning-down service.** The `x-render-routing: hibernate-rate-limited` value is not documented in Render's public docs (no official definition found), but the naming and the free-tier spin-down behavior strongly imply the request hit the wake-up/activator path or Render's lower free-tier inbound limit while the service was spun down or waking. This would also explain why responses arrive with a plain-text body and no Cloudflare challenge markup.
3. **(Medium) Both patterns may share an edge cause but are separate rejection paths.** Both traverse Render's Cloudflare edge, but Pattern 1 lacks `cf-mitigated: challenge` and Pattern 2 has it. They are best treated as two distinct mechanisms with distinct remediation, not one.
4. **(Low for `/internal/dashboard-metrics`) Express application limiter.** Prior inspection placed `/internal/dashboard-metrics` outside `/api` and before the known API limiter, and no Express limiter is known to cover it. Not verified for `/internal/synthetic-monitoring`. Also possible: an app limiter counting Render health checks (documented Render cause), but that would not produce `x-render-routing: hibernate-rate-limited` or a Cloudflare challenge page.

## 4. What is NOT established

- Whether Rayern runs on a free or paid Render plan (determines spin-down and inbound limit applicability).
- Which Cloudflare product/rule produced Pattern 2 (Bot Fight Mode vs managed rule vs DDoS vs WAF custom rule). Cannot be determined from headers alone; needs the Ray ID in Cloudflare Security Events.
- Whether Render or Cloudflare is the origin of Pattern 1. `x-render-routing` is a Render-injected header, but the exact component and threshold are undocumented publicly.
- Whether the dashboard's 30-minute cadence or synthetic-monitoring calls actually coincide with service wake-ups or bursts; needs timestamp correlation.
- Whether Express ever receives these requests. The earlier heuristic (`reachedApplication`) is insufficient; needs Render application logs keyed by request id.

## 5. Missing evidence needed to confirm the cause

- Render service plan/instance type and whether the service is free (spin-down applies).
- Render application logs for request id `5b36b81b-a9ef-4565` and surrounding ids: did Express handle them (status, route, duration) or did they stop at the edge?
- Render metrics: request rate, wake-up events, deploy/restart times around the 429s.
- Cloudflare Security Events for the domain (via Render's managed Cloudflare? or the customer's own Cloudflare if a custom domain is in front): filter by the captured `cf-ray` values and read the **Service** field (Bot Fight Mode / custom rule / managed rule / DDoS / Browser Integrity Check).
- Exact dashboard egress IP, User-Agent, and request headers sent to Rayern.
- Whether `/internal/synthetic-monitoring` is also registered outside the `/api` limiter.
- Correlation of dashboard pull timestamps (every 30 min) with the 429 timestamps and service idle windows.

## 6. Safest corrective action (no code/config changes yet)

1. **Gather the missing evidence first** (plan, logs, Security Events, request metadata). Do not disable protections preemptively.
2. **If Rayern is on a free Render plan**, upgrading to a paid instance type removes spin-down and raises inbound limits. This is the lowest-risk infrastructure change and does not weaken security. It directly addresses Pattern 1 if hibernation/rate-limiting is the cause.
3. **For Pattern 2 (Cloudflare challenge)**, do not attempt to "solve" challenges from the server. Instead, identify the exact product via the Ray ID in Security Events, then:
   - If Bot Fight Mode: it cannot be skipped with WAF rules on the free tier. Options are an IP Access **Allow** rule for the dashboard's fixed egress IP, or upgrading to Super Bot Fight Mode (Pro) to create a scoped Skip rule for the dashboard IP/path, or fronting the internal endpoints through a non-challenged path.
   - If a WAF custom rule or rate-limit rule: add a narrowly scoped Skip/Allow rule matching the dashboard's egress IP + path + presence of the monitoring token, not a broad disable.
   - If HTTP DDoS protection: tune thresholds or add an allow rule for the known client IP; do not disable DDoS protection.
4. **Make the dashboard client well-behaved**: stable, descriptive User-Agent; fixed egress IP if possible; keep exponential backoff with jitter; treat `cf-mitigated: challenge` and 429 as distinct, non-retryable-without-change conditions rather than blindly retrying.
5. **Do not** disable Cloudflare bot protection, Browser Integrity Check, or DDoS protection globally, and do not assume Express is responsible.

## 7. Conclusion

The evidence supports **two separate rejection paths**: a Render-side hibernation/inbound-rate-limit response (Pattern 1) and a Cloudflare challenge to automated traffic (Pattern 2). The most actionable next step is to upgrade a free Render service (if applicable) and to use the captured `cf-ray` values to identify the exact Cloudflare product behind Pattern 2, then apply a scoped allow/skip rule for the dashboard's egress IP rather than disabling protections. Origin of Pattern 1 and the specific Cloudflare rule behind Pattern 2 remain unconfirmed pending the evidence in section 5.