/**
 * Production must never boot on the in-memory development database.
 *
 * These tests exercise the guard directly (it reads process.env, so no module
 * reload is needed and no database connection is opened).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let originalNodeEnv: string | undefined
let originalDatabaseUrl: string | undefined

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV
  originalDatabaseUrl = process.env.DATABASE_URL
})

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabaseUrl
})

async function guard(): Promise<() => void> {
  vi.resetModules()
  const db = await import('../db')
  return db.assertProductionDatabaseConfigured
}

describe('assertProductionDatabaseConfigured', () => {
  it('throws a clear, actionable error in production without DATABASE_URL', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.DATABASE_URL
    const assertConfigured = await guard()
    expect(() => assertConfigured()).toThrow(/DATABASE_URL is required in production/)
    expect(() => assertConfigured()).toThrow(/in-memory development database/)
  })

  it('treats a blank DATABASE_URL as missing', async () => {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = '   '
    const assertConfigured = await guard()
    expect(() => assertConfigured()).toThrow(/DATABASE_URL is required/)
  })

  it('passes in production when DATABASE_URL is set', async () => {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = 'postgres://user:pass@db.example.com:5432/rayern'
    const assertConfigured = await guard()
    expect(() => assertConfigured()).not.toThrow()
  })

  it('allows the embedded development database outside production', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.DATABASE_URL
    const assertConfigured = await guard()
    expect(() => assertConfigured()).not.toThrow()
  })
})
