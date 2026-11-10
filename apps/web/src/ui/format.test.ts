import { describe, expect, it } from 'vitest'
import { ago, bytes, duration, plural } from './format'

const now = new Date('2026-11-08T12:00:00Z').getTime()

describe('format', () => {
  it('says how long ago in plain words', () => {
    expect(ago(null, now)).toBe('never')
    expect(ago('2026-11-08T11:59:30Z', now)).toBe('just now')
    expect(ago('2026-11-08T11:56:00Z', now)).toBe('4 min ago')
    expect(ago('2026-11-08T09:00:00Z', now)).toBe('3 h ago')
    expect(ago('2026-11-07T08:00:00Z', now)).toBe('yesterday')
    expect(ago('2026-11-03T12:00:00Z', now)).toBe('5 days ago')
  })
  it('keeps numbers short', () => {
    expect(duration(212)).toBe('212 ms')
    expect(duration(1400)).toBe('1.4 s')
    expect(duration(null)).toBe('–')
    expect(bytes(2048)).toBe('2 KB')
    expect(plural(1, 'tool')).toBe('1 tool')
    expect(plural(1200, 'call')).toBe('1,200 calls')
  })
})
