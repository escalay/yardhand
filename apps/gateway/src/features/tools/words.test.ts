import { describe, expect, it } from 'vitest'
import { ftsQuery } from './words.js'

describe('ftsQuery', () => {
  it('searches the words that name a job, not the question around them', () => {
    expect(ftsQuery('How do I cook rice for a crowd?')).toBe('"cook"* OR "rice"* OR "crowd"*')
    expect(ftsQuery('find quick dinner_recipes')).toBe('"find"* OR "quick"* OR "dinner_recipes"*')
  })

  it('leaves nothing to match when nothing names a job, so meaning search answers alone', () => {
    expect(ftsQuery('what is it about?')).toBe('')
  })
})
