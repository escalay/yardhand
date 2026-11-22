import { describe, expect, it } from 'vitest'
import { bucketsOf, nudgesOf, setupOf } from './rules.js'

const now = new Date('2026-11-08T12:30:00.000Z')

describe('setup', () => {
  it('starts at connect and ends complete', () => {
    const fresh = setupOf({ liveUpstreams: 0, ownerRunAt: null, keyClients: 0, agentCallAt: null, globalPins: 0 })
    expect(fresh).toMatchObject({ done: 0, total: 5, complete: false, next: 'connect' })
    const half = setupOf({ liveUpstreams: 2, ownerRunAt: 'x', keyClients: 0, agentCallAt: null, globalPins: 0 })
    expect(half.next).toBe('key')
    const all = setupOf({ liveUpstreams: 1, ownerRunAt: 'x', keyClients: 1, agentCallAt: 'y', globalPins: 3 })
    expect(all).toMatchObject({ done: 5, complete: true, next: null })
  })
})

describe('nudges', () => {
  it('puts reviews first, then failing servers, quiet keys and unused servers', () => {
    const nudges = nudgesOf({
      now,
      pendingReviews: 2,
      keyClients: [
        { id: 'cl_a', name: 'cursor', createdAt: '2026-11-05T12:00:00.000Z', lastCallAt: null },
        { id: 'cl_b', name: 'fresh', createdAt: '2026-11-08T12:00:00.000Z', lastCallAt: null },
        { id: 'cl_c', name: 'busy', createdAt: '2026-11-01T12:00:00.000Z', lastCallAt: '2026-11-08T11:00:00.000Z' },
      ],
      upstreams: [
        {
          id: 'home',
          title: 'Home',
          status: 'failing',
          lastError: 'fetch failed',
          createdAt: '2026-10-01T00:00:00Z',
          calls30d: 4,
        },
        { id: 'old', title: 'Old', status: 'live', lastError: null, createdAt: '2026-09-01T00:00:00Z', calls30d: 0 },
        { id: 'new', title: 'New', status: 'live', lastError: null, createdAt: '2026-11-07T00:00:00Z', calls30d: 0 },
      ],
    })
    expect(nudges.map((nudge) => nudge.kind)).toEqual(['reviews', 'failing_upstream', 'quiet_key', 'unused_upstream'])
    expect(nudges[0]?.message).toBe(
      '2 changes wait for your review. Agents keep the approved version until you decide.',
    )
    expect(nudges[2]?.message).toContain('cursor')
    expect(nudges[3]?.href).toBe('/app/connections/old')
  })

  it('says how many things in the packs to recheck, wording and values alike', () => {
    const facts = { now, pendingReviews: 0, keyClients: [], upstreams: [] }
    expect(nudgesOf({ ...facts, packFlags: 1 })).toEqual([
      {
        kind: 'pack_wording',
        message: '1 thing in your packs to recheck: its server changed the tool it was set up for.',
        action: 'Recheck',
        href: '/app/tools/reviews',
      },
    ])
    expect(nudgesOf({ ...facts, packFlags: 3 })[0]?.message).toBe(
      '3 things in your packs to recheck: their servers changed the tools they were set up for.',
    )
    expect(nudgesOf(facts)).toEqual([])
  })
})

describe('chart buckets', () => {
  it('zero-fills every hour and counts errors', () => {
    const buckets = bucketsOf(
      [
        { at: '2026-11-08T12', status: 'ok', count: 3 },
        { at: '2026-11-08T12', status: 'failed', count: 1 },
        { at: '2026-11-08T10', status: 'tool_error', count: 2 },
        { at: '2026-11-01T10', status: 'ok', count: 9 },
      ],
      { now, bucket: 'hour', size: 24 },
    )
    expect(buckets).toHaveLength(24)
    expect(buckets.at(-1)).toEqual({ at: '2026-11-08T12', total: 4, errors: 1 })
    expect(buckets.at(-3)).toEqual({ at: '2026-11-08T10', total: 2, errors: 2 })
    expect(buckets.reduce((sum, entry) => sum + entry.total, 0)).toBe(6)
  })

  it('nudges toward smart grouping for a big connection grouped by rules: set it up, else preview a regroup', () => {
    const base = { now: new Date('2026-11-08T12:00:00Z'), keyClients: [], upstreams: [], pendingReviews: 0 }
    const byRules = [
      { id: 'small', title: 'Small', tools: 7 },
      { id: 'big', title: 'Big', tools: 40 },
    ]
    expect(nudgesOf({ ...base, grouping: { ready: false, byRules } })).toEqual([
      expect.objectContaining({ kind: 'smart_grouping', action: 'Set up', href: '/app/settings' }),
    ])
    expect(nudgesOf({ ...base, grouping: { ready: true, byRules } })).toEqual([
      expect.objectContaining({ kind: 'smart_grouping', action: 'Preview', href: '/app/connections/big' }),
    ])
    expect(nudgesOf({ ...base, grouping: { ready: true, byRules: [byRules[0] as never] } })).toEqual([])
  })
})

describe('the nudge before access ends', () => {
  const sam = { id: 'cl_sam', name: 'Sam', pack: { name: 'loud', title: 'Loud' } }
  const facts = {
    now,
    pendingReviews: 0,
    keyClients: [{ id: 'cl_sam', name: 'Sam', createdAt: '2026-10-13T10:00:00.000Z', lastCallAt: null }],
    upstreams: [
      { id: 'home', title: 'Home', status: 'failing', lastError: null, createdAt: '2026-10-01T00:00:00Z', calls30d: 4 },
    ],
  }

  it('says whose access to which pack ends on which day, after failing servers and before quiet keys', () => {
    const nudges = nudgesOf({ ...facts, endingAccess: [{ ...sam, expiresAt: '2026-11-10T10:00:00.000Z' }] })
    expect(nudges.map((nudge) => nudge.kind)).toEqual(['failing_upstream', 'access_ending', 'quiet_key'])
    expect(nudges[1]).toEqual({
      kind: 'access_ending',
      message: "Sam's access to Loud ends in 2 days (10 Nov 2026). Extend it, or let it end.",
      action: 'Extend',
      href: '/app/packs/loud?tab=people',
    })
    expect(nudgesOf(facts).map((nudge) => nudge.kind)).toEqual(['failing_upstream', 'quiet_key'])
  })

  it('counts UTC days, as the day beside the word is the UTC day', () => {
    const messageFor = (expiresAt: string) =>
      nudgesOf({ ...facts, keyClients: [], upstreams: [], endingAccess: [{ ...sam, expiresAt }] })[0]?.message
    // 11 hours from now, then 12 hours from now but past midnight
    expect(messageFor('2026-11-08T23:30:00.000Z')).toBe(
      "Sam's access to Loud ends today (8 Nov 2026). Extend it, or let it end.",
    )
    expect(messageFor('2026-11-09T00:30:00.000Z')).toBe(
      "Sam's access to Loud ends tomorrow (9 Nov 2026). Extend it, or let it end.",
    )
    expect(messageFor('2026-11-11T12:00:00.000Z')).toBe(
      "Sam's access to Loud ends in 3 days (11 Nov 2026). Extend it, or let it end.",
    )
  })
})
