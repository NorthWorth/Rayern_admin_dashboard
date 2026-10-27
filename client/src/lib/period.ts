/**
 * Reporting-period math over the daily registration trend.
 *
 * Boundaries: UTC calendar days (the backend buckets registrations by
 * `created_at::date` in UTC). Comparisons use the equivalent preceding window
 * and are reported as `null` when the trend does not cover that window — a
 * missing baseline is never rendered as 0 % or as a fabricated comparison.
 */

export interface DayCount {
  date: string
  count: number
}

export interface PeriodSummary {
  /** Registrations inside the requested window. */
  total: number
  /** Registrations in the equivalent preceding window (null = no coverage). */
  previousTotal: number | null
  /** How many days of the requested window the trend actually covers. */
  coverageDays: number
  /** True when the trend covers every day of the requested window. */
  complete: boolean
  /** Absolute change plus percentage; null when no comparable baseline. */
  delta: { absolute: number; pct: number | null } | null
  /** ISO date (YYYY-MM-DD) of the last day with data. */
  lastDate: string | null
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function shiftDays(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Sums a daily series over the last `days` days ending on the series' most
 * recent date, and compares it with the preceding window.
 */
export function summariseTrend(trend: DayCount[], days: number): PeriodSummary {
  const byDate = new Map<string, number>()
  for (const t of trend) {
    const key = dayKey(t.date)
    byDate.set(key, (byDate.get(key) ?? 0) + t.count)
  }

  const lastDate = trend.length > 0 ? dayKey(trend[trend.length - 1].date) : null
  if (lastDate === null) {
    return { total: 0, previousTotal: null, coverageDays: 0, complete: false, delta: null, lastDate: null }
  }

  let total = 0
  let coverageDays = 0
  for (let i = 0; i < days; i++) {
    const key = shiftDays(lastDate, -i)
    const value = byDate.get(key)
    if (value !== undefined) {
      total += value
      coverageDays++
    }
  }

  let previousTotal: number | null = null
  let previousCoverage = 0
  for (let i = days; i < days * 2; i++) {
    const key = shiftDays(lastDate, -i)
    const value = byDate.get(key)
    if (value !== undefined) {
      previousTotal = (previousTotal ?? 0) + value
      previousCoverage++
    }
  }
  // No coverage of the preceding window → no comparison at all.
  if (previousCoverage === 0) previousTotal = null

  const complete = coverageDays === days
  const comparable = previousTotal !== null && previousCoverage >= Math.min(days, coverageDays)

  return {
    total,
    previousTotal,
    coverageDays,
    complete,
    delta: comparable
      ? {
          absolute: total - (previousTotal as number),
          // A zero baseline makes a percentage change undefined.
          pct: (previousTotal as number) > 0 ? ((total - (previousTotal as number)) / (previousTotal as number)) * 100 : null,
        }
      : null,
    lastDate,
  }
}

/** Groups a daily series into ISO weeks (Mon–Sun) for coarser trend views. */
export function groupByWeek(trend: DayCount[]): DayCount[] {
  const out: DayCount[] = []
  let currentWeek: string | null = null
  let sum = 0
  for (const t of trend) {
    const d = new Date(`${dayKey(t.date)}T00:00:00Z`)
    const dow = (d.getUTCDay() + 6) % 7 // 0 = Monday
    d.setUTCDate(d.getUTCDate() - dow)
    const week = d.toISOString().slice(0, 10)
    if (currentWeek === null || week !== currentWeek) {
      if (currentWeek !== null) out.push({ date: currentWeek, count: sum })
      currentWeek = week
      sum = 0
    }
    sum += t.count
  }
  if (currentWeek !== null) out.push({ date: currentWeek, count: sum })
  return out
}

/** Groups a daily series into calendar months (UTC). */
export function groupByMonth(trend: DayCount[]): DayCount[] {
  const out: DayCount[] = []
  let currentMonth: string | null = null
  let sum = 0
  for (const t of trend) {
    const month = dayKey(t.date).slice(0, 7)
    if (currentMonth === null || month !== currentMonth) {
      if (currentMonth !== null) out.push({ date: `${currentMonth}-01`, count: sum })
      currentMonth = month
      sum = 0
    }
    sum += t.count
  }
  if (currentMonth !== null) out.push({ date: `${currentMonth}-01`, count: sum })
  return out
}

/** Fills missing days with zero between the first and last trend date. */
export function completeDailySeries(trend: DayCount[]): DayCount[] {
  if (trend.length === 0) return []
  const first = dayKey(trend[0].date)
  const last = dayKey(trend[trend.length - 1].date)
  const byDate = new Map(trend.map((t) => [dayKey(t.date), t.count]))
  const out: DayCount[] = []
  for (let key = first; key <= last; key = shiftDays(key, 1)) {
    out.push({ date: key, count: byDate.get(key) ?? 0 })
  }
  return out
}
