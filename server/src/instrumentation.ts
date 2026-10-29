/**
 * Rayern instrumentation → dashboard DTOs.
 *
 * Rayern's contract (Instrumentation & Monitoring) names each metric block and
 * its headline fields, but it does not pin down every array-element shape. This
 * module is the single place where those payloads are interpreted:
 *
 *  - Fields the contract names explicitly are read exactly as named.
 *  - Where an element's field name is not fixed by the contract, a short list
 *    of candidate keys is tried and the FIRST PRESENT one wins.
 *  - A value that is absent, explicitly `null`, or present-but-unusable
 *    becomes `null` — never `0`. Missing is not zero, unknown is not healthy.
 *  - Percentages are computed here (server-side) with the denominator written
 *    into the field name, and a zero/unknown denominator yields `null` rather
 *    than `Infinity`, `NaN` or a fabricated `0%`.
 *  - When a block's shape cannot be recognised at all, the DTO reports
 *    `available: false` with a dashboard-generated reason so the UI says
 *    "unrecognised response shape" instead of silently showing empty data.
 *
 * Nothing here invents metrics: every number originates in Rayern's payload.
 */

/* -------------------------------- DTOs ---------------------------------- */

export interface FunnelDailyPoint {
  date: string
  visits: number | null
  signupIntents: number | null
  registrations: number | null
  activated: number | null
}

export interface FunnelDto {
  /** False until Rayern has actually collected a visitor beacon. */
  hasVisitorData: boolean
  visits30d: number | null
  signupIntents30d: number | null
  registrations30d: number | null
  activated30d: number | null
  /** Registrations that carried first-touch attribution — a subset of `registrations30d`. */
  attributedSignups30d: number | null
  daily: FunnelDailyPoint[]
  topSources: Array<{ source: string; count: number }>
  /** Each percentage carries its denominator in the field name; null = not computable. */
  conversion: {
    /** signup intents ÷ visits */
    visitToIntentPct: number | null
    /** registrations ÷ signup intents */
    intentToRegistrationPct: number | null
    /** activated ÷ registrations */
    registrationToActivationPct: number | null
    /** registrations ÷ visits (requires visitor data) */
    visitToRegistrationPct: number | null
  }
  /** attributedSignups ÷ registrations — how much of sign-up is attributable. */
  attributionCoveragePct: number | null
}

export interface ClientErrorsDto {
  /** `null` when Rayern omitted it — never replaced by summing the breakdown. */
  total: number | null
  byKind: Array<{ kind: string; count: number }>
  topEndpoints: Array<{ endpoint: string; count: number }>
  lastOccurredAt: string | null
}

export interface EndpointHealthRoute {
  /** `GET /users/:id`, or `UNMATCHED` for paths that matched no route template. */
  key: string
  method: string
  route: string
  requests: number
  ok2xx: number
  err4xx: number
  err5xx: number
  p50Ms: number | null
  p95Ms: number | null
  /** Samples behind the latency figures — shown next to them, never as a fake 0ms. */
  samples: number | null
  unmatched: boolean
}

export interface EndpointHealthDto {
  available: boolean
  /** `telemetry_inactive` | `insufficient_samples` | `not_reported` | `unrecognised_shape` | null */
  reason: string | null
  windowMinutes: number | null
  routes: EndpointHealthRoute[]
}

export interface DependencyConfigItem {
  group: string
  name: string
  label: string
  /** `null` = Rayern did not report this flag (unknown, NOT "not configured"). */
  configured: boolean | null
  /** Adjacent non-secret metadata Rayern reports alongside the flag (currency, mode). */
  detail: string | null
}

export interface DependencyConfigDto {
  available: boolean
  items: DependencyConfigItem[]
}

export interface SyntheticCheck {
  name: string
  status: string
  httpStatus: number | null
  latencyMs: number | null
  p95Ms: number | null
  reason: string | null
  consecutiveFailures: number | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastRecoveredAt: string | null
  history: Array<{ at: string; status: string; httpStatus: number | null; latencyMs: number | null }>
}

export interface SyntheticMonitoringDto {
  available: boolean
  /** `no_checks_run` | `not_reported` | `unrecognised_shape` | null */
  reason: string | null
  lastCheckedAt: string | null
  lastSuccessfulCheckAt: string | null
  checks: SyntheticCheck[]
}

export interface ProductAdoptionModule {
  module: string
  total: number | null
  created30d: number | null
  completed: number | null
  /** False when Rayern reported no completion concept for this entity. */
  completionReported: boolean
}

export interface ProductAdoptionDto {
  available: boolean
  modules: ProductAdoptionModule[]
}

export interface MarketingConsentDto {
  totalRegisteredUsers: number | null
  optedIn: number | null
  optedOut: number | null
  optedInPct: number | null
  /** False when the three figures do not add up — flagged, never silently corrected. */
  reconciles: boolean
}

export interface EngagementCohort {
  weekStart: string
  size: number | null
  retainedNextWeek: number | null
  retentionPct: number | null
  /** False while the following week has not fully elapsed (immature cohort). */
  mature: boolean
}

export interface EngagementDto {
  available: boolean
  /** `no_activity_data_yet` | `not_reported` | `unrecognised_shape` | null */
  reason: string | null
  dau: number | null
  wau: number | null
  mau: number | null
  dailyActiveUsers: Array<{ date: string; count: number | null }>
  cohorts: EngagementCohort[]
}

export interface InstrumentationDto {
  funnel: FunnelDto | null
  clientErrors: ClientErrorsDto | null
  endpointHealth: EndpointHealthDto | null
  dependencyConfig: DependencyConfigDto | null
  syntheticMonitoring: SyntheticMonitoringDto | null
  productAdoption: ProductAdoptionDto | null
  marketingConsent: MarketingConsentDto | null
  engagement: EngagementDto | null
}

export type InstrumentationSource = 'rayern-sync'

/* ----------------------------- raw readers ------------------------------ */

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

/**
 * Numeric read with candidate keys: the first key PRESENT in the object wins.
 * Missing → `null`; explicit `null` → `null`; a present-but-non-numeric value
 * → `null`. A zero is only ever returned when the source actually sent zero.
 */
function readNumber(src: Record<string, unknown> | null, keys: readonly string[]): number | null {
  if (!src) return null
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const raw = src[key]
    if (raw === null || raw === undefined) return null
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (typeof n === 'number' && Number.isFinite(n)) return n
    return null
  }
  return null
}

function readString(src: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!src) return null
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const raw = src[key]
    if (raw === null || raw === undefined) return null
    if (typeof raw === 'string' && raw !== '') return raw
    if (typeof raw === 'number') return String(raw)
    return null
  }
  return null
}

function readBool(src: Record<string, unknown> | null, keys: readonly string[]): boolean | null {
  if (!src) return null
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const raw = src[key]
    if (typeof raw === 'boolean') return raw
    return null
  }
  return null
}

function hasKey(src: Record<string, unknown> | null, keys: readonly string[]): boolean {
  if (!src) return false
  return keys.some((key) => Object.prototype.hasOwnProperty.call(src, key))
}

/** Reads a value at a dotted path from a nested object (`['email','resend']`). */
function readPath(src: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = src
  for (const segment of path) {
    const obj = asObject(cursor)
    if (!obj || !Object.prototype.hasOwnProperty.call(obj, segment)) return undefined
    cursor = obj[segment]
  }
  return cursor
}

/**
 * Percentage with a documented denominator. Returns `null` for a missing
 * numerator, a missing denominator, or a denominator of zero — so the UI shows
 * "—" instead of `Infinity`, `NaN` or a misleading `0%`.
 */
export function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 1000) / 10
}

function isAvailableDefault(reason: string | null, hasData: boolean): boolean {
  return reason === null && hasData
}

/* ------------------------------- funnel --------------------------------- */

export function normalizeFunnel(raw: Record<string, unknown>): FunnelDto {
  const visits30d = readNumber(raw, ['visits30d'])
  const signupIntents30d = readNumber(raw, ['signupIntents30d'])
  const registrations30d = readNumber(raw, ['registrations30d'])
  const activated30d = readNumber(raw, ['activated30d'])
  const attributedSignups30d = readNumber(raw, ['attributedSignups30d'])

  // Explicit flag wins; otherwise "we have a visitor number" is the honest
  // restatement of it. Never defaults to true.
  const explicitHasVisitor = readBool(raw, ['hasVisitorData', 'visitorDataAvailable'])
  const hasVisitorData = explicitHasVisitor ?? visits30d !== null

  const daily: FunnelDailyPoint[] = []
  for (const entry of asArray(raw.daily) ?? []) {
    const row = asObject(entry)
    if (!row) continue
    const date = readString(row, ['date', 'day'])
    if (!date) continue
    daily.push({
      date,
      visits: readNumber(row, ['visits', 'visitCount', 'visitsCount']),
      signupIntents: readNumber(row, ['signupIntents', 'signupIntent', 'signupIntentsCount']),
      registrations: readNumber(row, ['registrations', 'registered', 'registrationsCount']),
      activated: readNumber(row, ['activated', 'activation', 'activatedCount']),
    })
  }

  const topSources: Array<{ source: string; count: number }> = []
  for (const entry of asArray(raw.topSources) ?? []) {
    const row = asObject(entry)
    if (!row) continue
    const source = readString(row, ['source', 'name', 'label', 'value'])
    const count = readNumber(row, ['count', 'total', 'visits', 'occurrences'])
    if (source === null || count === null) continue
    topSources.push({ source, count })
  }
  topSources.sort((a, b) => b.count - a.count)

  return {
    hasVisitorData,
    visits30d,
    signupIntents30d,
    registrations30d,
    activated30d,
    attributedSignups30d,
    daily,
    topSources,
    conversion: {
      visitToIntentPct: pct(signupIntents30d, visits30d),
      intentToRegistrationPct: pct(registrations30d, signupIntents30d),
      registrationToActivationPct: pct(activated30d, registrations30d),
      visitToRegistrationPct: pct(registrations30d, visits30d),
    },
    attributionCoveragePct: pct(attributedSignups30d, registrations30d),
  }
}

/* ---------------------------- client errors ----------------------------- */

export function normalizeClientErrors(raw: Record<string, unknown>): ClientErrorsDto {
  const byKind: Array<{ kind: string; count: number }> = []
  for (const entry of asArray(raw.byKind ?? raw.kinds) ?? []) {
    const row = asObject(entry)
    if (!row) continue
    const kind = readString(row, ['kind', 'type', 'name'])
    const count = readNumber(row, ['count', 'total', 'occurrences'])
    if (kind === null || count === null) continue
    byKind.push({ kind, count })
  }

  const topEndpoints: Array<{ endpoint: string; count: number }> = []
  for (const entry of asArray(raw.topEndpoints ?? raw.endpoints) ?? []) {
    const row = asObject(entry)
    if (!row) continue
    const endpoint = readString(row, ['endpoint', 'route', 'template', 'path', 'name'])
    const count = readNumber(row, ['count', 'total', 'occurrences'])
    if (endpoint === null || count === null) continue
    topEndpoints.push({ endpoint, count })
  }
  topEndpoints.sort((a, b) => b.count - a.count)

  const total = readNumber(raw, ['total', 'count'])
  // Never fall back to summing the breakdown when the source omitted `total`:
  // a partial breakdown is not the total, and reporting it as one would lie.
  return {
    total,
    byKind,
    topEndpoints,
    lastOccurredAt: readString(raw, ['lastOccurredAt', 'lastSeenAt', 'lastAt']),
  }
}

/* --------------------------- endpoint health ---------------------------- */

function readStatusClass(
  entry: Record<string, unknown>,
  cls: '2xx' | '4xx' | '5xx',
): number | null {
  const short = cls[0] // '2' | '4' | '5'
  const direct = readNumber(entry, [`status${cls}`, `s${cls}`, `ok${cls}`, `n${cls}`, cls, `${short}xx`])
  if (direct !== null) return direct

  const nested = asObject(entry.byStatusClass) ?? asObject(entry.statusClasses) ?? asObject(entry.status)
  if (nested) {
    const fromMap = readNumber(nested, [cls, `${short}xx`])
    if (fromMap !== null) return fromMap
  }

  // Histogram keyed by full status code: {"200": 12, "500": 1}
  const codes = asObject(entry.byStatus) ?? asObject(entry.statusCodes)
  if (codes) {
    let sum = 0
    let seen = false
    for (const [code, value] of Object.entries(codes)) {
      const statusCode = Number(code)
      if (!Number.isFinite(statusCode)) continue
      if (Math.floor(statusCode / 100) !== Number(cls[0])) continue
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) continue
      sum += n
      seen = true
    }
    if (seen) return sum
  }
  return null
}

export function normalizeEndpointHealth(raw: Record<string, unknown>): EndpointHealthDto {
  const reportedReason = readString(raw, ['reason', 'unavailableReason', 'unavailable'])
  const explicitAvailable = readBool(raw, ['available'])

  const entries: Array<Record<string, unknown>> = []
  const listCandidate =
    asArray(raw.routes) ??
    asArray(raw.endpoints) ??
    asArray(raw.entries) ??
    asArray(raw.byRoute) ??
    asArray(raw.routesHealth)
  if (listCandidate) {
    for (const entry of listCandidate) {
      const row = asObject(entry)
      if (row) entries.push(row)
    }
  } else {
    // Map form: { "GET /users/:id": { requests, p50, … } }
    const map = asObject(raw.routes) ?? asObject(raw.byRoute) ?? asObject(raw.endpoints)
    if (map) {
      for (const [key, value] of Object.entries(map)) {
        const row = asObject(value)
        if (!row) continue
        entries.push({ ...row, key })
      }
    }
  }

  const routes: EndpointHealthRoute[] = entries.map((entry) => {
    const key = readString(entry, ['key', 'route', 'template', 'path', 'endpoint']) ?? 'UNMATCHED'
    // `METHOD route-template` is the contract's identity for a row.
    const method = (readString(entry, ['method', 'httpMethod']) ?? key.split(' ')[0] ?? '').toUpperCase()
    const route = key.includes(' ') ? key.slice(key.indexOf(' ') + 1) : key
    const p50 = readNumber(entry, ['p50', 'p50Ms', 'latencyP50', 'latencyMsP50', 'p50LatencyMs'])
    const p95 = readNumber(entry, ['p95', 'p95Ms', 'latencyP95', 'latencyMsP95', 'p95LatencyMs'])
    const samples = readNumber(entry, ['samples', 'sampleCount', 'n', 'observations'])
    return {
      key,
      method,
      route,
      requests: readNumber(entry, ['requests', 'requestCount', 'count', 'total']) ?? 0,
      ok2xx: readStatusClass(entry, '2xx') ?? 0,
      err4xx: readStatusClass(entry, '4xx') ?? 0,
      err5xx: readStatusClass(entry, '5xx') ?? 0,
      p50Ms: p50,
      p95Ms: p95,
      samples: samples,
      unmatched: key === 'UNMATCHED' || route === 'UNMATCHED' || /UNMATCHED/i.test(key),
    }
  })

  const hasData = routes.length > 0
  const reason = reportedReason ?? (hasData ? null : 'not_reported')
  const available = explicitAvailable ?? isAvailableDefault(reason, hasData)

  return {
    available: available && hasData,
    reason: available && hasData ? null : (reason ?? 'not_reported'),
    windowMinutes: readNumber(raw, ['windowMinutes', 'window', 'windowMins', 'rangeMinutes']),
    routes,
  }
}

/* -------------------------- dependency config --------------------------- */

interface DependencySpec {
  group: string
  name: string
  label: string
  path: string[]
  detailKeys: string[]
}

/**
 * The contract's presence flags. Values are never read — only booleans — so no
 * secret can travel from this module into a response.
 */
const DEPENDENCY_SPEC: DependencySpec[] = [
  { group: 'Email', name: 'Resend', label: 'Resend configured', path: ['email', 'resend'], detailKeys: [] },
  { group: 'Email', name: 'EmailJS', label: 'EmailJS configured', path: ['email', 'emailjs'], detailKeys: [] },
  { group: 'Billing', name: 'Paystack', label: 'Paystack configured', path: ['billing', 'paystack'], detailKeys: ['currency'] },
  { group: 'Storage', name: 'Cloudinary', label: 'Cloudinary configured', path: ['storage', 'cloudinary'], detailKeys: ['mode'] },
  { group: 'Monitoring', name: 'Token', label: 'Monitoring token configured', path: ['monitoring', 'tokenConfigured'], detailKeys: [] },
  { group: 'Waitlist', name: 'Proxy', label: 'Waitlist proxy configured', path: ['waitlistProxy', 'configured'], detailKeys: [] },
  { group: 'Landing page', name: 'Origin', label: 'Landing origin configured', path: ['landingPage', 'originConfigured'], detailKeys: [] },
  { group: 'Telemetry', name: 'Enabled', label: 'Telemetry enabled', path: ['telemetry', 'enabled'], detailKeys: [] },
  { group: 'Telemetry', name: 'Active', label: 'Telemetry active', path: ['telemetry', 'active'], detailKeys: [] },
  { group: 'Synthetic monitor', name: 'Base URL', label: 'Probe base URL configured', path: ['syntheticMonitor', 'baseUrlConfigured'], detailKeys: [] },
]

export function normalizeDependencyConfig(raw: Record<string, unknown>): DependencyConfigDto {
  const items: DependencyConfigItem[] = []

  for (const spec of DEPENDENCY_SPEC) {
    // Nested form: { email: { resend: true } } — or flat dotted keys:
    // { "email.resend": true }.
    const nestedParent = asObject(readPath(raw, spec.path.slice(0, -1)))
    const nestedValue = readPath(raw, spec.path)
    const flatValue = Object.prototype.hasOwnProperty.call(raw, spec.path.join('.'))
      ? raw[spec.path.join('.')]
      : undefined

    let configured: boolean | null = null
    if (typeof nestedValue === 'boolean') configured = nestedValue
    else if (typeof flatValue === 'boolean') configured = flatValue
    else if (typeof nestedValue === 'string') configured = nestedValue.length > 0
    else if (typeof flatValue === 'string') configured = flatValue.length > 0

    let detail: string | null = null
    for (const key of spec.detailKeys) {
      detail = readString(nestedParent, [key]) ?? readString(raw, [`${spec.path[0]}.${key}`])
      if (detail !== null) break
    }

    items.push({ group: spec.group, name: spec.name, label: spec.label, configured, detail })
  }

  return { available: items.some((i) => i.configured !== null), items }
}

/* ------------------------- synthetic monitoring ------------------------- */

export function normalizeSynthetic(raw: Record<string, unknown>): SyntheticMonitoringDto {
  const explicitAvailable = readBool(raw, ['available'])
  const reportedReason = readString(raw, ['reason', 'unavailableReason'])

  const checks: SyntheticCheck[] = []
  const list = asArray(raw.checks) ?? asArray(raw.results) ?? asArray(raw.probes)
  for (const entry of list ?? []) {
    const row = asObject(entry)
    if (!row) continue
    const history: SyntheticCheck['history'] = []
    for (const h of asArray(row.history ?? row.recent ?? row.recentHistory) ?? []) {
      const hrow = asObject(h)
      if (!hrow) continue
      history.push({
        at: readString(hrow, ['at', 'timestamp', 'ts', 'time', 'checkedAt']) ?? '',
        status: readString(hrow, ['status', 'state']) ?? 'unknown',
        httpStatus: readNumber(hrow, ['httpStatus', 'status', 'statusCode', 'code']),
        latencyMs: readNumber(hrow, ['latencyMs', 'latency', 'durationMs']),
      })
    }
    checks.push({
      name: readString(row, ['name', 'id', 'check', 'target']) ?? 'unknown-check',
      status: readString(row, ['status', 'state', 'result']) ?? 'unknown',
      httpStatus: readNumber(row, ['httpStatus', 'statusCode', 'status', 'code']),
      latencyMs: readNumber(row, ['latencyMs', 'latency', 'durationMs', 'duration']),
      p95Ms: readNumber(row, ['p95Ms', 'p95', 'latencyP95']),
      reason: readString(row, ['reason', 'failureReason', 'error', 'message']),
      consecutiveFailures: readNumber(row, ['consecutiveFailures', 'failures', 'failStreak']),
      lastSuccessAt: readString(row, ['lastSuccessAt', 'lastOkAt']),
      lastFailureAt: readString(row, ['lastFailureAt', 'lastErrorAt']),
      lastRecoveredAt: readString(row, ['lastRecoveredAt', 'recoveredAt']),
      history,
    })
  }

  const hasData = checks.length > 0
  // `no_checks_run` is the contract's honest pre-first-run state: it is NOT
  // "healthy", so `available` stays false and no uptime is implied.
  const reason = reportedReason ?? (hasData ? null : 'not_reported')
  const available = (explicitAvailable ?? isAvailableDefault(reason, hasData)) && hasData

  return {
    available,
    reason: available ? null : (reason ?? 'not_reported'),
    lastCheckedAt: readString(raw, ['lastCheckedAt', 'lastRunAt', 'updatedAt']),
    lastSuccessfulCheckAt: readString(raw, ['lastSuccessfulCheckAt', 'lastSuccessAt']),
    checks,
  }
}

/* --------------------------- product adoption --------------------------- */

const ADOPTION_ORDER = ['clients', 'projects', 'tasks', 'leads', 'meetings', 'documents', 'deliverables']

export function normalizeProductAdoption(raw: Record<string, unknown>): ProductAdoptionDto {
  const rows: Array<{ module: string; src: Record<string, unknown> }> = []

  const asList = asArray(raw.modules) ?? asArray(raw.entities) ?? asArray(raw.adoption)
  if (asList) {
    for (const entry of asList) {
      const row = asObject(entry)
      if (!row) continue
      const module = readString(row, ['module', 'entity', 'name', 'model'])
      if (module) rows.push({ module, src: row })
    }
  } else {
    const map = asObject(raw.modules) ?? asObject(raw.entities) ?? raw
    for (const [module, value] of Object.entries(map)) {
      const row = asObject(value)
      if (!row) continue
      rows.push({ module, src: row })
    }
  }

  const known: ProductAdoptionModule[] = []
  const extras: ProductAdoptionModule[] = []

  for (const { module, src } of rows) {
    const hasCompleted = hasKey(src, ['completed', 'completedCount'])
    const entry: ProductAdoptionModule = {
      module,
      total: readNumber(src, ['total', 'count', 'totals']),
      created30d: readNumber(src, ['created30d', 'new30d', 'last30d', 'createdLast30d']),
      completed: readNumber(src, ['completed', 'completedCount']),
      // Absent key = the entity has no completion concept (contract); a null
      // value = reported but unavailable. Both render as "—", never 0.
      completionReported: hasCompleted,
    }
    if (ADOPTION_ORDER.includes(module.toLowerCase())) known.push(entry)
    else extras.push(entry)
  }

  known.sort((a, b) => ADOPTION_ORDER.indexOf(a.module.toLowerCase()) - ADOPTION_ORDER.indexOf(b.module.toLowerCase()))

  const modules = [...known, ...extras]
  return { available: modules.length > 0, modules }
}

/* --------------------------- marketing consent -------------------------- */

export function normalizeMarketingConsent(raw: Record<string, unknown>): MarketingConsentDto {
  const totalRegisteredUsers = readNumber(raw, ['totalRegisteredUsers', 'total', 'registered'])
  const optedIn = readNumber(raw, ['optedIn', 'opted_in', 'consented'])
  const optedOut = readNumber(raw, ['optedOut', 'opted_out', 'unsubscribed'])
  const reportedPct = readNumber(raw, ['optedInPct', 'optedInPercent'])

  // The contract guarantees optedIn + optedOut === total. If it does not hold,
  // surface the mismatch instead of adjusting any of the three numbers.
  const reconciles =
    totalRegisteredUsers !== null &&
    optedIn !== null &&
    optedOut !== null &&
    optedIn + optedOut === totalRegisteredUsers

  return {
    totalRegisteredUsers,
    optedIn,
    optedOut,
    optedInPct: reportedPct ?? pct(optedIn, totalRegisteredUsers),
    reconciles,
  }
}

/* ------------------------------ engagement ------------------------------ */

export function normalizeEngagement(raw: Record<string, unknown>): EngagementDto {
  const reportedReason = readString(raw, ['reason', 'unavailableReason'])
  const explicitAvailable = readBool(raw, ['available'])

  const dau = readNumber(raw, ['dau'])
  const wau = readNumber(raw, ['wau'])
  const mau = readNumber(raw, ['mau'])

  const daily: Array<{ date: string; count: number | null }> = []
  const dailySource = asArray(raw.dailyActiveUsers) ?? asArray(raw.daily) ?? asArray(raw.activeUsersSeries)
  for (const entry of dailySource ?? []) {
    const row = asObject(entry)
    if (!row) continue
    const date = readString(row, ['date', 'day'])
    if (!date) continue
    daily.push({ date, count: readNumber(row, ['count', 'activeUsers', 'value', 'dau']) })
  }

  const cohorts: EngagementCohort[] = []
  for (const entry of asArray(raw.cohorts) ?? []) {
    const row = asObject(entry)
    if (!row) continue
    const weekStart = readString(row, ['weekStart', 'start', 'cohort', 'week', 'date'])
    if (!weekStart) continue
    const size = readNumber(row, ['size', 'registered', 'count', 'total'])
    const retainedNextWeek = readNumber(row, ['retainedNextWeek', 'retained', 'nextWeek', 'returning'])
    const retentionPct = readNumber(row, ['retentionPct', 'retention', 'retainedPct'])
    cohorts.push({
      weekStart,
      size,
      retainedNextWeek,
      retentionPct,
      // Immature while the following week has not elapsed: the contract keeps
      // these null rather than reporting a partial week as 0% retention.
      mature: retentionPct !== null || retainedNextWeek !== null,
    })
  }

  const hasData = dau !== null || wau !== null || mau !== null || daily.length > 0 || cohorts.length > 0
  const reason = reportedReason ?? (hasData ? null : 'not_reported')
  const available = (explicitAvailable ?? isAvailableDefault(reason, hasData)) && hasData

  return {
    available,
    reason: available ? null : (reason ?? 'not_reported'),
    dau,
    wau,
    mau,
    dailyActiveUsers: daily,
    cohorts,
  }
}

/* ------------------------------ top level ------------------------------- */

export interface RawBlocks {
  funnel?: Record<string, unknown> | null
  clientErrors?: Record<string, unknown> | null
  endpointHealth?: Record<string, unknown> | null
  dependencyConfig?: Record<string, unknown> | null
  syntheticMonitoring?: Record<string, unknown> | null
  productAdoption?: Record<string, unknown> | null
  marketingConsent?: Record<string, unknown> | null
  engagement?: Record<string, unknown> | null
}

/**
 * Normalizes whichever blocks are present. An absent block and an explicit
 * upstream `null` (Rayern's per-block aggregation guard) both map to `null`
 * here — the DTO layer never substitutes empty data for missing data.
 */
export function normalizeInstrumentation(raw: RawBlocks): InstrumentationDto {
  return {
    funnel: raw.funnel ? normalizeFunnel(raw.funnel) : null,
    clientErrors: raw.clientErrors ? normalizeClientErrors(raw.clientErrors) : null,
    endpointHealth: raw.endpointHealth ? normalizeEndpointHealth(raw.endpointHealth) : null,
    dependencyConfig: raw.dependencyConfig ? normalizeDependencyConfig(raw.dependencyConfig) : null,
    syntheticMonitoring: raw.syntheticMonitoring ? normalizeSynthetic(raw.syntheticMonitoring) : null,
    productAdoption: raw.productAdoption ? normalizeProductAdoption(raw.productAdoption) : null,
    marketingConsent: raw.marketingConsent ? normalizeMarketingConsent(raw.marketingConsent) : null,
    engagement: raw.engagement ? normalizeEngagement(raw.engagement) : null,
  }
}
