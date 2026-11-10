import { describe, expect, it } from 'vitest'
import { activeFilters, kindOf, matches, parseActivitySearch, statusOf } from './activity.rules'

describe('activity filters', () => {
  it('reads the address and drops what it can’t use', () => {
    expect(parseActivitySearch({ outcome: 'problems', upstream: ' cookbook ', via: 'mcp', junk: 1 })).toEqual({
      outcome: 'problems',
      upstream: 'cookbook',
      client: undefined,
      tool: undefined,
      via: 'mcp',
      call: undefined,
    })
    expect(parseActivitySearch({ outcome: 'weird', via: 'smoke' })).toMatchObject({ outcome: 'all', via: undefined })
  })
  it('maps outcomes to the API and to live calls', () => {
    expect(statusOf('problems')).toBe('tool_error,failed')
    expect(statusOf('all')).toBeUndefined()
    const call = { status: 'failed', upstream: 'home', clientId: 'cl_1', tool: 'home.set_light', via: 'mcp' }
    expect(matches(parseActivitySearch({ outcome: 'problems' }), call)).toBe(true)
    expect(matches(parseActivitySearch({ outcome: 'ok' }), call)).toBe(false)
    expect(matches(parseActivitySearch({ upstream: 'cookbook' }), call)).toBe(false)
    expect(activeFilters(parseActivitySearch({ outcome: 'problems', client: 'cl_1' }))).toBe(2)
  })
})

describe('kinds of call', () => {
  it('shows tool calls unless asked for reads or everything', () => {
    expect(kindOf(undefined)).toBe('tool')
    expect(kindOf('all')).toBeUndefined()
    expect(parseActivitySearch({ kind: 'manual' }).kind).toBe('manual')
    expect(parseActivitySearch({ kind: 'nope' }).kind).toBeUndefined()
    const read = { status: 'ok', upstream: 'cookbook', clientId: 'cl_1', tool: 'cookbook', via: 'mcp', kind: 'manual' }
    expect(matches({ outcome: 'all' }, read)).toBe(false)
    expect(matches({ outcome: 'all', kind: 'manual' }, read)).toBe(true)
    expect(matches({ outcome: 'all', kind: 'all' }, read)).toBe(true)
  })
})
