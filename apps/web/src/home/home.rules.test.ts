import { describe, expect, it } from 'vitest'
import { barHeights, findabilityOf, routeOf } from './home.rules'

describe('home rules', () => {
  it('turns the API’s app hrefs into router paths', () => {
    expect(routeOf('/app/connections/new')).toBe('/connections/new')
    expect(routeOf('/app')).toBe('/')
    expect(routeOf('/app/tools?pinned=1')).toBe('/tools?pinned=1')
  })
  it('scales bars to the busiest hour and keeps small ones visible', () => {
    expect(barHeights([0, 1, 50, 100])).toEqual([0, 4, 50, 100])
    expect(barHeights([0, 0])).toEqual([0, 0])
  })
})

describe('findability', () => {
  it('says how often searches led to a call, or that none happened', () => {
    expect(findabilityOf({ searches: 14, found: 12, rate: 12 / 14 })).toEqual({
      headline: '86%',
      detail: '12 of 14 searches this week led to a call.',
    })
    expect(findabilityOf({ searches: 0, found: 0, rate: null }).headline).toBe('–')
  })
})
