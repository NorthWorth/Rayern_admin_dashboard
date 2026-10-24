import express from 'express'
import { metricsRouter } from './routes/metrics'
import { requireAuth } from './auth'

const app = express()
app.use(express.json())

// Internal service-token endpoint (mounted outside /api so it never crosses
// the application general limiter — the token guard is still enforced).
app.use(metricsRouter)

// Session-admin endpoint lives under /api/v1 per the contract.
app.use('/api/v1', requireAuth, metricsRouter)

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

export default app
