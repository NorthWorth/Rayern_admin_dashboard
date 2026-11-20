/**
 * Independent Rayern snapshot scheduler.
 *
 * Flow: this service → authenticated Rayern wake endpoint → Rayern generates
 * its aggregate snapshot → Rayern pushes it to the dashboard → the dashboard
 * validates and persists it → the dashboard frontend reads local data.
 *
 * This service never stores customer data, never computes metrics and never
 * talks to the dashboard's frontend.
 */
import path from 'node:path'
import { config, schedulerConfigured } from './config.js'
import { SnapshotScheduler } from './scheduler.js'
import { FileStateStore } from './state.js'
import { createWakeFn } from './wake.js'
import { startStatusServer } from './server.js'

async function main(): Promise<void> {
  if (!schedulerConfigured()) {
    console.error(
      '[scheduler] refusing to start: RAYERN_WAKEUP_ENDPOINT and RAYERN_MONITORING_TOKEN must both be set. ' +
        'The service will not run a half-configured schedule.',
    )
    process.exitCode = 1
    return
  }

  const lockPath = `${config.statePath}.lock`
  const scheduler = new SnapshotScheduler({
    endpoint: config.wakeEndpoint,
    token: config.monitoringToken,
    intervalMs: config.intervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
    lockPath,
    lockTtlMs: config.lockTtlMs,
    historyLimit: config.historyLimit,
    runOnStart: config.runOnStart,
    wake: createWakeFn(),
    store: new FileStateStore(path.resolve(config.statePath)),
  })

  const server = await startStatusServer(config.port, config.host, () => ({
    state: scheduler.getState(),
    configured: schedulerConfigured(),
    intervalMs: config.intervalMs,
    running: false,
    statusToken: config.statusToken,
  }))

  console.log(
    `[scheduler] listening on ${config.host}:${config.port} · cadence ${Math.round(config.intervalMs / 60_000)}m · ` +
      `first run ${config.runOnStart ? 'immediately' : 'at the next interval'}`,
  )

  await scheduler.start()

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[scheduler] ${signal} received — shutting down gracefully`)
    await scheduler.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

void main()
