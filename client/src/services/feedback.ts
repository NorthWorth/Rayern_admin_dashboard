import { apiRequest, buildQuery, HttpError, USE_DEMO_DATA } from '../lib/api'

/**
 * Feedback review queue — Rayern's admin feedback API through the dashboard
 * proxy (`server/src/routes/rayernAdmin.ts`). The browser never calls Rayern.
 *
 * Contract (verified against Rayern `adminRoutes.js` / `feedbackController.js`):
 *   GET   /api/v1/admin/feedback?page&limit&category&status&sort
 *   GET   /api/v1/admin/feedback/summary
 *   PATCH /api/v1/admin/feedback/:id  { status }
 *
 * The upstream API has no free-text search, so none is offered: a client-side
 * filter over one page would look like a catalogue search while hiding matches
 * on every other page.
 */

export const FEEDBACK_CATEGORIES = [
  'General feedback',
  'Feature request',
  'Bug report',
  'Something is confusing',
] as const

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
export type FeedbackStatus = 'open' | 'reviewed' | 'resolved'

export interface FeedbackRecord {
  id: string
  category: string
  message: string
  status: FeedbackStatus
  source: string | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  workspaceId: string | null
  /** Minimal submitting user projection: id + email only. */
  user: { id: string; email: string } | null
}

export interface FeedbackFilters {
  page?: number
  limit?: number
  category?: FeedbackCategory
  status?: FeedbackStatus
  sort?: `${'createdAt' | 'updatedAt'}:${'asc' | 'desc'}`
}

export interface FeedbackListPage {
  items: FeedbackRecord[]
  pagination: {
    page: number
    limit: number
    totalResults: number
    totalPages: number
    hasNextPage: boolean
  }
}

export interface FeedbackSummary {
  total: number
  byStatus: { open: number; reviewed: number; resolved: number }
  byCategory: Record<string, number>
  lastSubmittedAt: string | null
}

/** Upstream list payload as Rayern returns it. */
interface RawFeedbackPage {
  pagination: FeedbackListPage['pagination']
  feedback: FeedbackRecord[]
}

interface Envelope<T> {
  success?: boolean
  data?: T
  error?: { code?: string; message?: string }
}

/**
 * Unwraps Rayern's `{ success, data }` envelope and re-throws its error shape,
 * so a 503 "not configured" proxy answer surfaces as a real error instead of an
 * empty review queue.
 */
function unwrap<T>(body: unknown): T {
  const envelope = body as Envelope<T>
  if (envelope && typeof envelope === 'object' && envelope.success === false) {
    throw new HttpError(envelope.error?.message ?? 'Rayern rejected the feedback request', undefined, {
      code: envelope.error?.code,
    })
  }
  if (envelope && typeof envelope === 'object' && 'data' in envelope && envelope.data !== undefined) {
    return envelope.data
  }
  return body as T
}

function emptyPage(filters: FeedbackFilters): FeedbackListPage {
  return {
    items: [],
    pagination: { page: filters.page ?? 1, limit: filters.limit ?? 50, totalResults: 0, totalPages: 1, hasNextPage: false },
  }
}

export const feedbackService = {
  async list(filters: FeedbackFilters = {}): Promise<FeedbackListPage> {
    // Demo mode has no feedback source: return an empty queue rather than
    // inventing customer messages.
    if (USE_DEMO_DATA) return emptyPage(filters)

    const query = buildQuery({
      page: filters.page ?? 1,
      limit: filters.limit ?? 50,
      category: filters.category,
      status: filters.status,
      sort: filters.sort,
    })
    const data = unwrap<RawFeedbackPage>(await apiRequest<unknown>(`/api/v1/admin/feedback${query}`))
    return {
      items: Array.isArray(data?.feedback) ? data.feedback : [],
      pagination: data?.pagination ?? emptyPage(filters).pagination,
    }
  },

  async summary(): Promise<FeedbackSummary> {
    if (USE_DEMO_DATA) {
      return { total: 0, byStatus: { open: 0, reviewed: 0, resolved: 0 }, byCategory: {}, lastSubmittedAt: null }
    }
    const data = unwrap<FeedbackSummary>(await apiRequest<unknown>('/api/v1/admin/feedback/summary'))
    return {
      total: data?.total ?? 0,
      byStatus: {
        open: data?.byStatus?.open ?? 0,
        reviewed: data?.byStatus?.reviewed ?? 0,
        resolved: data?.byStatus?.resolved ?? 0,
      },
      byCategory: data?.byCategory ?? {},
      lastSubmittedAt: data?.lastSubmittedAt ?? null,
    }
  },

  /** The only supported mutation: open → reviewed → resolved (and back). */
  async updateStatus(id: string, status: FeedbackStatus): Promise<FeedbackRecord> {
    const data = unwrap<{ feedback: FeedbackRecord }>(
      await apiRequest<unknown>(`/api/v1/admin/feedback/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status },
      }),
    )
    return data.feedback
  },
} as const
