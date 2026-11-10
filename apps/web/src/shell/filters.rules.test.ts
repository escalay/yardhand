import { describe, expect, it } from 'vitest'
import { changeOf, parseDoor, parseRange, percent, shareOf, sinceOf } from './filters.rules'

describe('filter bar', () => {
  it('reads ranges and doors from the address', () => {
    expect(parseRange('24h')).toBe('24h')
    expect(parseRange('1y', '7d')).toBe('7d')
    expect(parseDoor('mcp')).toBe('mcp')
    expect(parseDoor('ftp')).toBeUndefined()
  })

  it('starts a window that far back', () => {
    expect(sinceOf('24h', Date.parse('2026-11-08T12:00:00Z'))).toBe('2026-11-07T12:00:00.000Z')
    expect(sinceOf(undefined)).toBeUndefined()
  })

  it('says how a number changed and whether that is good', () => {
    expect(changeOf(120, 100)).toEqual({ text: '+20% vs before', tone: 'good' })
    expect(changeOf(5, 10, { lowerIsBetter: true })).toEqual({ text: '−50% vs before', tone: 'good' })
    expect(changeOf(0.04, 0.02, { lowerIsBetter: true, points: true })).toEqual({
      text: '+2 pts vs before',
      tone: 'bad',
    })
    expect(changeOf(3, 0)).toEqual({ text: 'none the window before', tone: 'neutral' })
    expect(changeOf(4, 4).tone).toBe('neutral')
    expect(changeOf(null, 4).text).toBe('nothing to compare')
  })

  it('shows shares as percentages', () => {
    expect(percent(shareOf(1, 4))).toBe('25%')
    expect(percent(shareOf(1, 0))).toBe('–')
  })
})

describe('the scope', () => {
  it('stays only while its pack exists and its agent can still call', async () => {
    const { scopeStillValid } = await import('./scope')
    const live = { packs: ['design'], agents: ['cl_a'] }
    expect(scopeStillValid({ kind: 'all' }, live)).toBe(true)
    expect(scopeStillValid({ kind: 'pack', name: 'design', title: 'Design' }, live)).toBe(true)
    expect(scopeStillValid({ kind: 'pack', name: 'gone', title: 'Gone' }, live)).toBe(false)
    expect(scopeStillValid({ kind: 'agent', id: 'cl_expired', name: 'session' }, live)).toBe(false)
  })
})
