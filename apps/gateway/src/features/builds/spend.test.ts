import { describe, expect, it } from 'vitest'
import { BUILD_CAP_USD, createSpend, estimateOf, MAX_TOKENS, REHEARSAL_STEPS, TOKEN_BUDGET } from './spend.js'

const usage = (inputTokens: number, outputTokens: number, costUsd: number | null = null) => ({
  inputTokens,
  outputTokens,
  costUsd,
})

describe('the spend ledger', () => {
  it('counts what the provider reported over the list price, and the list price over nothing', () => {
    const spend = createSpend({ capUsd: 1, price: { input: 2, output: 10 }, tokenBudget: TOKEN_BUDGET })
    spend.add(usage(1000, 100, 0.25))
    spend.add(usage(1_000_000, 0))
    expect(spend.spent()).toEqual({ usd: 2.25, tokens: 1_001_100, modelCalls: 2, known: true })
  })

  it('refuses an ask when what is spent plus its list-price worst case would pass the cap', () => {
    // $1 a million both ways: 4,000 characters in and 1,000 tokens out at most is $0.002
    const spend = createSpend({ capUsd: 0.005, price: { input: 1, output: 1 }, tokenBudget: TOKEN_BUDGET })
    expect(spend.affords({ inputChars: 4000, maxTokens: 1000 })).toBe(true)
    spend.add(usage(1000, 1000))
    expect(spend.affords({ inputChars: 4000, maxTokens: 1000 })).toBe(true)
    spend.add(usage(1000, 1000))
    expect(spend.affords({ inputChars: 4000, maxTokens: 1000 })).toBe(false)
  })

  it('also holds every later ask to the dearest call seen, when the provider charges above list price', () => {
    const spend = createSpend({ capUsd: BUILD_CAP_USD, price: { input: 1, output: 1 }, tokenBudget: TOKEN_BUDGET })
    expect(spend.affords({ inputChars: 4000, maxTokens: MAX_TOKENS.kit })).toBe(true)
    spend.add(usage(1000, 1000, 0.4))
    expect(spend.affords({ inputChars: 4000, maxTokens: MAX_TOKENS.playbook })).toBe(true)
    spend.add(usage(1000, 1000, 0.4))
    // $0.80 spent, and the next could cost $0.40 again: over $1.00
    expect(spend.affords({ inputChars: 400, maxTokens: MAX_TOKENS.rehearse })).toBe(false)
    expect(spend.spent()).toMatchObject({ usd: 0.8, modelCalls: 2, known: true })
  })

  it('holds a build to the token budget while no price and no reported cost exists', () => {
    const spend = createSpend({ capUsd: 1, price: null, tokenBudget: 10_000 })
    expect(spend.affords({ inputChars: 20_000, maxTokens: 4000 })).toBe(true)
    spend.add(usage(5000, 3000))
    expect(spend.spent()).toEqual({ usd: 0, tokens: 8000, modelCalls: 1, known: false })
    expect(spend.affords({ inputChars: 4000, maxTokens: 1500 })).toBe(false)
    expect(spend.affords({ inputChars: 400, maxTokens: 400 })).toBe(true)
  })

  it('counts by money once the provider reports a cost, even without a list price', () => {
    const spend = createSpend({ capUsd: 1, price: null, tokenBudget: 10 })
    spend.add(usage(5000, 3000, 0.3))
    expect(spend.spent().known).toBe(true)
    expect(spend.affords({ inputChars: 400, maxTokens: 400 })).toBe(true)
    spend.add(usage(5000, 3000, 0.6))
    expect(spend.affords({ inputChars: 400, maxTokens: 400 })).toBe(false)
  })
})

describe('the estimate', () => {
  it('counts the kit, a playbook a task, the skill, one repair and half the rehearsal, without asking anything', () => {
    const one = estimateOf({ tasks: ['find a menu'], price: { input: 1, output: 1 } })
    const three = estimateOf({ tasks: ['find a menu', 'say it back', 'list notes'], price: { input: 1, output: 1 } })
    expect(one.modelCalls).toEqual({ likely: 1 + 1 + 1 + 1 + 3, max: 1 + 1 + 1 + 1 + REHEARSAL_STEPS })
    expect(three.modelCalls).toEqual({ likely: 4 + 2 + 9, max: 4 + 2 + 3 * REHEARSAL_STEPS })
    expect(three.tokens).toBeGreaterThan(one.tokens)
    expect(one.usd).toBeCloseTo(one.tokens / 1_000_000, 6)
    expect(one.usd).toBeLessThan(BUILD_CAP_USD)
  })

  it('has no figure in dollars without a price, and goes over the cap at a dear one', () => {
    expect(estimateOf({ tasks: ['find a menu'], price: null }).usd).toBeNull()
    expect(estimateOf({ tasks: ['find a menu'], price: { input: 500, output: 500 } }).usd).toBeGreaterThan(1)
  })
})
