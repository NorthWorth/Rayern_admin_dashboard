/**
 * POST /auth/login — dashboard admin login.
 * Verifies bcrypt credentials and issues a short-lived JWT.
 */
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { query } from '../db'
import { rateLimit, signAdminToken } from '../auth'
import { recordAudit } from '../audit'

const router = Router()

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
})

router.post(
  '/login',
  rateLimit({ windowMs: 15 * 60_000, max: 10, key: 'login' }),
  async (req, res, next) => {
    try {
      const parsed = LoginBody.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'Email and password are required' })
        return
      }
      const { email, password } = parsed.data

      const rows = await query<{ id: string; name: string; email: string; password_hash: string; role: string }>(
        `SELECT id, name, email, password_hash, role FROM admin_users WHERE email = $1 LIMIT 1`,
        [email.toLowerCase()],
      )
      const admin = rows[0]
      const ok = admin ? await bcrypt.compare(password, admin.password_hash) : false
      if (!admin || !ok) {
        res.status(401).json({ error: 'Invalid email or password' })
        return
      }

      const token = signAdminToken({ sub: admin.id, email: admin.email, name: admin.name, role: admin.role })
      await recordAudit(admin.email, 'admin', 'admin.login', 'dashboard', { ip: req.ip ?? '' })
      res.json({ token, operator: { name: admin.name, email: admin.email, role: admin.role } })
    } catch (err) {
      next(err)
    }
  },
)

export default router
