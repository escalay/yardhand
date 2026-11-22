import { describe, expect, it } from 'vitest'
import {
  dayOf,
  ENDED_KEPT_DAYS,
  ENDING_DAYS,
  EXTEND_LIFETIMES,
  expiryOf,
  KEY_LIFETIMES,
  standingOf,
} from './lifetimes.js'

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

describe('where a grant stands', () => {
  const now = new Date('2026-11-21T10:00:00.000Z')
  const DAY = 24 * HOUR
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString()
  /** A grant made `made` ago that ends `ends` from now (null for never). */
  const grant = (made: number, ends: number | null, revokedAt: string | null = null) => ({
    createdAt: at(-made),
    expiresAt: ends === null ? null : at(ends),
    revokedAt,
  })

  it('is ending in the last three days of a grant made for longer', () => {
    expect(ENDING_DAYS).toBe(3)
    expect(standingOf(grant(27 * DAY, 3 * DAY), now)).toBe('ending')
    expect(standingOf(grant(29 * DAY, HOUR), now)).toBe('ending')
    expect(standingOf(grant(5 * DAY, 2 * DAY), now)).toBe('ending')
    expect(standingOf(grant(27 * DAY, 3 * DAY + HOUR), now)).toBe('live')
  })

  it('is live with time left, without an end, and in the last hour of a grant made for a day or less', () => {
    expect(standingOf(grant(20 * DAY, 10 * DAY), now)).toBe('live')
    expect(standingOf(grant(400 * DAY, null), now)).toBe('live')
    expect(standingOf(grant(7 * HOUR, HOUR), now)).toBe('live')
    expect(standingOf(grant(23 * HOUR, HOUR), now)).toBe('live')
  })

  it('is not ending the moment the owner set it: a new week, or an old key just extended by one', () => {
    expect(standingOf(grant(0, 7 * DAY), now)).toBe('live')
    expect(standingOf(grant(90 * DAY, 7 * DAY), now)).toBe('live')
  })

  it('is ended for 30 days after its end, then gone', () => {
    expect(ENDED_KEPT_DAYS).toBe(30)
    expect(standingOf(grant(32 * DAY, -1000), now)).toBe('ended')
    expect(standingOf(grant(32 * DAY, -2 * DAY), now)).toBe('ended')
    expect(standingOf(grant(10 * DAY, -(9 * DAY + 16 * HOUR)), now)).toBe('ended')
    expect(standingOf(grant(60 * DAY, -30 * DAY), now)).toBe('ended')
    expect(standingOf(grant(61 * DAY, -31 * DAY), now)).toBe('gone')
  })

  it('is gone once revoked, whatever its end', () => {
    expect(standingOf(grant(5 * DAY, 25 * DAY, at(-HOUR)), now)).toBe('gone')
    expect(standingOf(grant(5 * DAY, null, at(-HOUR)), now)).toBe('gone')
    expect(standingOf(grant(32 * DAY, -2 * DAY, at(-HOUR)), now)).toBe('gone')
  })
})

describe('the day an access ended', () => {
  it('is the UTC day, written the same on every runtime', () => {
    expect(dayOf('2026-12-21T23:30:00.000Z')).toBe('21 Dec 2026')
    expect(dayOf('2026-01-03T00:00:00.000Z')).toBe('3 Jan 2026')
  })
})
