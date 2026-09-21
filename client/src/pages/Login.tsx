import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { Field, Input } from '../components/ui/Input'
import { login, session } from '../lib/api'

/**
 * Admin login against the dedicated dashboard backend.
 * Shown whenever there is no active admin session while the backend is
 * connected. Demo data mode does not require login.
 */
export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await login(email.trim(), password)
      session.set(res)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-ink-900">
            <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
              <path
                d="M9 23V9h6.2c2.9 0 4.8 1.7 4.8 4.2 0 1.9-1.1 3.3-2.9 3.9L21 23h-3.4l-3.2-5.4h-2.2V23H9zm3.2-7.9h2.6c1.4 0 2.3-.8 2.3-2s-.9-1.9-2.3-1.9h-2.6v3.9z"
                fill="#f7f8f9"
              />
              <circle cx="23.5" cy="9" r="2" fill="#35c08e" />
            </svg>
          </span>
          <div>
            <p className="text-sm font-semibold text-ink-900">Rayern Admin</p>
            <p className="text-[11px] uppercase tracking-widest text-ink-500">Operator console</p>
          </div>
        </div>

        <div className="rounded-lg border border-ink-200 bg-white p-6 shadow-sm">
          <h1 className="text-base font-semibold text-ink-900">Sign in</h1>
          <p className="mt-1 text-xs text-ink-500">Dashboard administrator access, provided by the dashboard API.</p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <Field label="Email">
              <Input
                type="email"
                name="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@rayern.com.ng"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>

            {error ? (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" disabled={submitting} className="w-full">
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-[11px] text-ink-400">
          Internal operator console. Activity is audit-logged.
        </p>
      </div>
    </div>
  )
}
