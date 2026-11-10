import { describe, expect, it } from 'vitest'
import { contextLine, priceLine } from './ai.rules'

describe('AI settings', () => {
  it('says a model’s price and size in words', () => {
    expect(priceLine({ price: { input: 0.3, output: 2.5 } })).toBe('$0.30 in · $2.50 out per M tokens')
    expect(priceLine({ price: null })).toBe('')
    expect(contextLine({ contextLength: 1_048_576 })).toBe('1M context')
    expect(contextLine({ contextLength: 128_000 })).toBe('128k context')
  })
})
