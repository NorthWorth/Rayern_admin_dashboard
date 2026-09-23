/**
 * Instrumentation layer — creates OpenTelemetry spans AND the matching
 * aggregate-only local records that feed the dashboard's own telemetry tables.
 *
 * Covered (per spec):
 *  - incoming HTTP requests  → SERVER spans, route templates (never raw URLs)
 *  - PostgreSQL operations   → CLIENT spans, sanitized SQL templates (never parameters)
 *  - internal operations     → INTERNAL spans (e.g. rayern.sync)
 *  - external HTTP requests  → CLIENT spans (e.g. rayern.fetch, resend.send)
 *
 * Explicitly never recorded: Authorization/JWT/cookies/keys, request or
 * response bodies, emails, user/workspace identifiers, query strings, or SQL
 * parameters. Redaction is enforced by sanitize.ts and asserted by
 * telemetryTest.ts.
 */
import type { Attributes, Span } from '@opentelemetry/api'
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api'
import type { RequestHandler, Request } from 'express'
import { Pool } from 'pg'
import { config } from '../config'
import { otelTracer, isSuppressed } from './otel'
import { recordDb, recordHttp, recordOperation } from './store'
import { isPersisting, recordLocalSpan, type LocalSpanKind } from './persist'
import { sanitizeErrorMessage, sanitizeSql, sqlOperation, sqlTable } from './sanitize'

/** Valid parent span id from the active context, or null (never all-zeros). */
function activeParentSpanId(): string | null {
  const parent = trace.getSpan(context.active())
  if (!parent) return null
  const ctx = parent.spanContext()
  if (!ctx.traceId || /^0+$/.test(ctx.spanId)) return null
  return ctx.spanId
}

/* ------------------------------ HTTP server -------------------------------- */

/**
 * Route/template label for telemetry — the matched Express route when there
 * is one (`/users/:id/body`), otherwise a fixed `unmatched` bucket. Raw
 * paths (which can embed identifiers) are never used.
 */
export function routeLabel(req: Request): string {
  const route = (req as unknown as { route?: { path?: unknown } }).route
  const base = req.baseUrl ?? ''
  if (route && typeof route.path === 'string') {
    const p = route.path
    if (p === '/') return base || '/'
    return `${base}${p}`
  }
  return 'unmatched'
}

/**
 * Returns a label getter that reads the route template + mount prefix captured
 * at the exact moment Express assigns `req.route`.
 *
 * Why capture early: when a handler error unwinds to the app-level error
 * handler, Express restores `req.baseUrl` to '' (router/index.js `done`/
 * restore path) before the response closes — reading the label at `close`
 * would then lose the mount prefix (e.g. `/emails/:id/body` → `/:id/body`).
 * Capturing on assignment happens inside the mounted router where baseUrl is
 * still correct. Only the template and prefix are captured — never raw paths,
 * query strings, or params.
 */
export function installRouteCapture(req: Request): () => string {
  let capturedPath: unknown
  let capturedBase = ''
  let assigned = false
  try {
    let routeValue: unknown = (req as unknown as { route?: unknown }).route
    Object.defineProperty(req, 'route', {
      configurable: true,
      enumerable: true,
      get(): unknown {
        return routeValue
      },
      set(value: unknown) {
        routeValue = value
        assigned = true
        capturedBase = req.baseUrl ?? ''
        capturedPath =
          value !== null && typeof value === 'object' && 'path' in (value as object)
            ? (value as { path?: unknown }).path
            : undefined
      },
    })
  } catch {
    /* best effort: fall back to reading the live values */
  }
  return () => {
    if (assigned && typeof capturedPath === 'string') {
      if (capturedPath === '/') return capturedBase || '/'
      return `${capturedBase}${capturedPath}`
    }
    return routeLabel(req)
  }
}

/**
 * First Express middleware: spans every request (including preflight, static
 * assets, 401s and 404s) and establishes the active span so downstream work
 * (pg queries, handlers) becomes its children — proper trace relationships.
 */
export function httpTelemetry(): RequestHandler {
  return (req, res, next) => {
    if (!config.telemetry.enabled) {
      next()
      return
    }
    const parentSpanId = activeParentSpanId()
    const routeOf = installRouteCapture(req)
    const span = otelTracer().startSpan('request', { kind: SpanKind.SERVER })
    const ctx = trace.setSpan(context.active(), span)
    const t0 = performance.now()
    let ended = false

    const finish = (): void => {
      if (ended) return
      ended = true
      const durationMs = performance.now() - t0
      const route = routeOf()
      const operation = `${req.method} ${route}`
      const statusCode = res.statusCode
      try {
        span.updateName(operation)
        span.setAttribute('http.request.method', req.method)
        // Route template only — the query string is never read (it can carry
        // search terms / emails) and raw paths can carry identifiers.
        span.setAttribute('http.route', route)
        span.setAttribute('http.response.status_code', statusCode)
        if (!res.writableEnded) span.setAttribute('dashboard.request.aborted', true)
        span.setStatus(
          statusCode >= 500
            ? { code: SpanStatusCode.ERROR, message: `HTTP ${statusCode}` }
            : { code: SpanStatusCode.OK },
        )
        span.end()
      } catch {
        /* telemetry must never break request handling */
      }
      try {
        const spanCtx = span.spanContext()
        recordHttp({
          method: req.method,
          route,
          statusCode,
          durationMs,
          traceId: /^0+$/.test(spanCtx.traceId) ? null : spanCtx.traceId,
        })
        recordLocalSpan({
          traceId: spanCtx.traceId,
          spanId: spanCtx.spanId,
          parentSpanId,
          service: 'dashboard-api',
          operation,
          kind: 'server',
          startMs: Date.now() - Math.round(durationMs),
          durationMs,
          statusCode,
          hasError: statusCode >= 500,
        })
      } catch {
        /* recording must never break request handling */
      }
    }
    // 'close' fires for both normal completion and aborted connections.
    res.on('close', finish)

    context.with(ctx, next)
  }
}

/* -------------------------------- PostgreSQL -------------------------------- */

let pgPatched = false

/**
 * Patches `pg.Pool.prototype.query` (the same single choke point the official
 * OpenTelemetry pg instrumentation uses) so every query — through `query()`,
 * `pool.query`, sync worker, auth, bootstrap — gets one CLIENT span with a
 * sanitized statement. Parameters never leave the driver.
 *
 * Callback-style calls and suppressed contexts (telemetry persistence) pass
 * through untouched, so writing telemetry can never generate telemetry.
 */
export function patchPgPool(): void {
  if (pgPatched) return
  pgPatched = true

  const proto = Pool.prototype as unknown as { query: (...args: unknown[]) => unknown }
  const original = proto.query

  proto.query = function patchedQuery(this: Pool, ...args: unknown[]): unknown {
    if (!config.telemetry.enabled) return original.apply(this, args)
    const last = args[args.length - 1]
    if (typeof last === 'function') return original.apply(this, args) // callback style: not used here
    if (isSuppressed() || isPersisting()) return original.apply(this, args)

    const first = args[0]
    const sql = typeof first === 'string' ? first : typeof first === 'object' && first !== null && typeof (first as { text?: unknown }).text === 'string' ? (first as { text: string }).text : ''
    const verb = sqlOperation(sql)
    const table = sqlTable(sql)
    const operation = table ? `${verb} ${table}` : verb
    const parentSpanId = activeParentSpanId()

    const span = otelTracer().startSpan('db.query', {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system': 'postgresql',
        'db.operation.name': verb,
        // Sanitized template: literals → ?, parameters ($1) carry no values.
        'db.query.text': sanitizeSql(sql),
      },
    })
    const t0 = performance.now()
    const startMs = Date.now()

    const finish = (ok: boolean, errorCode: string | null, errorMessage: string | null): void => {
      const durationMs = performance.now() - t0
      try {
        if (ok) {
          span.setStatus({ code: SpanStatusCode.OK })
        } else {
          if (errorCode) span.setAttribute('db.error.code', errorCode.slice(0, 16))
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage ?? 'database error' })
        }
        span.end()
      } catch {
        /* never break the query path */
      }
      try {
        recordDb({ operation, durationMs, ok })
        const spanCtx = span.spanContext()
        recordLocalSpan({
          traceId: spanCtx.traceId,
          spanId: spanCtx.spanId,
          parentSpanId,
          service: 'postgres',
          operation,
          kind: 'client',
          startMs: startMs,
          durationMs,
          statusCode: 0,
          hasError: !ok,
        })
      } catch {
        /* never break the query path */
      }
    }

    let result: unknown
    try {
      result = original.apply(this, args)
    } catch (err) {
      finish(false, errCodeOf(err), sanitizeErrorMessage(errorMessageOf(err)))
      throw err
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          finish(true, null, null)
          return value
        },
        (err: unknown) => {
          finish(false, errCodeOf(err), sanitizeErrorMessage(errorMessageOf(err)))
          throw err
        },
      )
    }
    finish(true, null, null)
    return result
  }
}

function errCodeOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return null
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/* ------------------------- Generic span helper ----------------------------- */

export interface SpanSpec {
  name: string
  kind: SpanKind
  /** Component label stored in trace_spans / service_telemetry. */
  service: string
  /** Operation label; defaults to `name`. */
  operation?: string
  attributes?: Attributes
  /** Derives the HTTP-style status code from a successful result (e.g. res.status). */
  statusFrom?: (value: unknown) => number
  /** Decides whether a successful result should mark the span as an error. */
  okFrom?: (value: unknown) => boolean
}

/**
 * Runs `fn` inside a properly parented OpenTelemetry span, records the
 * aggregate-only local record on completion, and rethrows failures with a
 * sanitized error attribute (never `recordException` — driver/provider
 * messages can embed values).
 *
 * When telemetry is disabled the span is the API's no-op span and no local
 * record is stored — `fn` still runs normally.
 */
export async function withSpan<T>(spec: SpanSpec, fn: (span: Span) => Promise<T>): Promise<T> {
  const parentSpanId = activeParentSpanId()
  const span = otelTracer().startSpan(spec.name, { kind: spec.kind, attributes: spec.attributes })
  const ctx = trace.setSpan(context.active(), span)
  const t0 = performance.now()
  const startMs = Date.now()

  const record = (ok: boolean, statusCode: number, errorMessage: string | null): void => {
    const durationMs = performance.now() - t0
    try {
      if (ok) span.setStatus({ code: SpanStatusCode.OK })
      else {
        if (errorMessage) span.setAttribute('error.message', errorMessage)
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage ?? 'operation failed' })
      }
      span.end()
    } catch {
      /* never break the operation */
    }
    if (!config.telemetry.enabled) return
    try {
      const spanCtx = span.spanContext()
      const operation = spec.operation ?? spec.name
      recordLocalSpan({
        traceId: spanCtx.traceId,
        spanId: spanCtx.spanId,
        parentSpanId,
        service: spec.service,
        operation,
        kind: kindLabel(spec.kind),
        startMs,
        durationMs,
        statusCode,
        hasError: !ok,
      })
      // Rolling service window + slow-operation stats for this operation.
      recordOperation({ service: spec.service, operation, durationMs, ok })
    } catch {
      /* never break the operation */
    }
  }

  try {
    const value = await context.with(ctx, () => fn(span))
    const statusCode = spec.statusFrom ? spec.statusFrom(value) : 0
    const ok = spec.okFrom ? spec.okFrom(value) : true
    record(ok, statusCode, ok ? null : `completed with status ${statusCode}`)
    return value
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as { status?: number }).status) : 0
    record(false, Number.isFinite(status) ? status : 0, sanitizeErrorMessage(errorMessageOf(err)))
    throw err
  }
}

function kindLabel(kind: SpanKind): LocalSpanKind {
  if (kind === SpanKind.SERVER) return 'server'
  if (kind === SpanKind.CLIENT) return 'client'
  return 'internal'
}
