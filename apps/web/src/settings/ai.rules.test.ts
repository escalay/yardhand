import { describe, expect, it } from 'vitest'
import { contextLine, ownConnectionUnreachable, priceLine, sourceLabel, vectorsLine } from './ai.rules'

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

  it('says when Build with AI has a connection of its own it can’t reach a model with', () => {
    const job = (provider: string, baseUrl: string, key: string, ready = false, value = 'openrouter') =>
      ({
        ready,
        provider: { from: provider, value },
        baseUrl: { from: baseUrl },
        key: { from: key, set: key !== 'default' },
      }) as never
    // Smart grouping's connection whole: nothing of its own to fix here
    expect(ownConnectionUnreachable(job('grouping', 'grouping', 'grouping'))).toBe(false)
    expect(ownConnectionUnreachable(job('default', 'default', 'default'))).toBe(false)
    // Any of the three set: all three are its own, and grouping's key is never sent there
    expect(ownConnectionUnreachable(job('settings', 'default', 'default'))).toBe(true)
    expect(ownConnectionUnreachable(job('default', 'env', 'default'))).toBe(true)
    expect(ownConnectionUnreachable(job('settings', 'settings', 'default', false, 'custom'))).toBe(true)
    expect(ownConnectionUnreachable(job('default', 'default', 'settings', true))).toBe(false)
  })

  it('says when tools have no vector, so search finds them by their words only, and when it tries again', () => {
    const now = Date.parse('2026-11-22T10:00:00.000Z')
    const vectors = (missing: number, failed: string | null, retryAt: string | null) => ({
      tools: 1488,
      missing,
      failed,
      retryAt,
    })
    expect(vectorsLine(null, now)).toBeNull()
    expect(vectorsLine(vectors(0, null, null), now)).toBeNull()
    expect(vectorsLine(vectors(12, 'OpenRouter 503: busy', '2026-11-22T10:05:00.000Z'), now)).toBe(
      '12 of 1,488 tools have no vector yet, so search finds them by their words only. The last refresh did not finish (OpenRouter 503: busy); it tries again in 5 min.',
    )
    expect(vectorsLine(vectors(1, null, null), now)).toBe(
      '1 of 1,488 tools has no vector yet, so search finds it by its words only. It gets one at the next refresh.',
    )
    expect(vectorsLine(vectors(0, 'the key’s spend cap was reached', '2026-11-22T12:00:00.000Z'), now)).toBe(
      'The last refresh did not finish (the key’s spend cap was reached); it tries again in 2 h.',
    )
  })
})
