import { describe, expect, it } from 'vitest'
import { type StatRow, statsOf } from './stats.js'

const now = new Date('2026-11-08T12:30:00Z')
const row = (createdAt: string, extra: Partial<StatRow> = {}): StatRow => ({
  status: 'ok',
  durationMs: 100,
  createdAt,
  tool: 'cookbook.research_recipes',
  clientId: 'cl_a',
  clientName: 'laptops',
  upstreamId: 'cookbook',
  ...extra,
})

describe('stats for the filter bar', () => {
  const rows = [
    row('2026-11-08T12:00:00Z', { durationMs: 300 }),
    row('2026-11-08T11:10:00Z', { status: 'failed', durationMs: 30000 }),
    row('2026-11-08T02:00:00Z', {
      tool: 'atlas.search_places',
      upstreamId: 'atlas',
      clientId: 'cl_b',
      clientName: 'design session',
    }),
    row('2026-11-07T10:00:00Z', { status: 'refused' }),
    row('2026-11-07T09:00:00Z'),
  ]
  const stats = statsOf(rows, { now, range: '24h' })

  it('splits this window from the one before', () => {
    expect(stats.tiles.now).toEqual({ calls: 3, problems: 1, medianMs: 200 })
    expect(stats.tiles.before).toEqual({ calls: 2, problems: 1, medianMs: 100 })
    expect(stats.since).toBe('2026-11-07T12:30:00.000Z')
  })

  it('buckets the window by hour with its errors', () => {
    expect(stats.series).toHaveLength(24)
    expect(stats.series.at(-1)).toEqual({ at: '2026-11-08T12', total: 1, errors: 0 })
    expect(stats.series.at(-2)).toEqual({ at: '2026-11-08T11', total: 1, errors: 1 })
  })

  it('ranks tools, agents and servers by calls, with their problems', () => {
    expect(stats.tools[0]).toEqual({ name: 'cookbook.research_recipes', calls: 2, problems: 1 })
    expect(stats.agents.map((agent) => agent.name)).toEqual(['laptops', 'design session'])
    expect(stats.upstreams[0]).toMatchObject({ id: 'cookbook', calls: 2, problems: 1, medianMs: 300 })
  })

  it('uses days for longer ranges', () => {
    expect(statsOf(rows, { now, range: '7d' }).series).toHaveLength(7)
    expect(statsOf(rows, { now, range: '30d' }).bucket).toBe('day')
  })
})
