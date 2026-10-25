export async function startBillingBackend(port: number) {
  const app = await import('./emailer.js')
  return app.listen(port)
}

export async function startWebhooksBackend(port: number) {
  const app2 = await import('./emailUsage.js')
  return app2.listen(port)
}
