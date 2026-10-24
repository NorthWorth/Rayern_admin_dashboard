import { startBillingBackend, startWebhooksBackend } from '../src/client.js'

export async function startAllBackends() {
  const billing = await startBillingBackend(3001)
  const webhooks = await startWebhooksBackend(3002)
  return { billing, webhooks }
}
