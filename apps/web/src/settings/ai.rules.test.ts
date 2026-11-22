import { describe, expect, it } from 'vitest'
import { contextLine, groupingKeySentElsewhere, priceLine, sourceLabel } from './ai.rules'

describe('AI settings', () => {
  it('says a model’s price and size in words', () => {
    expect(priceLine({ price: { input: 0.3, output: 2.5 } })).toBe('$0.30 in · $2.50 out per M tokens')
    expect(priceLine({ price: null })).toBe('')
    expect(contextLine({ contextLength: 1_048_576 })).toBe('1M context')
    expect(contextLine({ contextLength: 128_000 })).toBe('128k context')
  })

  it('says where a setting comes from, smart grouping’s included', () => {
    expect(['settings', 'env', 'grouping', 'default'].map((from) => sourceLabel(from as never))).toEqual([
      'Set here',
      '.env',
      'Smart grouping',
      'Default',
    ])
  })

  it('warns when Build with AI runs elsewhere with smart grouping’s key', () => {
    const job = (provider: string, baseUrl: string, key: string) =>
      ({ provider: { from: provider }, baseUrl: { from: baseUrl }, key: { from: key, set: true } }) as never
    expect(groupingKeySentElsewhere(job('grouping', 'grouping', 'grouping'))).toBe(false)
    expect(groupingKeySentElsewhere(job('settings', 'default', 'grouping'))).toBe(true)
    expect(groupingKeySentElsewhere(job('grouping', 'env', 'grouping'))).toBe(true)
    expect(groupingKeySentElsewhere(job('settings', 'default', 'settings'))).toBe(false)
  })
})
