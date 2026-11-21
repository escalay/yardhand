import { describe, expect, it } from 'vitest'
import { dayOf, EXTEND_LIFETIMES, expiryOf, KEY_LIFETIMES } from './lifetimes.js'

const HOUR = 3_600_000

describe('how long a key works', () => {
  const now = new Date('2026-11-21T10:00:00.000Z')
  const later = (ms: number) => new Date(now.getTime() + ms).toISOString()

  it('ends 8 hours, a day, a week or 30 days from now', () => {
    expect(KEY_LIFETIMES).toEqual(['8h', '1d', '7d', '30d', 'never'])
    expect(expiryOf('8h', now)).toBe(later(8 * HOUR))
    expect(expiryOf('1d', now)).toBe(later(24 * HOUR))
    expect(expiryOf('7d', now)).toBe(later(7 * 24 * HOUR))
    expect(expiryOf('30d', now)).toBe('2026-12-21T10:00:00.000Z')
  })

  it('never ends when told so, or when nothing is said', () => {
    expect(expiryOf('never', now)).toBeNull()
    expect(expiryOf(undefined, now)).toBeNull()
  })

  it('is extended by a week, 30 days or for good, never by a day or less', () => {
    expect(EXTEND_LIFETIMES).toEqual(['7d', '30d', 'never'])
  })
})

describe('the day an access ended', () => {
  it('is the UTC day, written the same on every runtime', () => {
    expect(dayOf('2026-12-21T23:30:00.000Z')).toBe('21 Dec 2026')
    expect(dayOf('2026-01-03T00:00:00.000Z')).toBe('3 Jan 2026')
  })
})
