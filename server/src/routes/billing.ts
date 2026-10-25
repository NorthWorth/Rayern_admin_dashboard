import { Router } from 'express'
import { auth } from '../auth'
import { billingService } from '../billingService'
import type { BillingQuery } from '../lib/api'

export const billingRouter = Router()

billingRouter.get('/api/billing', auth, async (req, res) => {
  try {
    const period = (req.query.period as BillingQuery['period']) ?? 'current'
    const body = await billingService.forPeriod(period)
    res.json(body)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal billing error'
    res.status(500).json({ error: message })
  }
})

billingRouter.post('/api/billing/estimate', auth, async (req, res) => {
  try {
    const { tier, period } = req.body as { tier?: string; period?: string }
    if (!tier || !period) {
      res.status(400).json({ error: 'tier and period are required' })
      return
    }
    const applied = await billingService.applyEstimate({ tier, period })
    res.json(applied)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal billing estimate error'
    res.status(500).json({ error: message })
  }
})
