/**
 * The outbound wake request.
 *
 * Only the credential travels in the Authorization header; nothing about the
 * token is ever returned, logged or persisted. Response bodies are read up to a
 * small bound purely so a challenge/edge page can be recognised.
 */
import type { WakeFn, WakeResponse } from './scheduler.js'

const BODY_LIMIT = 4_096

export function createWakeFn(fetchImpl: typeof fetch = fetch): WakeFn {
  return async ({ endpoint, token, timeoutMs }): Promise<WakeResponse> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
        redirect: 'manual',
      })
      let bodyExcerpt: string | null = null
      try {
        const text = await res.text()
        bodyExcerpt = text ? text.slice(0, BODY_LIMIT) : null
      } catch {
        bodyExcerpt = null
      }
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyExcerpt,
        headers: res.headers,
        finalUrl: res.url || null,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
