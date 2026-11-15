import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

export interface RequestContext {
  correlationId: string
  updateBatchId?: string
  method: string
  path: string
  startedAt: number
}

const storage = new AsyncLocalStorage<RequestContext>()

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return null
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming =
    firstHeader(req.headers['x-correlation-id']) ||
    firstHeader(req.headers['x-request-id']) ||
    randomUUID()
  const updateBatchId = firstHeader(req.headers['x-update-batch-id']) || undefined
  const ctx: RequestContext = {
    correlationId: incoming.slice(0, 128),
    updateBatchId: updateBatchId?.slice(0, 128),
    method: req.method,
    path: req.originalUrl || req.url,
    startedAt: Date.now(),
  }
  ;(req as Request & { correlationId?: string }).correlationId = ctx.correlationId
  res.setHeader('x-correlation-id', ctx.correlationId)

  const loggable =
    req.path.startsWith('/rayern') ||
    req.path.startsWith('/system') ||
    req.path.startsWith('/observability') ||
    req.path.startsWith('/platform-metrics') ||
    req.path.startsWith('/marketing') ||
    req.path.startsWith('/users') ||
    req.path.startsWith('/workspaces') ||
    req.path.startsWith('/audit') ||
    req.path.startsWith('/errors') ||
    req.path.startsWith('/emails') ||
    req.path === '/api/v1/admin/metrics' ||
    req.path === '/internal/dashboard-metrics'

  storage.run(ctx, () => {
    if (loggable) {
      res.on('finish', () => {
        const durationMs = Date.now() - ctx.startedAt
        const extra = ctx.updateBatchId ? ` updateBatchId=${ctx.updateBatchId}` : ''
        console.log(
          `[request] cid=${ctx.correlationId} ${ctx.method} ${ctx.path} -> ${res.statusCode} ${durationMs}ms${extra}`,
        )
      })
    }
    next()
  })
}

/** Safe destination string for logs (scheme+host+path only, no query secrets/tokens). */
export function safeOutboundDestination(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return '<invalid-url>'
  }
}

export function logOutboundRayern(event: {
  operation: string
  destination: string
  method?: string
  status?: number | null
  outcome: 'attempt' | 'success' | 'http_error' | 'network_error' | 'timeout' | 'skipped'
  error?: string | null
}): void {
  const ctx = getRequestContext()
  const cid = ctx?.correlationId ?? '-'
  const route = ctx ? `${ctx.method} ${ctx.path}` : '-'
  const parts = [
    `[outbound-rayern]`,
    `cid=${cid}`,
    `route="${route}"`,
    `op=${event.operation}`,
    `outcome=${event.outcome}`,
    `dest=${safeOutboundDestination(event.destination)}`,
  ]
  if (event.method) parts.push(`method=${event.method}`)
  if (event.status != null) parts.push(`status=${event.status}`)
  if (event.error) parts.push(`error=${JSON.stringify(String(event.error).slice(0, 300))}`)
  console.log(parts.join(' '))
}
