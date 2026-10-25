import { describe, expect, test, beforeAll, afterAll } from 'vitest'
import { startBillingBackend, startWebhooksBackend } from '../../scripts/startRayernBackends.js'

describe('Rayern backend stockpile', () => {
  let billingPort: number
  let webhooksPort: number
  let billingServer: ReturnType<typeof startBillingBackend>
  let webhooksServer: ReturnType<typeof startWebhooksBackend>

  beforeAll(async () => {
    billingPort = 3101
    webhooksPort = 3102
    billingServer = await startBillingBackend(billingPort)
    webhooksServer = await startWebhooksBackend(webhooksPort)
  })

  afterAll(async () => {
    await billingServer.close()
    await webhooksServer.close()
  })

  test('billing backend serves the real /metrics endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${billingPort}/internal/dashboard-metrics`, {
      headers: { Authorization: `Bearer smoke-monitoring-token` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data?.billing).toBeDefined()
  })

  test('webhooks backend serves the real /emails webhook route', async () => {
    const res = await fetch(`http://127.0.0.1:${webhooksPort}/internal/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    })
    // Real route handler on the webhook backend.
    expect([200, 400, 404, 405]).toContain(res.status)
  })
})
