import { describe, it, expect } from 'vitest'
import { formatPct } from '../lib/utils'

describe('formatPct', () => {
  it('returns an em dash for null', () => {
    expect(formatPct(null)).toBe('—')
  })

  it('returns an em dash for undefined', () => {
    expect(formatPct(undefined)).toBe('—')
  })

  it('formats zero without converting to a dash', () => {
    expect(formatPct(0, 2)).toBe('0.00%')
  })

  it('formats a valid numeric value', () => {
    expect(formatPct(99.98, 2)).toBe('99.98%')
  })
})