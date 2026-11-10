import { describe, expect, it } from 'vitest'
import { fuse } from './meaning.js'

describe('fuse', () => {
  it('ranks names found by both searches first, then the rest by their best rank', () => {
    expect(
      fuse(
        [
          ['a', 'b', 'c'],
          ['c', 'd', 'a'],
        ],
        10,
      ),
    ).toEqual(['a', 'c', 'b', 'd'])
    expect(fuse([['a'], []], 10)).toEqual(['a'])
    expect(fuse([['a', 'b', 'c']], 2)).toEqual(['a', 'b'])
  })
})
