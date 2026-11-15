import { describe, it, expect } from 'vitest'
import { formatPct, formatDuration } from '../lib/utils'

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

describe('formatDuration', () => {
  it('returns an em dash for null', () => {
    expect(formatDuration(null)).toBe('—')
  })

  it('rounds small millisecond values', () => {
    expect(formatDuration(369.416)).toBe('369ms')
  })

  it('formats large millisecond values in seconds', () => {
    expect(formatDuration(2573.673)).toBe('2.57s')
    expect(formatDuration(2784.262)).toBe('2.78s')
  })

  it('preserves zero', () => {
    expect(formatDuration(0)).toBe('0ms')
  })
})