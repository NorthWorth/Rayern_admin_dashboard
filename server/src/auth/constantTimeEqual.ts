import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison for shared secrets (service tokens, API keys).
 *
 * `a !== b` on strings returns as soon as it finds a differing character, which
 * leaks a timing signal an attacker can use to recover a token one byte at a
 * time. `crypto.timingSafeEqual` compares fixed-length buffers in constant
 * time, so token checks use it instead.
 *
 * Length is compared first (unavoidable: `timingSafeEqual` throws on a length
 * mismatch). The comparison is still performed on equal-length buffers so the
 * happy path and a same-length near-miss take the same time, and a differing
 * length performs one self-comparison rather than returning instantly, which
 * keeps the failure path uniformly expensive.
 */
export function constantTimeEqual(received: unknown, expected: unknown): boolean {
  if (typeof received !== 'string' || typeof expected !== 'string') return false

  const a = Buffer.from(received, 'utf8')
  const b = Buffer.from(expected, 'utf8')

  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }

  return timingSafeEqual(a, b)
}
