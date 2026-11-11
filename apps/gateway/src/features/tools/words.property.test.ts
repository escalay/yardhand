import { DatabaseSync } from 'node:sqlite'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ftsQuery } from './words.js'

describe('ftsQuery, for any text an agent sends', () => {
  const database = new DatabaseSync(':memory:')
  database.exec("CREATE VIRTUAL TABLE tools USING fts5(text); INSERT INTO tools VALUES ('find a quick dinner recipe')")
  const search = database.prepare('SELECT count(*) AS found FROM tools WHERE tools MATCH ?')

  it('is a query SQLite accepts, or empty', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        const query = ftsQuery(text)
        if (query) expect(() => search.get(query)).not.toThrow()
      }),
      { numRuns: 500 },
    )
  })

  it('carries no more than twelve words, none of them able to close its quotes', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        const words = ftsQuery(text).split(' OR ').filter(Boolean)
        expect(words.length).toBeLessThanOrEqual(12)
        for (const word of words) expect(word).toMatch(/^"[^"\s]+"\*$/)
      }),
    )
  })
})
