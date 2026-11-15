import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import cors from 'cors'
import type { Server } from 'node:http'
import { buildCorsOptions } from '../cors'

const PRODUCTION_ORIGIN = 'https://admin.rayern.com.ng'

let server: Server
let baseUrl: string

beforeAll(async () => {
  const app = express()
  // Same order as server/src/index.ts: CORS (and its preflight handling)
  // runs before authentication and every route handler.
  app.use(cors(buildCorsOptions([PRODUCTION_ORIGIN])))
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next()
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  })
  app.get('/system/overview', (_req, res) => {
    res.json({ ok: true })
  })

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

describe('CORS policy', () => {
  it('allows the production origin with the tracing header on preflight', async () => {
    const res = await fetch(`${baseUrl}/system/overview`, {
      method: 'OPTIONS',
      headers: {
        Origin: PRODUCTION_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-correlation-id,authorization,content-type',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(PRODUCTION_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')

    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    expect(allowed).toContain('x-correlation-id')
    // Existing headers must stay allowed.
    expect(allowed).toContain('authorization')
    expect(allowed).toContain('content-type')
    expect(allowed).toContain('accept')

    const methods = res.headers.get('access-control-allow-methods') ?? ''
    expect(methods).toContain('GET')
    expect(methods).toContain('POST')
    expect(methods).toContain('PATCH')
    expect(methods).toContain('DELETE')
  })

  it('keeps credentials enabled without echoing a wildcard origin', async () => {
    const res = await fetch(`${baseUrl}/system/overview`, {
      method: 'OPTIONS',
      headers: {
        Origin: PRODUCTION_ORIGIN,
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('attaches CORS headers to authenticated-route responses for the allowed origin', async () => {
    // No Authorization header: the auth gate answers 401, but CORS must still
    // let the browser read that response instead of hiding it as a CORS error.
    const res = await fetch(`${baseUrl}/system/overview`, {
      headers: { Origin: PRODUCTION_ORIGIN, 'x-correlation-id': 'test-correlation' },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe(PRODUCTION_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('rejects a disallowed origin without granting access', async () => {
    const res = await fetch(`${baseUrl}/system/overview`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-correlation-id',
      },
    })
    expect(res.status).not.toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('includes the production frontend origin in the production allow-list', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousOrigins = process.env.CORS_ORIGINS
    process.env.NODE_ENV = 'production'
    delete process.env.CORS_ORIGINS
    vi.resetModules()
    try {
      const { config } = await import('../config')
      expect(config.corsOrigins).toContain(PRODUCTION_ORIGIN)
      expect(config.corsOrigins).not.toContain('*')
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      if (previousOrigins !== undefined) process.env.CORS_ORIGINS = previousOrigins
      vi.resetModules()
    }
  })
})
